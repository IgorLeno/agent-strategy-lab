/**
 * Criação do clone descartável em que o agente trabalha.
 *
 * O clone é INDEPENDENTE do repo-alvo — objects próprios, sem alternates, sem
 * remote nenhum. Um linked worktree (`git worktree add`) seria mais barato e
 * está proibido de propósito: ele compartilha `.git` com o repositório do
 * usuário, e o agente que roda lá dentro alcança objects, refs, config, hooks e
 * credencial de todo mundo. O que sustenta o experimento é o contrário disso —
 * o agente só pode ver a árvore do base SHA e só pode estragar o descartável.
 *
 * O repo-alvo é somente lido: `cat-file` para conferir o commit e o
 * `upload-pack` que serve o fetch. Nenhum comando daqui escreve nele.
 *
 * Em vez de `git clone <path>`, que copia objects por hardlink e deixa um
 * `origin` apontando de volta para o repo-alvo, o clone é montado com
 * `init` + `fetch` do commit exato: o pack chega inteiro e nenhum remote é
 * criado. O fetch por SHA também alcança um base SHA que não é ponta de ref
 * nenhuma, que `git clone` sozinho não traria.
 */

import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Prefixo do diretório temporário do clone — identifica o dono do lixo em `/tmp`. */
export const CLONE_DIRECTORY_PREFIX = 'agentlab-clone-';

/**
 * Branch criada no base SHA. Existe uma branch em vez de HEAD destacada porque
 * o agente roda `git status` e `git commit` no workspace, e HEAD destacada faz
 * parte das ferramentas avisar ou recusar.
 */
export const WORKSPACE_BRANCH = 'agent-workspace';

/** sha1 (40) ou sha256 (64), sempre completo e minúsculo. */
const FULL_SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const ALTERNATES_RELATIVE_PATH = path.join('objects', 'info', 'alternates');

export interface CreateDisposableCloneOptions {
  /** Repo-alvo. Só é lido — pode ser a raiz da working tree, um subdiretório ou um repo bare. */
  readonly sourceRepo: string;
  /**
   * Commit exato em que o clone é posto, completo. Abreviação é recusada: um
   * prefixo ambíguo escolheria o commit em silêncio, e o run inteiro é
   * atribuído a este SHA.
   */
  readonly baseSha: string;
  /** Diretório onde o clone é criado. Default: `os.tmpdir()`. */
  readonly parentDir?: string;
}

export interface DisposableClone {
  /** Raiz da working tree do clone — o cwd do agente. */
  readonly clonePath: string;
  /** `<clonePath>/.git`, sempre um diretório próprio. */
  readonly gitDir: string;
  /** Raiz do repo-alvo, resolvida. Guardada para a guarda de escrita de M19. */
  readonly sourceRepo: string;
  readonly baseSha: string;
  readonly branch: string;
}

/**
 * Cria o clone e devolve o que o run precisa para operá-lo e, depois, descartá-lo.
 *
 * Toda invariante do clone é conferida no disco antes do retorno, não presumida
 * do sucesso dos comandos: um clone que compartilhe objects ou herde remote
 * vaza o repositório do usuário para dentro do agente, e essa falha precisa
 * aparecer aqui e não no meio do run. Quando qualquer passo falha, o diretório
 * é removido — não existe clone meio criado sobrevivendo ao erro.
 */
export async function createDisposableClone(
  options: CreateDisposableCloneOptions,
): Promise<DisposableClone> {
  const baseSha = assertFullSha(options.baseSha);
  const sourceRepo = await resolveSourceRepo(options.sourceRepo);
  await assertCommitExists(sourceRepo, baseSha);
  const parentDir = await resolveParentDir(options.parentDir ?? os.tmpdir(), sourceRepo);

  const clonePath = await realpath(await mkdtemp(path.join(parentDir, CLONE_DIRECTORY_PREFIX)));
  try {
    await gitOrThrow(clonePath, ['init', '--quiet', `--initial-branch=${WORKSPACE_BRANCH}`]);
    // `allowAnySHA1InWant` vale para o `upload-pack` que este fetch dispara: é o
    // que permite pedir o commit pelo SHA em vez de por uma ref que pode não
    // existir. `--no-recurse-submodules` mantém a promessa de isolamento — um
    // submódulo seria buscado da URL registrada, que pode carregar credencial.
    await gitOrThrow(clonePath, [
      '-c',
      'uploadpack.allowAnySHA1InWant=true',
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-recurse-submodules',
      sourceRepo,
      baseSha,
    ]);
    await gitOrThrow(clonePath, ['reset', '--quiet', '--hard', baseSha]);

    const gitDir = await assertIndependentClone(clonePath, baseSha);
    return { clonePath, gitDir, sourceRepo, baseSha, branch: WORKSPACE_BRANCH };
  } catch (error) {
    await rm(clonePath, { recursive: true, force: true });
    throw error;
  }
}

function assertFullSha(baseSha: string): string {
  if (!FULL_SHA_PATTERN.test(baseSha)) {
    throw new TypeError(`baseSha deve ser um SHA de commit completo em hex minúsculo: ${baseSha}`);
  }
  return baseSha;
}

/**
 * Resolve o repo-alvo até a raiz que serve como URL do fetch e como fronteira
 * do repositório do usuário. Bare não tem working tree, então a própria git dir
 * é a raiz.
 */
async function resolveSourceRepo(sourceRepo: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(sourceRepo);
  } catch (error) {
    throw new Error(`repo-alvo não existe: ${sourceRepo}`, { cause: error });
  }

  const topLevel = await runGit(resolved, ['rev-parse', '--show-toplevel']);
  if (topLevel.exitCode === 0 && topLevel.stdout.trim() !== '') {
    return realpath(topLevel.stdout.trim());
  }

  const gitDir = await runGit(resolved, ['rev-parse', '--absolute-git-dir']);
  if (gitDir.exitCode !== 0 || gitDir.stdout.trim() === '') {
    throw new Error(`repo-alvo não é um repositório git: ${sourceRepo}`);
  }
  return realpath(gitDir.stdout.trim());
}

async function assertCommitExists(sourceRepo: string, baseSha: string): Promise<void> {
  const result = await runGit(sourceRepo, ['cat-file', '-e', `${baseSha}^{commit}`]);
  if (result.exitCode !== 0) {
    throw new Error(`base SHA não é um commit do repo-alvo: ${baseSha}`);
  }
}

/**
 * O clone nunca é criado dentro do repo-alvo: lá dentro ele seria material
 * escrito no repositório do usuário — exatamente o que o workspace efêmero
 * existe para evitar — e apareceria como lixo não rastreado na árvore dele.
 */
async function resolveParentDir(parentDir: string, sourceRepo: string): Promise<string> {
  const assertOutside = (resolved: string): void => {
    if (isInside(sourceRepo, resolved)) {
      throw new Error(`diretório do clone não pode ficar dentro do repo-alvo: ${parentDir}`);
    }
  };

  // Conferido antes de o diretório existir: o próprio `mkdir` já seria escrita
  // no repo-alvo. Conferido de novo depois, porque só aí o caminho inteiro tem
  // symlink resolvido e é esse valor que passa a ser usado.
  assertOutside(await resolveIntendedPath(parentDir));
  await mkdir(parentDir, { recursive: true });
  const resolved = await realpath(parentDir);
  assertOutside(resolved);
  return resolved;
}

/**
 * Resolve os symlinks do trecho que já existe e reanexa o resto. `realpath`
 * sozinho não serve aqui: o diretório ainda pode não ter sido criado, e é
 * justamente antes de criá-lo que a fronteira do repo-alvo precisa ser
 * conferida.
 */
async function resolveIntendedPath(target: string): Promise<string> {
  const absolute = path.resolve(target);
  const missing: string[] = [];
  let existing = absolute;

  while (!(await pathExists(existing))) {
    const parent = path.dirname(existing);
    if (parent === existing) return absolute;
    missing.unshift(path.basename(existing));
    existing = parent;
  }

  return path.join(await realpath(existing), ...missing);
}

/** Confere no disco tudo o que separa o clone do repo-alvo. Devolve a git dir conferida. */
async function assertIndependentClone(clonePath: string, baseSha: string): Promise<string> {
  const reported = await gitOrThrow(clonePath, ['rev-parse', '--absolute-git-dir']);
  const gitDir = await realpath(reported.trim());
  // Git dir fora da árvore do clone significa linked worktree, submódulo ou um
  // `GIT_DIR` que escapou do ambiente — nos três casos o agente estaria
  // operando dentro do `.git` de outro repositório.
  const expectedGitDir = path.join(clonePath, '.git');
  if (gitDir !== expectedGitDir) {
    throw new Error(`clone não tem git dir próprio: ${gitDir}`);
  }

  if (await pathExists(path.join(gitDir, ALTERNATES_RELATIVE_PATH))) {
    throw new Error('clone empresta objects de outro repositório via alternates');
  }

  const remotes = (await gitOrThrow(clonePath, ['remote'])).trim();
  if (remotes !== '') {
    throw new Error(`clone herdou remote: ${remotes.split('\n').join(', ')}`);
  }

  const head = (await gitOrThrow(clonePath, ['rev-parse', 'HEAD'])).trim();
  if (head !== baseSha) {
    throw new Error(`clone parou em ${head} em vez do base SHA ${baseSha}`);
  }

  return gitDir;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * true quando `child` é `parent` ou está abaixo dele. Ambos já resolvidos.
 *
 * Um nome que comece com `..` conta como fora e no máximo custa uma recusa a
 * mais — o erro que importa evitar é o contrário, aceitar como fora algo que
 * está dentro do repo-alvo.
 */
function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

interface GitResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Ambiente dos comandos git da criação.
 *
 * Toda variável `GIT_*` herdada é descartada: `GIT_DIR`, `GIT_WORK_TREE`,
 * `GIT_INDEX_FILE` ou `GIT_ALTERNATE_OBJECT_DIRECTORIES` vindas de quem chamou
 * apontariam estes comandos para outro repositório — inclusive para o do
 * usuário, que é justamente o que não pode ser escrito.
 *
 * Config global e de sistema são neutralizadas porque o clone não pode herdar
 * nada do usuário: `init.templateDir` instalaria hooks dele dentro do
 * workspace, e um credential helper ou `url.*.insteadOf` reintroduziria
 * credencial no repositório que deveria estar isolado.
 */
function cloneGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('GIT_')) env[name] = value;
  }
  env.GIT_CONFIG_GLOBAL = os.devNull;
  env.GIT_CONFIG_SYSTEM = os.devNull;
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

/** Sempre argv, nunca shell — nenhum caminho daqui interpola string em shell. */
function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cloneGitEnv(),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

async function gitOrThrow(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} falhou (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}
