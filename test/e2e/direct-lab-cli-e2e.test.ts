import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveHarnessPaths } from '../../dev/lib/paths.js';
import { loadHumanInstruction } from '../../dev/lib/lab-runtime.js';
import { loadPlan } from '../../dev/lib/plan.js';
import { readState } from '../../dev/lib/state.js';
import { REPO_ROOT, runDevCli, runGit } from '../dev/helpers.js';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function externalProject(): Promise<{
  readonly root: string;
  readonly target: string;
  readonly runs: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-lab-e2e-'));
  created.push(root);
  const target = path.join(root, 'target');
  await mkdir(path.join(target, 'src'), { recursive: true });
  await writeFile(
    path.join(target, 'package.json'),
    JSON.stringify({
      name: 'lab-e2e-target',
      version: '1.0.0',
      private: true,
      scripts: { typecheck: 'true', test: 'true' },
    }),
    'utf8',
  );
  await writeFile(path.join(target, 'README.md'), '# target\n', 'utf8');
  await writeFile(path.join(target, '.gitignore'), '.dev/\n', 'utf8');
  await runGit(target, ['init', '-q', '-b', 'main']);
  await runGit(target, ['config', 'user.email', 'harness@example.invalid']);
  await runGit(target, ['config', 'user.name', 'Harness Test']);
  await runGit(target, ['add', '-A']);
  await runGit(target, ['commit', '-q', '-m', 'base']);
  return { root, target, runs: path.join(root, 'runs') };
}

function labEnv(runs: string): Record<string, string> {
  return {
    AGENTLAB_FAKE_MODE: 'orchestrator-success',
    AGENTLAB_RUNS_DIR: runs,
    AGENTLAB_DATA_DIR: path.join(path.dirname(runs), 'control-plane-data'),
  };
}

function runLab(args: readonly string[], env: Record<string, string>, stdin?: string) {
  return runDevCli('lab.ts', args, env, process.env, stdin === undefined ? {} : { stdin });
}

describe('pnpm lab — direct human instruction', () => {
  it('TEST 1 — stdin em projeto externo persiste instrução, deriva intake e inicia o ciclo', async () => {
    const fixture = await externalProject();
    const instruction = 'Create a small README note.';
    const first = await runLab(['--repo', fixture.target, '--max-iterations', '4'], labEnv(fixture.runs), instruction);
    expect(first.exitCode, first.stderr).toBe(0);
    expect(first.stderr).toMatch(/runtime: /);
    const output = JSON.parse(first.stdout) as {
      stopped_by: string;
      runtime_dir: string;
      human_instruction: string;
      generated_plan: { origin: string; file: string };
      observability: { instruction_source: string; target_type: string; policy_preset: string };
    };
    expect(output.stopped_by).toBe('ALL_DONE');
    expect(output.generated_plan.origin).toBe('GENERATED');
    expect(output.observability.instruction_source).toBe('stdin');
    expect(output.observability.target_type).toBe('external');
    expect(output.observability.policy_preset).toBe('local-autonomous-development-fake');

    const persisted = await loadHumanInstruction(output.human_instruction);
    expect(persisted.raw_instruction).toBe(instruction);

    const paths = resolveHarnessPaths(fixture.target, { planFile: output.generated_plan.file, devDir: output.runtime_dir });
    expect((await loadPlan(output.generated_plan.file)).plan.tasks.map((task) => task.id)).toEqual(['T1']);
    expect((await readState(paths)).tasks.map((task) => task.status)).toEqual(['PASS']);
  }, 60_000);

  it('TEST 2 — --prompt-file e TEST 3 — resume sem prompt novo', async () => {
    const fixture = await externalProject();
    const prompt = path.join(fixture.root, 'instruction.md');
    await writeFile(prompt, 'Create a small README note from a file.\n', 'utf8');
    const first = await runLab(
      ['--repo', fixture.target, '--prompt-file', prompt, '--max-iterations', '4'],
      labEnv(fixture.runs),
    );
    expect(first.exitCode, first.stderr).toBe(0);
    const output = JSON.parse(first.stdout) as {
      runtime_dir: string;
      generated_plan: { origin: string; file: string };
      observability: { instruction_source: string };
    };
    expect(output.observability.instruction_source).toBe('file');
    const planBefore = await readFile(output.generated_plan.file);

    const resumed = await runLab(['--resume', output.runtime_dir, '--max-iterations', '4'], labEnv(fixture.runs));
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    const resumedOutput = JSON.parse(resumed.stdout) as {
      stopped_by: string;
      resumed: boolean;
      generated_plan: { origin: string; file: string };
    };
    expect(resumedOutput.stopped_by).toBe('ALL_DONE');
    expect(resumedOutput.resumed).toBe(true);
    expect(resumedOutput.generated_plan.origin).toBe('REUSED');
    expect(await readFile(resumedOutput.generated_plan.file)).toEqual(planBefore);
  }, 60_000);

  it('TEST 4 — deploy em produção é HUMAN_REQUIRED genuíno', async () => {
    const fixture = await externalProject();
    const result = await runLab(
      ['--repo', fixture.target],
      labEnv(fixture.runs),
      'deploy this application to production',
    );
    expect(result.exitCode, result.stderr).toBe(9);
    const output = JSON.parse(result.stdout) as {
      status: string;
      decision_needed: string;
      why_automation_stopped: string;
      human_instruction: string;
    };
    expect(output.status).toBe('HUMAN_REQUIRED');
    expect(output.decision_needed).toBe('DEPLOYMENT_OR_PRODUCTION');
    expect(output.why_automation_stopped).toMatch(/não autoriza/);
    expect((await loadHumanInstruction(output.human_instruction)).raw_instruction).toBe(
      'deploy this application to production',
    );
    expect(result.stdout).not.toMatch(/generated_plan/);
  }, 30_000);
});

describe('pnpm lab --self', () => {
  it('TEST 5 — worktree isolado, control repo intacto durante a execução, FF no fim', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-self-e2e-'));
    created.push(root);
    const control = path.join(root, 'control');
    await mkdir(control, { recursive: true });
    await writeFile(path.join(control, 'README.md'), '# control\n', 'utf8');
    await writeFile(path.join(control, 'package.json'), JSON.stringify({ name: 'self-lab', scripts: { test: 'true' } }), 'utf8');
    await mkdir(path.join(control, 'dev', 'presets'), { recursive: true });
    await cp(
      path.join(REPO_ROOT, 'dev', 'presets', 'local-autonomous-development.yaml'),
      path.join(control, 'dev', 'presets', 'local-autonomous-development.yaml'),
    );
    await cp(
      path.join(REPO_ROOT, 'dev', 'presets', 'local-autonomous-development-fake.yaml'),
      path.join(control, 'dev', 'presets', 'local-autonomous-development-fake.yaml'),
    );
    await runGit(control, ['init', '-q', '-b', 'main']);
    await runGit(control, ['config', 'user.email', 'harness@example.invalid']);
    await runGit(control, ['config', 'user.name', 'Harness Test']);
    await runGit(control, ['add', '-A']);
    await runGit(control, ['commit', '-q', '-m', 'base']);
    const original = (await runGit(control, ['rev-parse', 'HEAD'])).stdout.trim();

    const result = await runLab(
      ['--self', '--max-iterations', '4'],
      {
        ...labEnv(path.join(root, 'runs')),
        AGENTLAB_CONTROL_ROOT: control,
      },
      'Update a documentation typo and validate it.',
    );
    expect(result.exitCode, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      stopped_by: string;
      observability: { target_type: string; controller_sha: string };
      self_maintenance: {
        isolated_worktree: string;
        branch: string;
        integration: string;
        publish: string;
      };
    };
    expect(output.stopped_by).toBe('ALL_DONE');
    expect(output.observability.target_type).toBe('self');
    expect(output.observability.controller_sha).toBe(original);
    expect(output.self_maintenance.branch).toMatch(/^agentlab\/self\//);
    expect(output.self_maintenance.integration).toBe('FAST_FORWARD');
    expect(output.self_maintenance.publish).toBe('PUSH_REQUIRED');
    expect(output.self_maintenance.isolated_worktree).not.toBe(control);

    const integrated = (await runGit(control, ['rev-parse', 'HEAD'])).stdout.trim();
    expect(integrated).not.toBe(original);
    expect((await runGit(control, ['merge-base', '--is-ancestor', original, integrated])).exitCode).toBe(0);
  }, 60_000);
});
