import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { ExecutionStatus } from '../../src/core/index.js';
import { runExperimental } from '../../src/cli/run.js';
import type { Trial } from '../../src/schemas/index.js';
import { runAgentlabCli } from './helpers.js';

const execFileAsync = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_SYSTEM: os.devNull,
  GIT_TERMINAL_PROMPT: '0',
};

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-run-cli-test-'));
  temporaryRoots.push(root);
  return root;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd, env: GIT_ENV });
  return stdout;
}

interface SourceRepo {
  readonly repoPath: string;
  readonly baseSha: string;
}

async function sourceRepo(): Promise<SourceRepo> {
  const repoPath = path.join(await temporaryRoot(), 'target');
  await mkdir(repoPath, { recursive: true });
  await execFileAsync('git', ['init', '--quiet', '--initial-branch=main', repoPath], {
    env: GIT_ENV,
  });
  await git(repoPath, ['config', 'user.email', 'lab@example.com']);
  await git(repoPath, ['config', 'user.name', 'Lab']);
  await writeFile(path.join(repoPath, 'README.md'), 'base\n', 'utf8');
  await git(repoPath, ['add', '--', 'README.md']);
  await git(repoPath, ['commit', '--quiet', '-m', 'base']);

  return { repoPath, baseSha: (await git(repoPath, ['rev-parse', 'HEAD'])).trim() };
}

const budgets = {
  duration_ms: { expected: 120_000, maximum: 300_000 },
  tokens: { expected: 8_000, maximum: 20_000 },
  changed_files: { expected: 3, maximum: 6 },
};

function trial(cli: string, environment: Trial['environment'] = defaultEnvironment()): Trial {
  return {
    id: 'trial-add-retry',
    task: {
      id: 'add-retry-policy',
      description: 'Adicionar retentativas limitadas ao cliente HTTP.',
      visible_criteria: ['Retenta somente erros transitórios.'],
      task_class: 'feature',
      difficulty: 'medium',
      stack: ['typescript'],
      public_graders: ['typecheck'],
      budgets,
    },
    agent: {
      id: 'fake-agent-profile',
      cli,
      cli_version: '1.0.0',
      model: 'fake-model',
      flags: [],
    },
    strategy: {
      name: 'direct',
      version: 1,
      prompt: 'Implemente diretamente a tarefa fornecida e verifique o resultado.',
    },
    environment,
    status: 'PLANNED',
  };
}

function defaultEnvironment(): Trial['environment'] {
  return {
    id: 'controlled-clean-room',
    mode: 'controlled',
    env_allowlist: ['PATH', 'LANG'],
    home: 'sanitized',
    instruction_files: [],
    plugins: [],
    skills: [],
    mcp_servers: [],
  };
}

/**
 * `home: 'user'` evita a exigência de `sanitizedHome` de `buildInvocation` —
 * os testes de BLOCK da billing guard querem alcançar a decisão de
 * autorização, não a validação de HOME sanitizado de um adapter real.
 */
function realWorldEnvironment(): Trial['environment'] {
  return {
    id: 'real-world-unsandboxed',
    mode: 'real-world',
    env_allowlist: ['PATH', 'LANG', 'HOME'],
    home: 'user',
    uncontrolled: ['HOME real do operador'],
    instruction_files: [],
    plugins: [],
    skills: [],
    mcp_servers: [],
  };
}

async function writeInput(
  dir: string,
  source: SourceRepo,
  cli: string,
  environment: Trial['environment'] = defaultEnvironment(),
): Promise<string> {
  const inputPath = path.join(dir, 'run-input.json');
  await writeFile(
    inputPath,
    JSON.stringify({
      source_repo: source.repoPath,
      trial: trial(cli, environment),
      base_sha: source.baseSha,
      budgets,
      timeout_ms: 60_000,
    }),
    'utf8',
  );
  return inputPath;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('runExperimental', () => {
  it('prepara e executa um run fake de ponta a ponta (dry/fake path)', async () => {
    const source = await sourceRepo();
    const labRoot = await temporaryRoot();
    const parentDir = await temporaryRoot();
    const inputDir = await temporaryRoot();
    const inputPath = await writeInput(inputDir, source, 'fake');

    const result = await runExperimental({ input: inputPath, labRoot, parentDir });

    expect(result.executed.record.status).toBe(ExecutionStatus.COMPLETED);
    expect(result.executed.sealed.section).toBe('execution');
  });

  it('propaga BillingGuardBlockedError sem spawnar processo quando o adapter é REAL_INFERENCE sem evidência', async () => {
    const source = await sourceRepo();
    const labRoot = await temporaryRoot();
    const parentDir = await temporaryRoot();
    const inputDir = await temporaryRoot();
    const inputPath = await writeInput(inputDir, source, 'codex', realWorldEnvironment());

    await expect(runExperimental({ input: inputPath, labRoot, parentDir })).rejects.toThrow(
      /billing guard/,
    );
  });

  it('rejeita entrada inválida com mensagem clara', async () => {
    const inputDir = await temporaryRoot();
    const inputPath = path.join(inputDir, 'bad.json');
    await writeFile(inputPath, JSON.stringify({ trial: {} }), 'utf8');

    await expect(runExperimental({ input: inputPath })).rejects.toThrow(/entrada de run inválida/);
  });
});

describe('agentlab run (processo)', () => {
  it('sem --experimental, falha com exit code 1 e mensagem acionável', async () => {
    const result = await runAgentlabCli(['run', '--input', '/tmp/does-not-matter.json']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--experimental');
  });

  it('com --experimental mas sem --input, falha com exit code 1 e mensagem acionável', async () => {
    const result = await runAgentlabCli(['run', '--experimental']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--input');
  });

  it('smoke: roda um run fake e sai com exit code 0', async () => {
    const source = await sourceRepo();
    const labRoot = await temporaryRoot();
    const inputPath = await writeInput(labRoot, source, 'fake');

    const result = await runAgentlabCli(
      ['run', '--experimental', '--input', inputPath],
      { AGENTLAB_DATA_DIR: path.join(labRoot, 'data') },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/run_id=/);
    expect(result.stdout).toContain('status=COMPLETED');
  });

  it('BLOCK da billing guard sai com exit code 1 e mensagem sem spawnar agente real', async () => {
    const source = await sourceRepo();
    const labRoot = await temporaryRoot();
    const inputPath = await writeInput(labRoot, source, 'codex', realWorldEnvironment());

    const result = await runAgentlabCli(
      ['run', '--experimental', '--input', inputPath],
      { AGENTLAB_DATA_DIR: path.join(labRoot, 'data') },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/billing guard/);
  });
});
