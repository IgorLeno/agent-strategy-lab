import { randomUUID } from 'node:crypto';
import { readFile, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { writeFileOnce } from './atomic.js';
import { canonicalJson, sha256Hex } from './canonical.js';
import {
  applyPreservedPatch,
  currentFileContent,
  pathsPresentIn,
  removeFilesFromIndex,
  restoreFilesFrom,
  scopedPatch,
  treeEntries,
  treeNameStatus,
  workingTreeFiles,
  writeScopedTree,
} from './git.js';
import type { HarnessPaths } from './paths.js';
import {
  preservedBundleManifestPath,
  preservedBundlePatchPath,
  readPreservedBundleManifest,
  writePreservedBundleManifest,
} from './records.js';
import {
  DEV_SCHEMA_VERSION,
  PreservedChangeBundleManifest,
  type PreservedChangeBundleRef,
  type PreservedChangeFile,
  type PreservedChangeStatus,
} from './schemas.js';

/**
 * Preservação da solução REJEITADA de um attempt, para que ela continue
 * auditável depois que a working tree for limpa para o próximo attempt.
 *
 * `src/workspace/change-bundle.ts` responde à mesma pergunta, mas não serve
 * aqui e reutilizá-lo seria acoplamento errado em duas direções: ele opera
 * sobre um `DisposableClone` (que não existe no harness) e recusa por projeto
 * escrever a evidência dentro do repo-alvo — que é exatamente onde `.dev` fica.
 * Além disso o harness (`dev/`) nunca importou de `src/`: fazer o runtime do
 * orquestrador depender do código do produto que ele mesmo avalia inverteria a
 * fronteira. O que se reaproveita é a FORMA do artifact — patch reaplicável
 * mais manifesto de status/conteúdo —, não a implementação.
 */

export class FailedAttemptBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FailedAttemptBundleError';
  }
}

const STATUS_BY_CODE: Readonly<Record<string, PreservedChangeStatus>> = {
  A: 'added',
  C: 'copied',
  D: 'deleted',
  M: 'modified',
  R: 'renamed',
  T: 'type_changed',
};

export interface PreserveFailedAttemptBundleInput {
  readonly paths: HarnessPaths;
  readonly taskId: string;
  readonly attempt: number;
  readonly baseSha: string;
  readonly files: readonly string[];
  readonly patchFingerprint: string;
  readonly now?: () => string;
}

export interface PreservedBundle {
  readonly manifest: PreservedChangeBundleManifest;
  readonly ref: PreservedChangeBundleRef;
  readonly alreadyPreserved: boolean;
}

function relativeToDev(paths: HarnessPaths, file: string): string {
  return path.relative(paths.devDir, file).split(path.sep).join('/');
}

/**
 * Um caminho vindo de record só pode ser apagado se for relativo e não escapar
 * do repositório. O reset apaga arquivos — o menor descuido aqui sai do escopo
 * do patch e destrói trabalho alheio.
 */
export function assertRepoRelativePath(file: string): void {
  if (file === '' || path.isAbsolute(file) || file.startsWith('/')) {
    throw new FailedAttemptBundleError(`caminho não relativo ao repositório: ${file}`);
  }
  const normalized = path.normalize(file);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`) || normalized.includes('\0')) {
    throw new FailedAttemptBundleError(`caminho escapa do repositório: ${file}`);
  }
}

function refFrom(
  paths: HarnessPaths,
  manifest: PreservedChangeBundleManifest,
  manifestBytes: Buffer,
): PreservedChangeBundleRef {
  return {
    manifest_path: relativeToDev(
      paths,
      preservedBundleManifestPath(paths, manifest.task_id, manifest.attempt),
    ),
    manifest_sha256: sha256Hex(manifestBytes),
    patch_path: relativeToDev(
      paths,
      preservedBundlePatchPath(paths, manifest.task_id, manifest.attempt),
    ),
    patch_sha256: manifest.patch_sha256,
    patch_size_bytes: manifest.patch_size_bytes,
  };
}

/** Bytes exatos que `writeJsonOnce` publica — o hash do ref precisa bater com eles. */
function manifestBytes(manifest: PreservedChangeBundleManifest): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function describeFiles(
  repoRoot: string,
  baseSha: string,
  tree: string,
  files: readonly string[],
): Promise<PreservedChangeFile[]> {
  const entries = new Map((await treeEntries(repoRoot, tree, files)).map((e) => [e.path, e]));
  const described: PreservedChangeFile[] = [];
  for (const entry of await treeNameStatus(repoRoot, baseSha, tree, files)) {
    const status = STATUS_BY_CODE[entry.code.slice(0, 1)];
    if (status === undefined) {
      throw new FailedAttemptBundleError(`status desconhecido em git diff: ${entry.code}`);
    }
    if (status === 'deleted') {
      described.push({
        path: entry.path,
        status,
        old_path: null,
        mode: null,
        size_bytes: null,
        sha256: null,
      });
      continue;
    }
    const blob = entries.get(entry.path);
    if (blob === undefined) {
      throw new FailedAttemptBundleError(`arquivo alterado não está na árvore capturada: ${entry.path}`);
    }
    const content = await currentFileContent(repoRoot, entry.path);
    if (content === null) {
      throw new FailedAttemptBundleError(`arquivo sumiu durante a preservação: ${entry.path}`);
    }
    described.push({
      path: entry.path,
      status,
      old_path: entry.oldPath,
      mode: blob.mode,
      size_bytes: content.sizeBytes,
      sha256: content.sha256,
    });
  }
  return described.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/**
 * Publica patch e manifesto do attempt rejeitado. Append-only: repetir a
 * preservação com o mesmo material é aceito, com material diferente é recusado.
 */
export async function preserveFailedAttemptBundle(
  input: PreserveFailedAttemptBundleInput,
): Promise<PreservedBundle> {
  const { paths, taskId, attempt, baseSha } = input;
  const files = [...new Set(input.files)].sort();
  if (files.length === 0) throw new FailedAttemptBundleError('changed_files vazio');
  for (const file of files) assertRepoRelativePath(file);

  const existing = await readPreservedBundleManifest(paths, taskId, attempt);
  if (existing && existing.patch_fingerprint !== input.patchFingerprint) {
    throw new FailedAttemptBundleError(
      'bundle preservado diverge do patch atual — a solução arquivada não é esta',
    );
  }

  const indexFile = path.join(paths.devDir, `preserve-index-${process.pid}-${randomUUID()}`);
  let tree: string;
  let patch: string;
  let described: PreservedChangeFile[];
  try {
    tree = await writeScopedTree(paths.repoRoot, baseSha, files, indexFile);
    described = await describeFiles(paths.repoRoot, baseSha, tree, files);
    patch = await scopedPatch(paths.repoRoot, baseSha, tree, files);
  } finally {
    await rm(indexFile, { force: true });
  }

  // A árvore montada tem que cobrir exatamente o patch declarado: um arquivo
  // silenciosamente ignorado pelo .gitignore sairia do bundle sem nenhum sinal.
  const touched = new Set<string>();
  for (const file of described) {
    touched.add(file.path);
    if (file.old_path !== null) touched.add(file.old_path);
  }
  if (canonicalJson([...touched].sort()) !== canonicalJson(files)) {
    throw new FailedAttemptBundleError(
      `bundle cobre [${[...touched].sort().join(', ')}], changed_files declara [${files.join(', ')}]`,
    );
  }

  const patchBytes = Buffer.from(patch, 'utf8');
  const manifest = PreservedChangeBundleManifest.parse({
    schema_version: DEV_SCHEMA_VERSION,
    task_id: taskId,
    attempt,
    base_sha: baseSha,
    changed_files: files,
    files: described,
    patch_file: 'changes.patch',
    patch_sha256: sha256Hex(patchBytes),
    patch_size_bytes: patchBytes.byteLength,
    patch_fingerprint: input.patchFingerprint,
    captured_at: existing?.captured_at ?? (input.now ?? (() => new Date().toISOString()))(),
  });

  // O patch vem antes do manifesto: o manifesto aponta para ele por hash, e um
  // patch publicado depois nunca poderia ser conferido contra o manifesto.
  await writeFileOnce(preservedBundlePatchPath(paths, taskId, attempt), patchBytes);
  await writePreservedBundleManifest(paths, manifest);
  return {
    manifest,
    ref: refFrom(paths, manifest, manifestBytes(manifest)),
    alreadyPreserved: existing !== null,
  };
}

/**
 * Diretório que só existia por causa de um arquivo ADDED do worker não é um
 * path que o Git conheça: o reset path-scoped remove o arquivo e deixa a pasta
 * vazia para trás. `readdir` ainda a enxerga, e scaffold recém-criado passa a
 * parecer presente numa árvore git-limpa.
 */
export async function pruneEmptyParentDirectories(
  repoRoot: string,
  files: readonly string[],
): Promise<void> {
  const starts = [...new Set(files.map((file) => path.dirname(file)))]
    .filter((dir) => dir !== '.' && dir !== '')
    .sort((a, b) => b.length - a.length);
  for (const start of starts) {
    let current = start;
    while (current !== '.' && current !== '') {
      try {
        await rmdir(path.join(repoRoot, current));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          current = path.dirname(current);
          continue;
        }
        break;
      }
      current = path.dirname(current);
    }
  }
}

/**
 * Ref do bundle JÁ publicado, com os hashes lidos dos BYTES em disco.
 *
 * Recalcular o manifesto a partir do objeto reparseado poderia divergir dos
 * bytes gravados; a evidência é o arquivo, então é dele que o hash sai.
 */
export async function readPreservedBundleRef(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): Promise<PreservedChangeBundleRef | null> {
  const manifest = await readPreservedBundleManifest(paths, taskId, attempt);
  if (manifest === null) return null;
  const bytes = await readFile(preservedBundleManifestPath(paths, taskId, attempt));
  return refFrom(paths, manifest, bytes);
}

export interface RehydratePreservedBundleInput {
  readonly paths: HarnessPaths;
  readonly taskId: string;
  readonly attempt: number;
  /** Base sobre a qual o patch foi tirado E sobre a qual ele será reaplicado. */
  readonly baseSha: string;
}

export interface RehydratedBundle {
  readonly manifest: PreservedChangeBundleManifest;
  readonly ref: PreservedChangeBundleRef;
  readonly files: readonly string[];
}

/**
 * Desfaz uma reidratação, devolvendo EXATAMENTE `files` ao base.
 *
 * Não é `resetFilesToBase` cru: a poda de diretórios que só passaram a existir
 * por causa de um arquivo ADDED faz parte do desfazer. Sem ela o alvo fica
 * git-limpo mas com scaffold fantasma, e o próximo attempt enxerga estrutura
 * que o base não tem.
 */
export async function undoRehydration(
  repoRoot: string,
  baseSha: string,
  files: readonly string[],
): Promise<void> {
  const scope = [...new Set(files)].sort();
  if (scope.length === 0) return;
  await resetFilesToBase({ repoRoot, baseSha, files: scope });
  await pruneEmptyParentDirectories(repoRoot, scope);
}

/**
 * Devolve ao alvo o patch preservado de um attempt anterior — o inverso exato
 * de `resetFilesToBase`, com as mesmas garantias e a mesma paranoia.
 *
 * Determinismo é VERIFICADO, não presumido: depois de aplicar, a working tree
 * precisa conter exatamente os arquivos que o manifesto declara, com os hashes
 * que o manifesto declara. Reidratação parcial ou contaminada é recusada antes
 * de qualquer worker nascer — um alvo que ninguém consegue descrever é pior do
 * que um alvo vazio.
 *
 * Pré-condição: árvore limpa em `baseSha`. Quem chama já provou isso pela
 * guarda de base; aqui ela é reconferida porque aplicar patch sobre sujeira
 * alheia misturaria trabalho de origens diferentes sem deixar rastro.
 */
export async function rehydratePreservedBundle(
  input: RehydratePreservedBundleInput,
): Promise<RehydratedBundle> {
  const { paths, taskId, attempt, baseSha } = input;
  const manifest = await readPreservedBundleManifest(paths, taskId, attempt);
  if (manifest === null) {
    throw new FailedAttemptBundleError(`attempt ${attempt} de ${taskId} não tem bundle preservado`);
  }
  if (manifest.base_sha !== baseSha) {
    throw new FailedAttemptBundleError(
      `bundle do attempt ${attempt} foi tirado de ${manifest.base_sha}, e a base atual é ${baseSha}`,
    );
  }
  for (const file of manifest.changed_files) assertRepoRelativePath(file);

  const patchFile = preservedBundlePatchPath(paths, taskId, attempt);
  const patchBytes = await readFile(patchFile);
  if (sha256Hex(patchBytes) !== manifest.patch_sha256) {
    throw new FailedAttemptBundleError(`patch preservado do attempt ${attempt} foi alterado`);
  }
  if ((await workingTreeFiles(paths.repoRoot)).length > 0) {
    throw new FailedAttemptBundleError('reidratação exige working tree limpa na base do attempt');
  }

  await applyPreservedPatch(paths.repoRoot, patchFile);

  // Daqui em diante o alvo já está tocado, então TODA recusa desfaz o que
  // acabou de aplicar. Reidratação é preparação de continuação, e preparação
  // ou acontece inteira ou não acontece: uma árvore meio reidratada, que
  // ninguém consegue descrever, travaria o próximo resume por sujeira.
  try {
    // O que ficou no alvo tem que ser EXATAMENTE o que o manifesto descreve.
    const applied = await workingTreeFiles(paths.repoRoot);
    if (canonicalJson(applied) !== canonicalJson([...manifest.changed_files])) {
      throw new FailedAttemptBundleError(
        `reidratação produziu [${applied.join(', ')}], manifesto declara [${manifest.changed_files.join(', ')}]`,
      );
    }
    for (const file of manifest.files) {
      if (file.status === 'deleted') continue;
      const content = await currentFileContent(paths.repoRoot, file.path);
      if (content === null || content.sha256 !== file.sha256) {
        throw new FailedAttemptBundleError(
          `reidratação divergiu do manifesto em ${file.path}`,
        );
      }
    }
  } catch (error) {
    // O escopo do desfazer é a UNIÃO do que o manifesto declara com o que a
    // aplicação de fato deixou na árvore: a pré-condição provou a árvore limpa
    // logo acima, então tudo que está sujo agora veio deste `git apply`.
    await undoRehydration(paths.repoRoot, baseSha, [
      ...manifest.changed_files,
      ...(await workingTreeFiles(paths.repoRoot)),
    ]);
    throw error;
  }

  const manifestFile = preservedBundleManifestPath(paths, taskId, attempt);
  return {
    manifest,
    ref: refFrom(paths, manifest, await readFile(manifestFile)),
    files: manifest.changed_files,
  };
}

export interface ResetFilesToBaseInput {
  readonly repoRoot: string;
  readonly baseSha: string;
  readonly files: readonly string[];
}

export interface ResetOutcome {
  readonly restored: readonly string[];
  readonly removed: readonly string[];
}

/**
 * Devolve EXATAMENTE `files` ao conteúdo de `baseSha`. Nada de `reset --hard`
 * nem de `clean`: os dois agem sobre a árvore inteira, e trabalho fora do patch
 * da task — inclusive a própria manutenção do harness — não é deles para apagar.
 *
 * O que não existia no base é removido explicitamente, arquivo a arquivo: um
 * arquivo novo do worker não é "restaurável" para lugar nenhum.
 */
export async function resetFilesToBase(input: ResetFilesToBaseInput): Promise<ResetOutcome> {
  const files = [...new Set(input.files)].sort();
  if (files.length === 0) throw new FailedAttemptBundleError('reset sem changed_files');
  for (const file of files) assertRepoRelativePath(file);

  const inBase = await pathsPresentIn(input.repoRoot, input.baseSha, files);
  const restored = files.filter((file) => inBase.has(file));
  const removed = files.filter((file) => !inBase.has(file));

  if (restored.length > 0) await restoreFilesFrom(input.repoRoot, input.baseSha, restored);
  if (removed.length > 0) await removeFilesFromIndex(input.repoRoot, removed);
  for (const file of removed) {
    await rm(path.join(input.repoRoot, file), { force: true, recursive: false });
  }
  return { restored, removed };
}
