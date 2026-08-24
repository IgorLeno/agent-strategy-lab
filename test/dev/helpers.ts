import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { API_CREDENTIAL_VARIABLES } from '../../dev/lib/billing.js';

export const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

export interface CliResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const TEST_PROCESS_PARENT_ALLOWLIST = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TERM',
  'USER',
  'SHELL',
  'CI',
] as const;

const API_CREDENTIAL_VARIABLE_SET = new Set(API_CREDENTIAL_VARIABLES);

/**
 * Ambiente mínimo e previsível para subprocessos da suíte. Variáveis do
 * protocolo e credenciais nunca atravessam a fronteira por herança; cenários
 * específicos ainda podem injetar valores falsos pelos overrides.
 */
export function buildTestProcessEnvironment(
  overrides: Readonly<Record<string, string>> = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {};
  for (const name of TEST_PROCESS_PARENT_ALLOWLIST) {
    if (name.startsWith('AGENTLAB_') || API_CREDENTIAL_VARIABLE_SET.has(name)) continue;
    const value = source[name];
    if (value !== undefined) inherited[name] = value;
  }
  return { ...inherited, ...overrides };
}

/**
 * Roda um CLI do harness como processo real — testar via import esconderia
 * justamente o comportamento de processo que o protocolo depende.
 */
export function runDevCli(
  script: string,
  args: readonly string[],
  env: Record<string, string> = {},
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
  options: { readonly stdin?: string } = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(REPO_ROOT, 'dev', 'cli', script), ...args],
      {
        cwd: REPO_ROOT,
        env: buildTestProcessEnvironment(env, sourceEnvironment),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    child.stdin.end(options.stdin ?? '');
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

export async function makeTempDevDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'agentlab-dev-'));
}

const SANDBOX_PLAN = `
schema_version: 1
tasks:
  - id: T1
    title: primeira tarefa
    objective: criar src/one.txt
    initial_files: [README.md]
    acceptance: ['arquivo criado']
    validation:
      - argv: ['true']
        timeout_seconds: 30
  - id: T2
    title: segunda tarefa
    blocked_by: [T1]
    include_previous_handoff: true
    objective: criar src/two.txt
    acceptance: ['arquivo criado']
    validation:
      - argv: ['true']
        timeout_seconds: 30
`;

export interface Sandbox {
  readonly root: string;
  readonly devDir: string;
}

/**
 * Repo git descartável com plano próprio — o harness é exercitado contra um
 * repo real, não contra mocks de git.
 */
export async function makeSandboxRepo(plan: string = SANDBOX_PLAN): Promise<Sandbox> {
  const root = await mkdtemp(path.join(tmpdir(), 'agentlab-sandbox-'));
  await mkdir(path.join(root, 'dev', 'profiles'), { recursive: true });
  await mkdir(path.join(root, 'fixtures'), { recursive: true });
  await writeFile(path.join(root, 'dev', 'plan.yaml'), plan, 'utf8');
  // O sandbox recebe cópias reais do fixture e do perfil — o teste exercita os
  // mesmos arquivos que o harness usa, não versões paralelas.
  await copyFile(
    path.join(REPO_ROOT, 'fixtures', 'fake-worker.mjs'),
    path.join(root, 'fixtures', 'fake-worker.mjs'),
  );
  await copyFile(
    path.join(REPO_ROOT, 'dev', 'profiles', 'fake-worker-v1.yaml'),
    path.join(root, 'dev', 'profiles', 'fake-worker-v1.yaml'),
  );
  await writeFile(path.join(root, 'README.md'), '# sandbox\n', 'utf8');
  await writeFile(path.join(root, '.gitignore'), '.dev/\n.dev-inbox/\n', 'utf8');

  await runGit(root, ['init', '-q', '-b', 'main']);
  await runGit(root, ['config', 'user.email', 'harness@example.invalid']);
  await runGit(root, ['config', 'user.name', 'Harness Test']);
  await runGit(root, ['add', '-A']);
  await runGit(root, ['commit', '-q', '-m', 'base']);

  return { root, devDir: path.join(root, '.dev') };
}

export function runGit(cwd: string, args: readonly string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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

/** Commit de conveniência para simular o trabalho do worker. */
export async function commitAll(cwd: string, message: string): Promise<string> {
  await runGit(cwd, ['add', '-A']);
  await runGit(cwd, ['commit', '-q', '-m', message]);
  return (await runGit(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
}
