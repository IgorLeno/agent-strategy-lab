import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { EvaluationOutcome } from '../../src/core/enums.js';
import { EvaluationRecord as EvaluationRecordSchema } from '../../src/schemas/index.js';
import type { EnvironmentProfile, EvaluationPlan } from '../../src/schemas/index.js';
import {
  createEvaluatorWorkspace,
  runEvaluation,
  EVALUATION_RECORD_FILE_NAME,
  GRADER_ARTIFACTS_DIR_NAME,
  type GraderSpec,
} from '../../src/evaluator/index.js';
import {
  captureChangeBundle,
  createDisposableClone,
  disposeClone,
  type DisposableClone,
} from '../../src/workspace/index.js';
import { createRunDirectory } from '../../src/storage/index.js';

const execFileAsync = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_SYSTEM: os.devNull,
  GIT_TERMINAL_PROMPT: '0',
};

const temporaryRoots: string[] = [];
const clones: DisposableClone[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-evaluate-test-'));
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

async function cloneOf(source: SourceRepo): Promise<DisposableClone> {
  const created = await createDisposableClone({
    sourceRepo: source.repoPath,
    baseSha: source.baseSha,
    parentDir: await temporaryRoot(),
  });
  clones.push(created);
  return created;
}

/** `changes.patch` de um workspace de agente com trabalho nele. */
async function agentPatch(source: SourceRepo): Promise<string> {
  const agentClone = await cloneOf(source);
  await writeFile(path.join(agentClone.clonePath, 'README.md'), 'base\nlinha do agente\n', 'utf8');
  const captured = await captureChangeBundle({
    clone: agentClone,
    outputDir: path.join(await temporaryRoot(), 'changes'),
  });
  return captured.patchPath;
}

const evaluationPlan: EvaluationPlan = {
  hidden_graders: ['patch-scope'],
  rubric: { 'patch-scope': 'o patch fica dentro do escopo esperado' },
  weights: { 'patch-scope': 1 },
};

const evaluatorEnvironment: EnvironmentProfile = {
  id: 'controlled-clean-room',
  mode: 'controlled',
  env_allowlist: ['PATH', 'LANG'],
  home: 'sanitized',
  instruction_files: [],
  plugins: [],
  skills: [],
  mcp_servers: [],
};

/** argv de um node inline — mesmo executável que roda os testes, sem depender de shell. */
function nodeArgv(source: string): string[] {
  return [process.execPath, '-e', source];
}

const PASS: GraderSpec = { argv: nodeArgv('process.exit(0)'), required: true, version: 'v1' };
const FAIL: GraderSpec = { argv: nodeArgv('process.exit(1)'), required: true, version: 'v1' };

afterEach(async () => {
  await Promise.all(clones.splice(0).map((created) => disposeClone(created)));
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function setup(): Promise<{
  runDir: string;
  workspace: Awaited<ReturnType<typeof createEvaluatorWorkspace>>;
}> {
  const source = await sourceRepo();
  const patchPath = await agentPatch(source);
  const workspace = await createEvaluatorWorkspace({
    sourceRepo: source.repoPath,
    baseSha: source.baseSha,
    parentDir: await temporaryRoot(),
    patchPath,
    evaluationPlan,
  });
  const run = await createRunDirectory({ labRoot: await temporaryRoot() });
  return { runDir: run.runDir, workspace };
}

describe('runEvaluation', () => {
  it('grader obrigatório falho força outcome FAIL', async () => {
    const { runDir, workspace } = await setup();
    try {
      const { record } = await runEvaluation({
        workspace,
        evaluationId: 'ev-1',
        runDir,
        executionManifestSha256: 'a'.repeat(64),
        evaluatorEnvironment,
        graders: { typecheck: FAIL, 'patch-scope': PASS },
      });

      expect(record.outcome).toBe(EvaluationOutcome.FAIL);
      expect(record.grader_results.typecheck).toEqual({
        outcome: EvaluationOutcome.FAIL,
        required: true,
      });
      expect(EvaluationRecordSchema.parse(record)).toEqual(record);
    } finally {
      await disposeClone(workspace.clone);
    }
  });

  it('grader opcional falho permite PARTIAL, registrado no grader_results', async () => {
    const { runDir, workspace } = await setup();
    try {
      const { record } = await runEvaluation({
        workspace,
        evaluationId: 'ev-1',
        runDir,
        executionManifestSha256: 'a'.repeat(64),
        evaluatorEnvironment,
        graders: {
          'patch-scope': PASS,
          lint: { ...FAIL, required: false },
        },
      });

      expect(record.outcome).toBe(EvaluationOutcome.PARTIAL);
      expect(record.grader_results.lint).toEqual({
        outcome: EvaluationOutcome.FAIL,
        required: false,
      });
      expect(EvaluationRecordSchema.parse(record)).toEqual(record);
    } finally {
      await disposeClone(workspace.clone);
    }
  });

  it('sem nenhuma falha, outcome é PASS', async () => {
    const { runDir, workspace } = await setup();
    try {
      const { record } = await runEvaluation({
        workspace,
        evaluationId: 'ev-1',
        runDir,
        executionManifestSha256: 'a'.repeat(64),
        evaluatorEnvironment,
        graders: { 'patch-scope': PASS },
      });

      expect(record.outcome).toBe(EvaluationOutcome.PASS);
    } finally {
      await disposeClone(workspace.clone);
    }
  });

  it('sela evaluations/<id>/ com manifest e record próprios', async () => {
    const { runDir, workspace } = await setup();
    try {
      const { sealed } = await runEvaluation({
        workspace,
        evaluationId: 'ev-1',
        runDir,
        executionManifestSha256: 'a'.repeat(64),
        evaluatorEnvironment,
        graders: { 'patch-scope': PASS },
      });

      expect(sealed.section).toBe('evaluations/ev-1');
      const sectionDir = path.join(runDir, 'evaluations', 'ev-1');
      const persisted = JSON.parse(
        await readFile(path.join(sectionDir, EVALUATION_RECORD_FILE_NAME), 'utf8'),
      );
      expect(persisted.evaluation_id).toBe('ev-1');
      expect(
        (await readdir(path.join(sectionDir, GRADER_ARTIFACTS_DIR_NAME))).sort(),
      ).toEqual(['patch-scope']);
    } finally {
      await disposeClone(workspace.clone);
    }
  });

  it('reavaliar cria evaluations/<novo-id>/ sem tocar na anterior', async () => {
    const { runDir, workspace } = await setup();
    try {
      const first = await runEvaluation({
        workspace,
        evaluationId: 'ev-1',
        runDir,
        executionManifestSha256: 'a'.repeat(64),
        evaluatorEnvironment,
        graders: { 'patch-scope': PASS },
      });
      const firstManifestBefore = await readFile(first.sealed.manifestPath, 'utf8');

      const second = await runEvaluation({
        workspace,
        evaluationId: 'ev-2',
        runDir,
        executionManifestSha256: 'a'.repeat(64),
        evaluatorEnvironment,
        graders: { 'patch-scope': FAIL },
      });

      expect(second.record.outcome).toBe(EvaluationOutcome.FAIL);
      expect(second.sealed.section).toBe('evaluations/ev-2');

      // A avaliação anterior continua byte a byte como estava.
      await expect(readFile(first.sealed.manifestPath, 'utf8')).resolves.toBe(
        firstManifestBefore,
      );
      const firstRecordAfter = JSON.parse(
        await readFile(
          path.join(runDir, 'evaluations', 'ev-1', EVALUATION_RECORD_FILE_NAME),
          'utf8',
        ),
      );
      expect(firstRecordAfter.outcome).toBe(EvaluationOutcome.PASS);

      expect((await readdir(path.join(runDir, 'evaluations'))).sort()).toEqual(['ev-1', 'ev-2']);
    } finally {
      await disposeClone(workspace.clone);
    }
  });
});
