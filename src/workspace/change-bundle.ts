/**
 * Captura do resultado do agente como change bundle.
 *
 * O clone morre no fim do run — o que sobrevive dele é este bundle. Ele precisa
 * responder duas perguntas depois que a árvore não existe mais: "o que o agente
 * mudou" (`changes-manifest.json`) e "como reconstruir a árvore dele"
 * (`changes.patch`, reaplicado pelo evaluator sobre o mesmo base SHA).
 *
 * O material capturado é a WORKING TREE final, não os commits do agente: a
 * estratégia pode commitar tudo, commitar nada ou deixar metade staged, e o que
 * será avaliado é o mesmo nos três casos. Por isso a captura monta um índice
 * próprio (`GIT_INDEX_FILE`) em vez de usar o do agente — `assume-unchanged`,
 * `skip-worktree` ou uma entrada staged desatualizada esconderiam material do
 * bundle sem nenhum sinal.
 *
 * O que o `.gitignore` exclui fica de fora, como ficaria de um commit: é a
 * única noção de material que o evaluator consegue reaplicar sobre o base SHA.
 *
 * `material_tree_sha256` é hash do conteúdo, e não o oid da árvore do git: ele
 * existe para dizer "estes dois runs produziram a mesma árvore" entre clones e
 * repositórios diferentes, e o oid amarraria essa resposta ao formato de objeto
 * de cada repo (sha1 ou sha256).
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Hash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { canonicalSha256 } from '../envelope/index.js';
import { assertWithinClone } from './cleanup.js';
import {
  cloneGitEnv,
  gitOrThrow,
  isInside,
  resolveIntendedPath,
  type DisposableClone,
} from './clone.js';

export const CHANGES_PATCH_FILE_NAME = 'changes.patch';
export const CHANGES_MANIFEST_FILE_NAME = 'changes-manifest.json';

/** Índice só da captura, dentro do clone descartável — some junto com ele. */
const CAPTURE_INDEX_FILE_NAME = 'agentlab-capture-index';

/** Modo de gitlink: repositório aninhado, cujo conteúdo não está no clone. */
const GITLINK_MODE = '160000';

/**
 * Argumentos que fixam o formato do patch.
 *
 * Explícitos porque o agente é dono do `.git/config` e do `.gitattributes` do
 * clone: `diff.noprefix`, um driver externo ou um `textconv` produziriam um
 * patch legível que não reaplica — falha que só apareceria no evaluator, com a
 * árvore do agente já descartada.
 */
const PATCH_ARGS = [
  '-c',
  'diff.noprefix=false',
  '-c',
  'diff.mnemonicPrefix=false',
  'diff',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--no-relative',
  '--binary',
  '--full-index',
  '--find-renames',
  '--unified=3',
] as const;

/** Como o arquivo chegou à árvore do agente, relativo ao base SHA. */
export type ChangeStatus = 'added' | 'copied' | 'deleted' | 'modified' | 'renamed' | 'type_changed';

const CHANGE_STATUS_BY_CODE: Readonly<Record<string, ChangeStatus>> = {
  A: 'added',
  C: 'copied',
  D: 'deleted',
  M: 'modified',
  R: 'renamed',
  T: 'type_changed',
};

export interface ChangedFile {
  /** Caminho relativo à raiz do clone; no rename, o caminho de destino. */
  readonly path: string;
  readonly status: ChangeStatus;
  /** Origem de um rename ou copy; null nos demais status. */
  readonly old_path: string | null;
  /** Modo git na árvore do agente (`100644`, `100755`, `120000`); null quando removido. */
  readonly mode: string | null;
  /** Tamanho e sha256 do conteúdo capturado; null quando removido. */
  readonly size_bytes: number | null;
  readonly sha256: string | null;
}

export interface ChangesManifest {
  readonly schema_version: 1;
  readonly base_sha: string;
  readonly captured_at: string;
  /** Identidade da árvore inteira do agente, não só do que mudou. */
  readonly material_tree_sha256: string;
  readonly patch_file: string;
  readonly patch_sha256: string;
  readonly patch_size_bytes: number;
  readonly files: readonly ChangedFile[];
}

export interface CaptureChangeBundleOptions {
  readonly clone: DisposableClone;
  /** Diretório de evidência do run — nunca dentro do repo-alvo nem do clone. */
  readonly outputDir: string;
  readonly now?: Date;
}

export interface ChangeBundle {
  readonly patchPath: string;
  readonly manifestPath: string;
  readonly manifest: ChangesManifest;
}

/**
 * Escreve `changes.patch` e `changes-manifest.json` em `outputDir` e devolve o
 * manifest já calculado.
 *
 * Os dois arquivos são criados com exclusividade: recapturar por cima
 * sobrescreveria a prova do que o agente produziu, que é o oposto do que o
 * bundle existe para fazer.
 */
export async function captureChangeBundle(
  options: CaptureChangeBundleOptions,
): Promise<ChangeBundle> {
  const { clone } = options;
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new RangeError('now deve ser uma data válida');
  }

  const outputDir = await resolveOutputDir(clone, options.outputDir);
  const tree = await writeMaterialTree(clone);
  const entries = await readTreeEntries(clone, tree);
  const blobs = await hashTreeBlobs(clone, entries);

  const patchPath = path.join(outputDir, CHANGES_PATCH_FILE_NAME);
  const patch = await writePatch(clone, tree, patchPath);

  const manifest: ChangesManifest = {
    schema_version: 1,
    base_sha: clone.baseSha,
    captured_at: now.toISOString(),
    material_tree_sha256: materialTreeSha256(entries, blobs),
    patch_file: CHANGES_PATCH_FILE_NAME,
    patch_sha256: patch.sha256,
    patch_size_bytes: patch.sizeBytes,
    files: await readChangedFiles(clone, tree, entries, blobs),
  };

  const manifestPath = path.join(outputDir, CHANGES_MANIFEST_FILE_NAME);
  try {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw new Error(`manifest do bundle já existe: ${manifestPath}`, { cause: error });
    }
    throw error;
  }

  return { patchPath, manifestPath, manifest };
}

/**
 * Confere onde a evidência pode cair antes de criar o diretório.
 *
 * Dentro do repo-alvo seria escrita no repositório do usuário — a mesma
 * fronteira que a guarda de M19 defende. Dentro do clone seria pior de um jeito
 * silencioso: o bundle é escrito, o run termina "bem" e o descarte do clone
 * leva a prova junto.
 */
async function resolveOutputDir(clone: DisposableClone, outputDir: string): Promise<string> {
  const sourceRepo = path.resolve(clone.sourceRepo);
  const clonePath = path.resolve(clone.clonePath);

  const assertOutside = (resolved: string): void => {
    if (isInside(sourceRepo, resolved)) {
      throw new Error(`bundle não pode ser escrito dentro do repo-alvo: ${outputDir}`);
    }
    if (isInside(clonePath, resolved)) {
      throw new Error(`bundle não pode ser escrito dentro do clone descartável: ${outputDir}`);
    }
  };

  // Conferido antes de o diretório existir, porque o próprio `mkdir` já seria a
  // escrita proibida; e de novo depois, quando o caminho inteiro tem symlink
  // resolvido e é esse valor que passa a ser usado.
  assertOutside(await resolveIntendedPath(outputDir));
  await mkdir(outputDir, { recursive: true });
  const resolved = await realpath(outputDir);
  assertOutside(resolved);
  return resolved;
}

/**
 * Congela a working tree do agente em um objeto de árvore e devolve o oid.
 *
 * O índice é próprio da captura e nasce vazio, então `add --all` descreve o
 * disco e nada além dele. O caminho passa pela guarda de escrita porque este é
 * o único arquivo que a captura cria dentro do workspace do agente.
 */
async function writeMaterialTree(clone: DisposableClone): Promise<string> {
  const indexFile = await assertWithinClone(clone, path.join(clone.gitDir, CAPTURE_INDEX_FILE_NAME));
  const env = { GIT_INDEX_FILE: indexFile };

  await gitOrThrow(clone.clonePath, ['add', '--all', '--', '.'], env);
  return (await gitOrThrow(clone.clonePath, ['write-tree'], env)).trim();
}

interface TreeEntry {
  readonly mode: string;
  readonly oid: string;
  readonly path: string;
}

/** Cada blob da árvore capturada, com modo e oid. Ordem vem ordenada do git. */
async function readTreeEntries(clone: DisposableClone, tree: string): Promise<TreeEntry[]> {
  const output = await gitOrThrow(clone.clonePath, ['ls-tree', '-r', '-z', '--full-tree', tree]);
  const entries: TreeEntry[] = [];

  for (const record of output.split('\0')) {
    if (record === '') continue;

    const separator = record.indexOf('\t');
    const header = separator === -1 ? [] : record.slice(0, separator).split(' ');
    const [mode, , oid] = header;
    if (mode === undefined || oid === undefined || header.length !== 3) {
      throw new Error(`entrada de git ls-tree em formato inesperado: ${record}`);
    }

    const entryPath = record.slice(separator + 1);
    // O conteúdo de um repositório aninhado não está no object store deste
    // clone: o bundle registraria um commit que ninguém consegue resolver e o
    // material dentro dele sumiria com o clone, sem aparecer em lugar nenhum.
    if (mode === GITLINK_MODE) {
      throw new Error(`repositório git aninhado não pode ser capturado: ${entryPath}`);
    }

    entries.push({ mode, oid, path: entryPath });
  }

  return entries;
}

interface BlobDigest {
  readonly sha256: string;
  readonly sizeBytes: number;
}

/**
 * sha256 e tamanho de cada blob da árvore, em um único `cat-file --batch`.
 *
 * O conteúdo é lido do object store e não do disco: é ele que o patch reaplica,
 * e ler pelo caminho seguiria um symlink para fora do clone em vez de registrar
 * o alvo do link. O hash é incremental — nenhum arquivo do agente é carregado
 * inteiro em memória.
 */
async function hashTreeBlobs(
  clone: DisposableClone,
  entries: readonly TreeEntry[],
): Promise<Map<string, BlobDigest>> {
  const digests = new Map<string, BlobDigest>();
  // Conteúdo repetido em caminhos diferentes é o mesmo oid, pedido uma vez só.
  const oids = [...new Set(entries.map((entry) => entry.oid))];
  if (oids.length === 0) return digests;

  const child = spawn('git', ['cat-file', '--batch'], {
    cwd: clone.clonePath,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: cloneGitEnv(),
  });

  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (exitCode) => resolve(exitCode));
  });

  // O git pode morrer antes de consumir a lista inteira; o EPIPE resultante não
  // é o erro que interessa reportar — o exit code e o stderr são.
  child.stdin.on('error', () => undefined);
  child.stdin.end(`${oids.join('\n')}\n`);

  const push = createBatchReader((oid, digest) => digests.set(oid, digest));
  try {
    for await (const chunk of child.stdout) push(chunk as Buffer);
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }

  const exitCode = await closed;
  if (exitCode !== 0) {
    throw new Error(`git cat-file --batch falhou (exit ${exitCode}): ${stderr.trim()}`);
  }
  if (digests.size !== oids.length) {
    throw new Error(
      `git cat-file --batch devolveu ${digests.size} objetos para ${oids.length} pedidos`,
    );
  }
  return digests;
}

/**
 * Leitor do fluxo de `cat-file --batch`: `<oid> <tipo> <tamanho>\n<conteúdo>\n`.
 *
 * O tamanho do cabeçalho é o que delimita o conteúdo — procurar o `\n` final
 * quebraria em qualquer arquivo binário. Devolve uma função que aceita os
 * chunks na ordem em que chegam.
 */
function createBatchReader(
  onObject: (oid: string, digest: BlobDigest) => void,
): (chunk: Buffer) => void {
  let pending: Buffer = Buffer.alloc(0);
  let body: { oid: string; size: number; read: number; hash: Hash } | null = null;
  let terminator = 0;

  return (chunk: Buffer): void => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);

    for (;;) {
      if (body === null) {
        if (terminator > 0) {
          const dropped = Math.min(terminator, pending.length);
          terminator -= dropped;
          pending = pending.subarray(dropped);
          if (terminator > 0) return;
        }

        const newline = pending.indexOf(0x0a);
        if (newline === -1) return;
        const header = pending.subarray(0, newline).toString('utf8');
        pending = pending.subarray(newline + 1);
        body = parseBatchHeader(header);
      }

      const taken = Math.min(body.size - body.read, pending.length);
      body.hash.update(pending.subarray(0, taken));
      body.read += taken;
      pending = pending.subarray(taken);
      if (body.read < body.size) return;

      onObject(body.oid, { sha256: body.hash.digest('hex'), sizeBytes: body.size });
      body = null;
      terminator = 1;
    }
  };
}

function parseBatchHeader(header: string): { oid: string; size: number; read: number; hash: Hash } {
  const [oid, type, size] = header.split(' ');
  if (oid === undefined || type !== 'blob' || size === undefined) {
    throw new Error(`git cat-file --batch não devolveu um blob: ${header}`);
  }

  const sizeBytes = Number.parseInt(size, 10);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error(`tamanho inválido em git cat-file --batch: ${header}`);
  }

  return { oid, size: sizeBytes, read: 0, hash: createHash('sha256') };
}

/**
 * Escreve o patch direto no disco, medindo e hasheando o que passa.
 *
 * O patch pode ser grande — a saída do agente não tem teto —, então ele nunca é
 * bufferizado inteiro: os bytes vão para o arquivo e para o sha256 no caminho.
 */
async function writePatch(
  clone: DisposableClone,
  tree: string,
  patchPath: string,
): Promise<BlobDigest> {
  const child = spawn('git', [...PATCH_ARGS, clone.baseSha, tree], {
    cwd: clone.clonePath,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: cloneGitEnv(),
  });

  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (exitCode) => resolve(exitCode));
  });

  const hash = createHash('sha256');
  let sizeBytes = 0;

  try {
    await pipeline(
      child.stdout,
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          hash.update(chunk);
          sizeBytes += chunk.byteLength;
          yield chunk;
        }
      },
      createWriteStream(patchPath, { flags: 'wx' }),
    );
  } catch (error) {
    child.kill('SIGKILL');
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw new Error(`patch do bundle já existe: ${patchPath}`, { cause: error });
    }
    throw error;
  }

  const exitCode = await closed;
  if (exitCode !== 0) {
    throw new Error(`git diff falhou (exit ${exitCode}): ${stderr.trim()}`);
  }
  return { sha256: hash.digest('hex'), sizeBytes };
}

/**
 * O que mudou entre o base SHA e a árvore do agente, com a mesma detecção de
 * rename usada no patch — manifest e patch precisam contar a mesma história.
 */
async function readChangedFiles(
  clone: DisposableClone,
  tree: string,
  entries: readonly TreeEntry[],
  blobs: ReadonlyMap<string, BlobDigest>,
): Promise<ChangedFile[]> {
  const output = await gitOrThrow(clone.clonePath, [
    'diff',
    '--name-status',
    '-z',
    '--find-renames',
    clone.baseSha,
    tree,
  ]);

  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const tokens = output.split('\0').filter((token) => token !== '');
  let cursor = 0;
  const next = (): string => {
    const token = tokens[cursor];
    if (token === undefined) {
      throw new Error('saída de git diff --name-status terminou no meio de uma entrada');
    }
    cursor += 1;
    return token;
  };

  const files: ChangedFile[] = [];
  while (cursor < tokens.length) {
    const code = next();
    const status = CHANGE_STATUS_BY_CODE[code.slice(0, 1)];
    if (status === undefined) {
      throw new Error(`status desconhecido em git diff --name-status: ${code}`);
    }

    // Rename e copy trazem origem e destino, nessa ordem; os demais, um caminho.
    const oldPath = status === 'renamed' || status === 'copied' ? next() : null;
    files.push(describeChangedFile(next(), status, oldPath, byPath, blobs));
  }

  return files.sort(compareByPath);
}

function describeChangedFile(
  filePath: string,
  status: ChangeStatus,
  oldPath: string | null,
  entries: ReadonlyMap<string, TreeEntry>,
  blobs: ReadonlyMap<string, BlobDigest>,
): ChangedFile {
  if (status === 'deleted') {
    return { path: filePath, status, old_path: oldPath, mode: null, size_bytes: null, sha256: null };
  }

  const entry = entries.get(filePath);
  if (entry === undefined) {
    throw new Error(`arquivo alterado não está na árvore capturada: ${filePath}`);
  }

  const digest = digestOf(entry, blobs);
  return {
    path: filePath,
    status,
    old_path: oldPath,
    mode: entry.mode,
    size_bytes: digest.sizeBytes,
    sha256: digest.sha256,
  };
}

/**
 * Identidade da árvore inteira do agente: caminho, modo e sha256 do conteúdo de
 * cada arquivo, em serialização canônica.
 *
 * Cobre a árvore toda, e não só o diff, porque é isso que ela responde — duas
 * árvores iguais têm o mesmo hash mesmo vindo de base SHAs ou de repositórios
 * diferentes. O modo entra porque bit de execução e symlink mudam o material
 * sem mudar um byte de conteúdo.
 */
function materialTreeSha256(
  entries: readonly TreeEntry[],
  blobs: ReadonlyMap<string, BlobDigest>,
): string {
  const material = entries
    .map((entry) => ({
      path: entry.path,
      mode: entry.mode,
      sha256: digestOf(entry, blobs).sha256,
    }))
    .sort(compareByPath);

  return canonicalSha256({ schema_version: 1, entries: material });
}

function digestOf(entry: TreeEntry, blobs: ReadonlyMap<string, BlobDigest>): BlobDigest {
  const digest = blobs.get(entry.oid);
  if (digest === undefined) {
    throw new Error(`conteúdo não foi lido para ${entry.path}`);
  }
  return digest;
}

function compareByPath(left: { path: string }, right: { path: string }): number {
  if (left.path === right.path) return 0;
  return left.path < right.path ? -1 : 1;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
