import { access, lstat, mkdir, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { humanInstructionBody } from '../../src/intake/index.js';
import { currentBranch, git, headSha, isWorkingTreeClean, repoTopLevel } from './git.js';
import {
  labArtifactPaths,
  loadAuthorizationSnapshot,
  loadHumanInstruction,
  loadPersistedIntake,
  resolveLabRunsRoot,
} from './lab-runtime.js';
import { assertControllerUnchanged, loadSelfTargetIdentity, resolveControlRepo } from './lab-self.js';
import { resolveHarnessInstallationRoot } from './paths.js';

export interface ProjectChoice {
  readonly root: string;
  readonly name: string;
  readonly branch: string | null;
  readonly clean: boolean;
  readonly remote: string | null;
}

export interface RecentRuntime {
  readonly runtimeDir: string;
  readonly target: ProjectChoice | { readonly type: 'self' };
  readonly updatedAtMs: number;
}

const GIT_IDENTITY_ERROR =
  'Não consigo criar um projeto novo porque Git ainda não tem user.name e user.email. Configure git config --global user.name e git config --global user.email e tente novamente.';

function expandLeadingHome(requestedPath: string): string {
  const home = process.env['HOME']?.trim() || homedir();
  if (requestedPath === '~') return home;
  if (requestedPath.startsWith('~/')) return path.join(home, requestedPath.slice(2));
  return requestedPath;
}

function remoteLabel(remoteUrl: string): string | null {
  const redacted = remoteUrl.trim().replace(/^[a-z][a-z0-9+.-]*:\/\/[^/@]*@/i, (prefix) => {
    const schemeEnd = prefix.indexOf('://') + 3;
    return prefix.slice(0, schemeEnd);
  });
  const sshPath = redacted.match(/^[^@\s]+@[^:\s]+:([^\s]+)$/)?.[1];
  let pathname = sshPath;
  if (pathname === undefined) {
    try {
      pathname = new URL(redacted).pathname;
    } catch {
      return null;
    }
  }
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts.at(-2)!;
  const repository = parts.at(-1)!.replace(/\.git$/, '');
  return owner.length > 0 && repository.length > 0 ? `${owner}/${repository}` : null;
}

async function originLabel(repoRoot: string, gitRunner: typeof git = git): Promise<string | null> {
  const result = await gitRunner(repoRoot, ['remote', 'get-url', 'origin']);
  return result.exitCode === 0 ? remoteLabel(result.stdout) : null;
}

async function projectChoice(repoRoot: string, gitRunner: typeof git = git): Promise<ProjectChoice> {
  const root = path.resolve(repoRoot);
  await headSha(root);
  return {
    root,
    name: path.basename(root),
    branch: await currentBranch(root),
    clean: await isWorkingTreeClean(root),
    remote: await originLabel(root, gitRunner),
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function loadResumableRuntime(runtimeDir: string, controlRoot: string): Promise<RecentRuntime> {
  const artifacts = labArtifactPaths(runtimeDir);
  const instruction = await loadHumanInstruction(artifacts.humanInstruction);
  const intake = await loadPersistedIntake(artifacts.intake);
  if (intake.user_request !== humanInstructionBody(instruction)) {
    throw new Error(`intake persistido diverge da HumanInstruction em ${runtimeDir}`);
  }
  const authorization = await loadAuthorizationSnapshot(artifacts.authorization);
  if (authorization.file.requested_scope.summary !== intake.requested_scope.summary) {
    throw new Error(`autorização persistida diverge do intake em ${runtimeDir}`);
  }
  const updatedAtMs = (await stat(runtimeDir)).mtimeMs;
  if (instruction.target.type === 'self') {
    const identity = await loadSelfTargetIdentity(artifacts.selfTarget);
    await assertControllerUnchanged(identity, controlRoot);
    return { runtimeDir, target: { type: 'self' }, updatedAtMs };
  }
  return {
    runtimeDir,
    target: await inspectWizardProject({ requestedPath: instruction.target.identity, controlRoot }),
    updatedAtMs,
  };
}

export async function inspectWizardProject(input: {
  readonly requestedPath: string;
  readonly controlRoot: string;
}): Promise<ProjectChoice> {
  const requestedPath = input.requestedPath.trim();
  const candidate = path.resolve(expandLeadingHome(requestedPath));
  if (!requestedPath || !(await exists(candidate))) {
    throw new Error(`Não encontrei o caminho informado: ${candidate}`);
  }

  let repoRoot: string;
  try {
    repoRoot = path.resolve(await repoTopLevel(candidate));
  } catch {
    throw new Error(`O caminho informado não pertence a um repositório Git: ${candidate}`);
  }

  let controlRepo: string;
  try {
    controlRepo = await resolveControlRepo(input.controlRoot);
  } catch {
    throw new Error('Não foi possível identificar o repositório de controle do Agent Lab.');
  }
  if (repoRoot === controlRepo) {
    throw new Error('O repositório alvo é o próprio Agent Lab. Escolha a opção de manutenção do Agent Lab.');
  }
  if (!(await isWorkingTreeClean(repoRoot))) {
    throw new Error(`O repositório possui alterações locais. Guarde ou descarte as alterações antes de continuar: ${repoRoot}`);
  }
  return projectChoice(repoRoot);
}

export async function listRecentRuntimes(input: {
  readonly controlRoot?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): Promise<readonly RecentRuntime[]> {
  const controlRoot = input.controlRoot ?? resolveHarnessInstallationRoot();
  const runsRoot = resolveLabRunsRoot({
    controlRoot,
    ...(input.env === undefined ? {} : { env: input.env }),
  });
  let targetGroups;
  try {
    targetGroups = await readdir(runsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const runtimes = await Promise.all(
    targetGroups.filter((entry) => entry.isDirectory()).flatMap(async (group) => {
      let children;
      try {
        children = await readdir(path.join(runsRoot, group.name), { withFileTypes: true });
      } catch {
        return [] as RecentRuntime[];
      }
      return Promise.all(
        children.filter((entry) => entry.isDirectory()).map(async (entry) => {
          const runtimeDir = path.join(runsRoot, group.name, entry.name);
          try {
            return await loadResumableRuntime(runtimeDir, controlRoot);
          } catch {
            return null;
          }
        }),
      );
    }),
  );
  return runtimes
    .flat()
    .filter((runtime): runtime is RecentRuntime => runtime !== null)
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}

function assertProjectName(name: string): string {
  const trimmed = name.trim();
  if (
    trimmed.length === 0 ||
    trimmed !== name ||
    trimmed === '.' ||
    trimmed === '..' ||
    path.basename(trimmed) !== trimmed ||
    trimmed.includes(path.sep) ||
    trimmed.includes('/') ||
    trimmed.includes('\\')
  ) {
    throw new Error('O nome do projeto deve ser um único segmento não vazio.');
  }
  return trimmed;
}

async function inheritedGitConfig(
  parentDirectory: string,
  key: 'user.name' | 'user.email',
  gitRunner: typeof git,
): Promise<string | null> {
  for (const scope of ['--global', '--system'] as const) {
    const result = await gitRunner(parentDirectory, ['config', scope, '--get', key]);
    if (result.exitCode === 0 && result.stdout.trim().length > 0) return result.stdout.trim();
  }
  return null;
}

export async function prepareNewProject(input: {
  readonly parentDirectory: string;
  readonly name: string;
  readonly remoteUrl?: string;
  readonly git?: typeof git;
}): Promise<ProjectChoice> {
  const name = assertProjectName(input.name);
  const parentDirectory = path.resolve(input.parentDirectory);
  let parent;
  try {
    parent = await lstat(parentDirectory);
  } catch {
    throw new Error(`O diretório pai não existe: ${parentDirectory}`);
  }
  if (!parent.isDirectory()) throw new Error(`O diretório pai não é um diretório: ${parentDirectory}`);

  const targetDirectory = path.join(parentDirectory, name);
  try {
    await lstat(targetDirectory);
    throw new Error(`O diretório do projeto já existe: ${targetDirectory}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const gitRunner = input.git ?? git;
  const [userName, userEmail] = await Promise.all([
    inheritedGitConfig(parentDirectory, 'user.name', gitRunner),
    inheritedGitConfig(parentDirectory, 'user.email', gitRunner),
  ]);
  if (userName === null || userEmail === null) {
    throw new Error(GIT_IDENTITY_ERROR);
  }

  await mkdir(targetDirectory);
  const initialized = await gitRunner(parentDirectory, ['init', '-b', 'main', targetDirectory]);
  if (initialized.exitCode !== 0) throw new Error(initialized.stderr.trim() || 'Não foi possível inicializar o repositório Git.');
  const committed = await gitRunner(targetDirectory, ['commit', '--allow-empty', '--quiet', '-m', 'Initial commit']);
  if (committed.exitCode !== 0) throw new Error(committed.stderr.trim() || 'Não foi possível criar o commit inicial.');
  const remoteUrl = input.remoteUrl?.trim();
  if (remoteUrl) {
    const remote = await gitRunner(targetDirectory, ['remote', 'add', 'origin', remoteUrl]);
    if (remote.exitCode !== 0) throw new Error(remote.stderr.trim() || 'Não foi possível configurar o remote local.');
  }
  return projectChoice(targetDirectory, gitRunner);
}
