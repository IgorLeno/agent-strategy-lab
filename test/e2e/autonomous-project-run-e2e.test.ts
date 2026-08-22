import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveHarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan } from '../../dev/lib/plan.js';
import { readState } from '../../dev/lib/state.js';
import { runDevCli, runGit } from '../dev/helpers.js';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  readonly target: string;
  readonly request: string;
  readonly authorization: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-v01-e2e-'));
  created.push(root);
  const target = path.join(root, 'target');
  await mkdir(path.join(target, 'src'), { recursive: true });
  await mkdir(path.join(target, 'test'), { recursive: true });
  await mkdir(path.join(target, 'node_modules'), { recursive: true });
  await writeFile(
    path.join(target, 'package.json'),
    JSON.stringify(
      {
        name: 'agentlab-v01-target',
        version: '1.0.0',
        private: true,
        scripts: { typecheck: 'true', test: 'true' },
        devDependencies: { vitest: '^2.1.8' },
      },
      null,
      2,
    ),
    'utf8',
  );
  await writeFile(path.join(target, 'tsconfig.json'), '{}\n', 'utf8');
  await writeFile(path.join(target, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8');
  await writeFile(path.join(target, 'src', 'greet.ts'), 'export const greet = "hello";\n', 'utf8');
  await writeFile(path.join(target, 'test', 'greet.test.ts'), 'it("ok", () => {});\n', 'utf8');
  await writeFile(path.join(target, 'AGENTS.md'), '# fixture de projeto externo\n', 'utf8');
  await writeFile(path.join(target, '.gitignore'), '.dev/\n.dev-inbox/\n', 'utf8');
  await runGit(target, ['init', '-q', '-b', 'main']);
  await runGit(target, ['config', 'user.email', 'harness@example.invalid']);
  await runGit(target, ['config', 'user.name', 'Harness Test']);
  await runGit(target, ['add', '-A']);
  await runGit(target, ['commit', '-q', '-m', 'base']);
  const head = (await runGit(target, ['rev-parse', 'HEAD'])).stdout.trim();

  const request = path.join(root, 'project-request.yaml');
  await writeFile(
    request,
    [
      'schema_version: 1',
      'target_repo:',
      '  url: ' + target,
      'base_revision:',
      '  sha: ' + head,
      'user_request: criar o marcador local solicitado',
      'objectives:',
      '  - src/t1.txt existe após a execução',
      'constraints: []',
      'exclusions: [deploy]',
      'requested_scope:',
      '  summary: criar um marcador local',
      '',
    ].join('\n'),
    'utf8',
  );

  const authorization = path.join(root, 'agentlab-run.yaml');
  await writeFile(
    authorization,
    [
      'schema_version: 1',
      'requested_scope:',
      '  summary: criar um marcador local',
      'objectives:',
      '  - src/t1.txt existe após a execução',
      'constraints: []',
      'exclusions: [deploy]',
      'autonomous_execution_boundary:',
      '  - DISPOSABLE_LOCAL_WORKSPACE',
      '  - CONFIGURED_SUBSCRIPTION_WORKER',
      '  - DETERMINISTIC_VALIDATION',
      '  - BOUNDED_REPAIR',
      '  - CAPABILITY_ESCALATION_WITHIN_LADDER',
      'human_gated_capabilities:',
      '  - UNAUTHORIZED_API_BILLING',
      '  - DESTRUCTIVE_ACTION',
      '  - DEPLOYMENT_OR_PRODUCTION',
      '  - EXTERNAL_SIDE_EFFECT',
      '  - SCOPE_EXPANSION',
      '  - NEW_CREDENTIAL_BOUNDARY',
      '  - CRITICAL_OR_SECURITY_SENSITIVE_ACTION',
      'billing:',
      '  allowed_billing_modes: [not_applicable]',
      'profile_policy:',
      '  id: v01-fake-policy',
      '  allowed_providers: [fake, codex]',
      '  profiles:',
      '    - id: fake-worker-economy-v1',
      '      capability_rank: 0',
      '      rationale: test double econômico autorizado',
      'work_units:',
      '  default:',
      '    task_class: feature',
      '    difficulty_declared: easy',
      '    risk: low',
      '    complexity: local',
      '    ambiguity: low',
      '    verification: deterministic',
      '    resource_envelope:',
      '      duration_ms: {expected: 20000, maximum: 60000}',
      '      tokens: {expected: 30000, maximum: 90000}',
      '      changed_files: {expected: 1, maximum: 3}',
      '',
    ].join('\n'),
    'utf8',
  );
  return { target, request, authorization };
}

function runProject(target: {
  readonly target: string;
  readonly request: string;
  readonly authorization: string;
}) {
  return runDevCli(
    'dev-run-project.ts',
    [
      '--repo',
      target.target,
      '--request',
      target.request,
      '--authorization',
      target.authorization,
      '--max-iterations',
      '4',
    ],
    {
      AGENTLAB_FAKE_MODE: 'orchestrator-success',
      AGENTLAB_DATA_DIR: path.join(path.dirname(target.target), 'control-plane-data'),
    },
  );
}

describe('dev-run-project v0.1', () => {
  it('objective → planner → generated PlanFile → existing executor → accepted PASS', async () => {
    const target = await fixture();

    const first = await runProject(target);
    expect(first.exitCode, first.stderr).toBe(0);
    const firstOutput = JSON.parse(first.stdout) as {
      stopped_by: string;
      generated_plan: { origin: string; file: string };
    };
    expect(firstOutput.stopped_by).toBe('ALL_DONE');
    expect(firstOutput.generated_plan.origin).toBe('GENERATED');

    const paths = resolveHarnessPaths(target.target, { planFile: firstOutput.generated_plan.file });
    const planBeforeRestart = await readFile(firstOutput.generated_plan.file);
    expect((await loadPlan(firstOutput.generated_plan.file)).plan.tasks.map((task) => task.id)).toEqual([
      'T1',
    ]);
    expect((await readState(paths)).tasks.map((task) => task.status)).toEqual(['PASS']);

    const resumed = await runProject(target);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    const resumedOutput = JSON.parse(resumed.stdout) as {
      stopped_by: string;
      generated_plan: { origin: string; file: string };
    };
    expect(resumedOutput.stopped_by).toBe('ALL_DONE');
    expect(resumedOutput.generated_plan.origin).toBe('REUSED');
    expect(await readFile(resumedOutput.generated_plan.file)).toEqual(planBeforeRestart);
  }, 60_000);
});
