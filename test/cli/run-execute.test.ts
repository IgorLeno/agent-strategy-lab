import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { ExecutionStatus } from '../../src/core/index.js';
import { executionEnvelopeSha256 } from '../../src/envelope/index.js';
import {
  CHANGES_DIR_NAME,
  EVENTS_FILE_NAME,
  EXECUTION_RECORD_FILE_NAME,
  PROMPT_DIR_NAME,
  PROMPT_FILE_NAME,
  PROVIDER_SANITIZED_FILE_NAME,
  executeRun,
} from '../../src/cli/run-execute.js';
import { prepareRun } from '../../src/cli/run-prepare.js';
import { FAKE_ADAPTER_IDENTITY, FAKE_AGENT_VARIANT_ENV } from '../../src/adapters/index.js';
import { disposeClone } from '../../src/workspace/index.js';
import type { Trial } from '../../src/schemas/index.js';

const execFileAsync = promisify(execFile);


const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_SYSTEM: os.devNull,
  GIT_TERMINAL_PROMPT: '0',
};

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-run-execute-test-'));
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

function trial(): Trial {
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
      cli: 'fake',
      cli_version: '1.0.0',
      model: 'fake-model',
      flags: [],
    },
    strategy: {
      name: 'direct',
      version: 1,
      prompt: 'Implemente diretamente a tarefa fornecida e verifique o resultado.',
    },
    environment: {
      id: 'controlled-clean-room',
      mode: 'controlled',
      env_allowlist: ['PATH', 'LANG'],
      home: 'sanitized',
      instruction_files: [],
      plugins: [],
      skills: [],
      mcp_servers: [],
    },
    status: 'PLANNED',
  };
}

async function preparedFakeRun(source: SourceRepo, timeoutMs = 60_000) {
  return prepareRun({
    trial: trial(),
    baseSha: source.baseSha,
    budgets,
    timeoutMs,
    sourceRepo: source.repoPath,
    adapter: FAKE_ADAPTER_IDENTITY,
    labRoot: await temporaryRoot(),
    parentDir: await temporaryRoot(),
  });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('executeRun', () => {
  it('grava execution/ selado com todos os artifacts de um run fake bem-sucedido', async () => {
    const source = await sourceRepo();
    const prepared = await preparedFakeRun(source);

    try {
      const executed = await executeRun({ prepared });

      expect(executed.record.status).toBe(ExecutionStatus.COMPLETED);
      expect(executed.record.exit_code).toBe(0);
      expect(executed.record.execution_envelope_sha256).toBe(prepared.executionEnvelopeSha256);

      expect(executed.sealed.section).toBe('execution');
      const persistedManifest = JSON.parse(
        await readFile(executed.sealed.manifestPath, 'utf8'),
      ) as unknown;
      expect(persistedManifest).toEqual(executed.sealed.manifest);

      const artifactPaths = executed.sealed.manifest.artifacts.map((artifact) => artifact.path).sort();
      expect(artifactPaths).toEqual(
        [
          `${CHANGES_DIR_NAME}/changes-manifest.json`,
          `${CHANGES_DIR_NAME}/changes.patch`,
          EVENTS_FILE_NAME,
          'execution-envelope.json',
          EXECUTION_RECORD_FILE_NAME,
          `${PROMPT_DIR_NAME}/${PROMPT_FILE_NAME}`,
          PROVIDER_SANITIZED_FILE_NAME,
        ].sort(),
      );

      const persistedRecord = JSON.parse(
        await readFile(path.join(prepared.executionDir, EXECUTION_RECORD_FILE_NAME), 'utf8'),
      ) as unknown;
      expect(persistedRecord).toEqual(executed.record);

      const prompt = await readFile(
        path.join(prepared.executionDir, PROMPT_DIR_NAME, PROMPT_FILE_NAME),
        'utf8',
      );
      expect(prompt).toBe(prepared.envelopeManifest.compiled_prompt);
    } finally {
      await disposeClone(prepared.clone);
    }
  });

  it('o execution_envelope_sha256 gravado bate com o recalculado a partir do envelope', async () => {
    const source = await sourceRepo();
    const prepared = await preparedFakeRun(source);

    try {
      const executed = await executeRun({ prepared });

      const recalculated = executionEnvelopeSha256(prepared.envelopeManifest);
      expect(executed.record.execution_envelope_sha256).toBe(recalculated);
    } finally {
      await disposeClone(prepared.clone);
    }
  });

  it('provider-sanitized.jsonl existe e passou por redaction', async () => {
    const source = await sourceRepo();
    const prepared = await preparedFakeRun(source);

    try {
      await executeRun({
        prepared,
        env: { ...process.env, [FAKE_AGENT_VARIANT_ENV]: 'malformed-stream' },
      });

      const eventsContent = await readFile(
        path.join(prepared.executionDir, EVENTS_FILE_NAME),
        'utf8',
      );
      const sanitizedContent = await readFile(
        path.join(prepared.executionDir, PROVIDER_SANITIZED_FILE_NAME),
        'utf8',
      );

      // A linha malformada não derruba o run — vira evento `unknown`, presente
      // tanto em events.jsonl (produzido pelo adapter) quanto no stream do
      // provider, que passou pela redaction estrutural deste módulo.
      expect(eventsContent).toContain('"type":"unknown"');
      expect(sanitizedContent).toContain('"type":"unknown"');
    } finally {
      await disposeClone(prepared.clone);
    }
  });

  it('changes/ contém patch e manifest coerentes com o base SHA', async () => {
    const source = await sourceRepo();
    const prepared = await preparedFakeRun(source);

    try {
      const executed = await executeRun({ prepared });

      expect(executed.changeBundle.manifest.base_sha).toBe(source.baseSha);
      expect(executed.changeBundle.patchPath).toBe(
        path.join(prepared.executionDir, CHANGES_DIR_NAME, 'changes.patch'),
      );

      const changesDir = await readdir(path.join(prepared.executionDir, CHANGES_DIR_NAME));
      expect(changesDir.sort()).toEqual(['changes-manifest.json', 'changes.patch']);
    } finally {
      await disposeClone(prepared.clone);
    }
  });

  it('run fake que trava é TIMED_OUT e ainda assim sela execution/', async () => {
    const source = await sourceRepo();
    const prepared = await preparedFakeRun(source, 300);

    try {
      const executed = await executeRun({
        prepared,
        env: { ...process.env, [FAKE_AGENT_VARIANT_ENV]: 'timeout' },
        gracePeriodMs: 50,
      });

      expect(executed.record.status).toBe(ExecutionStatus.TIMED_OUT);
      expect(executed.sealed.section).toBe('execution');
    } finally {
      await disposeClone(prepared.clone);
    }
  }, 15_000);
});
