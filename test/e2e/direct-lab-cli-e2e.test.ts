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

function runDirective(input: { readonly header: string; readonly body: string }): string {
  return `---agentlab\nversion: 1\n${input.header}---\n${input.body}`;
}

describe('pnpm lab run — Run Directive', () => {
  it('A/B — `lab run` resolve alvo externo só da directive', async () => {
    const fixture = await externalProject();
    const raw = runDirective({
      header: `target:\n  type: repository\n  path: ${fixture.target}\nexecution:\n  mode: new\n`,
      body: '# Objective\n\nCreate a small README note.\n',
    });
    const first = await runLab(['run', '--max-iterations', '4'], labEnv(fixture.runs), raw);
    expect(first.exitCode, first.stderr).toBe(0);
    expect(first.stderr).toMatch(/Target: /);
    expect(first.stderr).toMatch(/Mode: new/);
    const output = JSON.parse(first.stdout) as {
      stopped_by: string;
      observability: { target_type: string; directive_format: string };
      human_instruction: string;
    };
    expect(output.stopped_by).toBe('ALL_DONE');
    expect(output.observability.target_type).toBe('external');
    expect(output.observability.directive_format).toBe('agentlab-v1');
    const persisted = await loadHumanInstruction(output.human_instruction);
    expect(persisted.instruction_body).toContain('Create a small README note.');
    expect(persisted.raw_instruction).toContain('---agentlab');
  }, 60_000);

  it('C/K — target.self isola o worktree e preserva o controller', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-self-dir-'));
    created.push(root);
    const control = path.join(root, 'control');
    await mkdir(control, { recursive: true });
    await writeFile(path.join(control, 'README.md'), '# control\n', 'utf8');
    await writeFile(
      path.join(control, 'package.json'),
      JSON.stringify({ name: 'self-lab', scripts: { test: 'true' } }),
      'utf8',
    );
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
      ['run', '--max-iterations', '4'],
      {
        ...labEnv(path.join(root, 'runs')),
        AGENTLAB_CONTROL_ROOT: control,
      },
      runDirective({
        header: 'target:\n  type: self\nexecution:\n  mode: new\n',
        body: 'Update a documentation typo and validate it.\n',
      }),
    );
    expect(result.exitCode, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      observability: { target_type: string; controller_sha: string };
      self_maintenance: { isolated_worktree: string; publish: string };
    };
    expect(output.observability.target_type).toBe('self');
    expect(output.observability.controller_sha).toBe(original);
    expect(output.self_maintenance.isolated_worktree).not.toBe(control);
    expect(output.self_maintenance.publish).toBe('PUSH_REQUIRED');
    expect((await runGit(control, ['rev-parse', 'HEAD'])).stdout.trim()).not.toBe(original);
  }, 60_000);

  it('F — publish estreito empurra origin/main; ausência de grant não dá push', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-self-pub-'));
    created.push(root);
    const control = path.join(root, 'control');
    const remote = path.join(root, 'remote.git');
    await mkdir(control, { recursive: true });
    await writeFile(path.join(control, 'README.md'), '# control\n', 'utf8');
    await writeFile(
      path.join(control, 'package.json'),
      JSON.stringify({ name: 'self-lab', scripts: { test: 'true' } }),
      'utf8',
    );
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
    await mkdir(remote, { recursive: true });
    await runGit(remote, ['init', '-q', '-b', 'main', '--bare']);
    await runGit(control, ['remote', 'add', 'origin', remote]);

    const result = await runLab(
      ['run', '--max-iterations', '4'],
      {
        ...labEnv(path.join(root, 'runs')),
        AGENTLAB_CONTROL_ROOT: control,
      },
      runDirective({
        header:
          'target:\n  type: self\nauthorization:\n  publish:\n    allowed: true\n    remote: origin\n    ref: main\n',
        body: 'Update a documentation typo and validate it.\n',
      }),
    );
    expect(result.exitCode, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      self_maintenance: { publish: string; remote: string };
    };
    expect(output.self_maintenance.publish).toBe('PUSHED');
    expect(output.self_maintenance.remote).toBe('origin');
    expect((await runGit(remote, ['rev-parse', 'refs/heads/main'])).exitCode).toBe(0);
  }, 60_000);

  it('H — header malformado: zero provider e mensagem de parse', async () => {
    const fixture = await externalProject();
    const result = await runLab(['run'], labEnv(fixture.runs), '---agentlab\nversion: 1\ntarget: [\n---\n# body\n');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/malformada|YAML/);
    expect(result.stdout).not.toMatch(/generated_plan/);
  }, 30_000);

  it('J — `pnpm lab` sem subcomando ainda aceita --repo legado', async () => {
    const fixture = await externalProject();
    const first = await runLab(
      ['--repo', fixture.target, '--max-iterations', '4'],
      labEnv(fixture.runs),
      'Create a small README note.',
    );
    expect(first.exitCode, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout).stopped_by).toBe('ALL_DONE');
  }, 60_000);
});

/**
 * ACCEPTANCE — uma Run Directive REALISTA e GRANDE atravessa o product path
 * inteiro pelo CLI real (parser real, autorização real, packet real,
 * normalização real de plano; só o PROVIDER é o worker falso determinístico).
 */
describe('pnpm lab run — Run Directive realista e grande', () => {
  function realisticDirective(target: string): { readonly raw: string; readonly body: string } {
    const section = [
      '## Contexto operacional',
      'O Agent Lab é control plane: orquestra, observa e valida — não micromanageia o worker.',
      'Evidence runtime anterior: data/project-runs/self/380e105e4468e4d5-facd91ca9a66.',
      'A validação oficial pertence ao orquestrador; o worker faz validação targeted.',
      '',
      '### Salvaguardas (proibições, não pedidos)',
      '- no force push;',
      '- não fazer ações destrutivas;',
      '- never use an API key;',
      '- do not deploy to production;',
      '- nunca apagar runtimes de evidência.',
      '',
      '```',
      'observed: worker_runtime_budget 1996000ms > profile bound 1800000ms',
      '```',
    ].join('\n');
    const lines = ['# Objective', '', 'Create a small README note documenting the control plane boundary.', ''];
    while (lines.join('\n').length < 12_000) lines.push(section, '');
    const body = lines.join('\n').trim();
    return {
      body,
      // Sem authorization.preset: o preset determinístico (fake) do ambiente de
      // teste continua valendo, então o E2E não gasta provider real.
      raw: runDirective({
        header: `target:\n  type: repository\n  path: ${target}\nexecution:\n  mode: new\n  autonomy: routine\n`,
        body: `${body}\n`,
      }),
    };
  }

  it('ACCEPTANCE — persiste, autoriza, planeja e persiste plano sem false gate, 4k rejection ou parse failure', async () => {
    const fixture = await externalProject();
    const { raw, body } = realisticDirective(fixture.target);
    expect(body.length).toBeGreaterThan(10_000);

    const result = await runLab(['run', '--max-iterations', '4'], labEnv(fixture.runs), raw);
    expect(result.exitCode, result.stderr).toBe(0);

    const output = JSON.parse(result.stdout) as {
      stopped_by: string;
      status?: string;
      decision_needed?: string;
      runtime_dir: string;
      human_instruction: string;
      generated_plan: { origin: string; file: string };
      observability: { directive_format: string; run_directive_sha256: string };
    };

    // Sem false human gate e sem rejeição de packet.
    expect(output.status).not.toBe('HUMAN_REQUIRED');
    expect(output.decision_needed).toBeUndefined();
    expect(result.stdout).not.toMatch(/PACKET_CONSTRUCTION/);
    expect(result.stdout).not.toMatch(/at most 4000 character/);
    expect(result.stdout).not.toMatch(/DRAFT_NOT_PARSEABLE/);

    // Plano gerado e persistido; ciclo completo.
    expect(output.stopped_by).toBe('ALL_DONE');
    expect(output.generated_plan.origin).toBe('GENERATED');
    expect((await loadPlan(output.generated_plan.file)).plan.tasks.length).toBeGreaterThan(0);

    // Autoridade humana persistida íntegra (byte equality do corpo).
    const persisted = await loadHumanInstruction(output.human_instruction);
    expect(
      Buffer.from(persisted.instruction_body as string, 'utf8').equals(Buffer.from(body, 'utf8')),
    ).toBe(true);
    const rawOnDisk = await readFile(path.join(output.runtime_dir, 'lab/run-directive.txt'), 'utf8');
    expect(rawOnDisk).toBe(raw.replace(/\r\n/g, '\n'));

    // Progresso de lifecycle observável em stderr, na ordem semântica.
    const stages = ['PREFLIGHT', 'TARGET_READY', 'AUTHORIZED', 'PLANNING', 'PLANNER_RUNNING', 'PLAN_READY', 'WORKER_RUNNING', 'VALIDATING', 'TASK_ACCEPTED', 'ALL_DONE'];
    const positions = stages.map((stage) => result.stderr.indexOf(stage));
    expect(positions.every((index) => index >= 0), result.stderr).toBe(true);
    expect([...positions]).toEqual([...positions].sort((left, right) => left - right));
    expect(result.stderr).toMatch(/\[\d{2}:\d{2}\] PREFLIGHT/);
  }, 90_000);

  it('guard de tamanho: Run Directive absurda falha antes de persistir e sem truncar', async () => {
    const fixture = await externalProject();
    const raw = runDirective({
      header: `target:\n  type: repository\n  path: ${fixture.target}\n`,
      body: `# Objective\n\n${'x'.repeat(300_000)}\n`,
    });
    const result = await runLab(['run'], labEnv(fixture.runs), raw);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/excede o limite de produto/);
    expect(result.stderr).toMatch(/Nada foi truncado/);
    expect(result.stdout).not.toMatch(/generated_plan/);
  }, 60_000);
});
