/**
 * E2E do CAMINHO EXECUTÁVEL de projeto externo: `dev-run-plan --authorization`
 * conduzindo um repositório-alvo sintético pelo control plane universal
 * (M71–M84) e pelas primitives de execução que já existiam.
 *
 * Diferença essencial para `project-orchestration-e2e.test.ts`: lá cada
 * contrato do lifecycle é exercitado isoladamente e a composição é feita pelo
 * próprio teste. Aqui a composição é feita pela PRODUÇÃO — o teste só fornece
 * repo, PlanFile e autorização, e verifica no output/evidência que inspection,
 * assessment, routing, budget, validação, review, diagnosis e escalation
 * aconteceram de verdade.
 *
 * Nenhum provider real: todos os profiles usam `fixtures/fake-worker.mjs`. Os
 * profiles `fake-worker-economy-v1` / `fake-worker-advanced-v1` declaram
 * `test_double_of` porque `capabilityOf` (M77) e o router (M78) classificam
 * MODELOS — sem isso o routing real não seria exercitável sem gastar dinheiro.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveHarnessInstallationRoot, resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import {
  candidateReviewPath,
  launchRecordPath,
  orchestratedFinalizationPath,
  readCandidateReview,
  readLaunchRecord,
  readOrchestratedFinalization,
} from '../../dev/lib/records.js';
import { getTaskState, readState } from '../../dev/lib/state.js';
import { runDevCli, runGit, type CliResult } from '../dev/helpers.js';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const ECONOMY = 'fake-worker-economy-v1';
const ADVANCED = 'fake-worker-advanced-v1';

interface Fixture {
  readonly root: string;
  readonly target: string;
  readonly plan: string;
  readonly authorization: string;
}

/**
 * Repositório-alvo EXTERNO e sintético: sem `dev/`, sem `dev/profiles`, sem
 * nenhuma relação com o Agent Strategy Lab. Só o que a inspeção de M72
 * precisa observar para que readiness fique READY sem inventar nada.
 */
async function externalTarget(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-external-run-'));
  created.push(root);
  const target = path.join(root, 'target');
  await mkdir(path.join(target, 'src'), { recursive: true });
  await mkdir(path.join(target, 'test'), { recursive: true });
  await mkdir(path.join(target, 'node_modules'), { recursive: true });
  await writeFile(
    path.join(target, 'package.json'),
    JSON.stringify(
      {
        name: 'external-plan-run-fixture',
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
  await writeFile(
    path.join(target, 'src', 'greet.ts'),
    'export function greet(name: string): string {\n  return `hello, ${name}`;\n}\n',
    'utf8',
  );
  await writeFile(path.join(target, 'test', 'greet.test.ts'), 'it("ok", () => {});\n', 'utf8');
  await writeFile(path.join(target, 'CLAUDE.md'), '# fixture externa sintética\n', 'utf8');
  await writeFile(path.join(target, '.gitignore'), '.dev/\n.dev-inbox/\n', 'utf8');
  await runGit(target, ['init', '-q', '-b', 'main']);
  await runGit(target, ['config', 'user.email', 'harness@example.invalid']);
  await runGit(target, ['config', 'user.name', 'Harness Test']);
  await runGit(target, ['add', '-A']);
  await runGit(target, ['commit', '-q', '-m', 'base']);
  return target;
}

function firstTaskYaml(firstValidation: string): readonly string[] {
  return [
    'schema_version: 1',
    'tasks:',
    '  - id: T1',
    '    title: primeira work unit',
    '    objective: criar o marcador da primeira work unit',
    '    initial_files: [src/greet.ts]',
    "    acceptance: ['marcador de T1 criado']",
    '    validation:',
    `      - argv: ${firstValidation}`,
    '        timeout_seconds: 30',
  ];
}

/** Plano de UMA work unit: usado onde a existência de T2 mudaria o desfecho. */
function singleTaskPlanYaml(firstValidation = "['true']"): string {
  return [...firstTaskYaml(firstValidation), ''].join('\n');
}

function planYaml(options: {
  readonly secondValidation: string;
  readonly firstValidation?: string;
}): string {
  return [
    ...firstTaskYaml(options.firstValidation ?? "['true']"),
    '  - id: T2',
    '    title: segunda work unit',
    '    blocked_by: [T1]',
    '    objective: criar o marcador da segunda work unit',
    '    initial_files: [src/greet.ts]',
    "    acceptance: ['marcador de T2 criado']",
    '    validation:',
    `      - argv: ${options.secondValidation}`,
    '        timeout_seconds: 30',
    '',
  ].join('\n');
}

interface AuthorizationOptions {
  readonly profiles?: readonly { readonly id: string; readonly rank: number }[];
  readonly risk?: string;
  readonly boundary?: readonly string[];
  readonly reviewerProfileId?: string;
}

function authorizationYaml(options: AuthorizationOptions = {}): string {
  const profiles = options.profiles ?? [
    { id: ECONOMY, rank: 0 },
    { id: ADVANCED, rank: 1 },
  ];
  const boundary = options.boundary ?? [
    'DISPOSABLE_LOCAL_WORKSPACE',
    'CONFIGURED_SUBSCRIPTION_WORKER',
    'DETERMINISTIC_VALIDATION',
    'BOUNDED_REPAIR',
    'CAPABILITY_ESCALATION_WITHIN_LADDER',
  ];
  return [
    'schema_version: 1',
    'requested_scope:',
    '  summary: criar os marcadores declarados pelo plano',
    'constraints: []',
    'exclusions: [deploy]',
    'autonomous_execution_boundary:',
    ...boundary.map((entry) => `  - ${entry}`),
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
    '  id: fake-policy',
    '  allowed_providers: [fake, codex]',
    '  profiles:',
    ...profiles.flatMap((entry) => [
      `    - id: ${entry.id}`,
      `      capability_rank: ${entry.rank}`,
      '      rationale: degrau declarado pela policy do experimento',
    ]),
    ...(options.reviewerProfileId === undefined
      ? []
      : ['review:', `  reviewer_profile_id: ${options.reviewerProfileId}`]),
    'work_units:',
    '  default:',
    '    task_class: feature',
    '    difficulty_declared: easy',
    `    risk: ${options.risk ?? 'low'}`,
    '    complexity: local',
    '    ambiguity: low',
    '    verification: deterministic',
    '    resource_envelope:',
    '      duration_ms: {expected: 20000, maximum: 60000}',
    '      tokens: {expected: 30000, maximum: 90000}',
    '      changed_files: {expected: 3, maximum: 8}',
    '',
  ].join('\n');
}

async function fixture(
  plan: string,
  authorization: string,
): Promise<Fixture> {
  const target = await externalTarget();
  const root = path.dirname(target);
  const planFile = path.join(root, 'plan.yaml');
  const authorizationFile = path.join(root, 'agentlab-run.yaml');
  await writeFile(planFile, plan, 'utf8');
  await writeFile(authorizationFile, authorization, 'utf8');
  return { root, target, plan: planFile, authorization: authorizationFile };
}

function runPlan(
  target: Fixture,
  mode: string,
  extra: readonly string[] = [],
  env: Record<string, string> = {},
): Promise<CliResult> {
  return runDevCli(
    'dev-run-plan.ts',
    [
      '--repo',
      target.target,
      '--plan',
      target.plan,
      '--authorization',
      target.authorization,
      '--max-iterations',
      '6',
      ...extra,
    ],
    { AGENTLAB_FAKE_MODE: mode, ...env },
  );
}

interface WorkUnitOutput {
  readonly task_id: string;
  readonly attempt_role: string;
  readonly path: string;
  readonly work_definition_source: string;
  readonly planning_worker_invoked: boolean;
  readonly workflow_outcome: string;
  readonly inspection_provenance: string;
  readonly risk: string;
  readonly environment_readiness: { readonly outcome: string };
  readonly routing: {
    readonly source: string;
    readonly selected_profile_id: string;
    readonly rationale: readonly string[];
  };
  readonly worker_runtime_budget: {
    readonly requested_ms: number;
    readonly timeout_seconds: number;
    readonly checked_bounds: readonly string[];
  };
  readonly launch_authorization: string;
  readonly review: { readonly required: boolean; readonly outcome: string | null };
  readonly validation_outcome: string | null;
  readonly comparable_run_facts_path: string | null;
  readonly diagnosis: string | null;
  readonly escalation: string | null;
}

interface RunOutput {
  readonly stopped_by: string;
  readonly reason: string;
  readonly iteration_count: number;
  readonly iterations: readonly { readonly task_id: string; readonly result: string }[];
  readonly project_lifecycle: {
    readonly mode: string;
    readonly profile_policy_id: string;
    readonly eligible_profile_ids: readonly string[];
    readonly work_units: readonly WorkUnitOutput[];
    readonly escalations: readonly {
      readonly task_id: string;
      readonly from_profile_id: string;
      readonly to_profile_id: string;
      readonly decision_owner: string;
    }[];
    readonly human_gate: {
      readonly decision_needed: string;
      readonly why_automation_stopped: string;
      readonly options: readonly string[];
    } | null;
  };
}

function parse(result: CliResult): RunOutput {
  expect(result.stdout, result.stderr).toMatch(/\{/);
  return JSON.parse(result.stdout) as RunOutput;
}

async function exists(target: string): Promise<boolean> {
  return readFile(target).then(
    () => true,
    () => false,
  );
}

describe('external plan run — dev-run-plan pelo lifecycle universal', () => {
  it('DIRECT — T1 -> T2 num único comando, com inspection, routing, budget, evidência e ALL_DONE', async () => {
    const target = await fixture(
      planYaml({ secondValidation: "['true']" }),
      authorizationYaml(),
    );

    // 1. o alvo NÃO tem dev/profiles.
    expect(await exists(path.join(target.target, 'dev', 'profiles', `${ECONOMY}.yaml`))).toBe(false);

    const result = await runPlan(target, 'orchestrator-success');
    expect(result.exitCode, result.stderr).toBe(0);
    const output = parse(result);

    // 12. ALL_DONE no final; 11. T2 só depois de T1 PASS.
    expect(output.stopped_by).toBe('ALL_DONE');
    expect(output.iterations.map((item) => [item.task_id, item.result])).toEqual([
      ['T1', 'PASS'],
      ['T2', 'PASS'],
    ]);

    const units = output.project_lifecycle.work_units;
    expect(units.map((unit) => unit.task_id)).toEqual(['T1', 'T2']);
    expect(output.project_lifecycle.mode).toBe('PROJECT_LIFECYCLE');

    for (const unit of units) {
      // 3. inspeção M72 real do ALVO, com proveniência.
      expect(unit.inspection_provenance).toContain('inspectRepository');
      expect(unit.inspection_provenance).toContain(target.target);
      // 4. work unit avaliada — M75 + M76.
      expect(unit.path).toBe('DIRECT');
      expect(unit.workflow_outcome).toBe('DIRECT_ALLOWED');
      expect(unit.environment_readiness.outcome).toBe('READY');
      expect(unit.launch_authorization).toBe('ALLOW');
      // PlanFile é work definition confiável: nenhum planning worker o reescreve.
      expect(unit.work_definition_source).toBe('plan_file');
      expect(unit.planning_worker_invoked).toBe(false);
      // 5. routing REAL escolheu o profile dentro da policy.
      expect(unit.routing.selected_profile_id).toBe(ECONOMY);
      expect(unit.routing.source).toBe('M78_FALLBACK');
      expect(unit.routing.rationale.join(' ')).toContain('tier requerido=economy');
      // 6. worker runtime budget adaptativo, checado contra os bounds.
      expect(unit.worker_runtime_budget.requested_ms).toBeGreaterThan(0);
      expect(unit.worker_runtime_budget.timeout_seconds).toBeGreaterThan(0);
      expect(unit.worker_runtime_budget.checked_bounds.join(' ')).toContain('profile_runtime=');
      // 8. validação oficial ocorreu.
      expect(unit.validation_outcome).toBe('PASS');
      // 9. review só quando a policy pedir — aqui não pediu.
      expect(unit.review.required).toBe(false);
      expect(unit.review.outcome).toBe('NOT_REQUIRED');
      // 10. ComparableRunFacts gravados (M81 é leitor; o lifecycle é o writer).
      expect(unit.comparable_run_facts_path).toMatch(/comparable-run-facts\.json$/);
      expect(await exists(unit.comparable_run_facts_path as string)).toBe(true);
      const facts = JSON.parse(
        await readFile(unit.comparable_run_facts_path as string, 'utf8'),
      ) as { profile_id: { value: string }; provider: { value: string } };
      expect(facts.profile_id.value).toBe(ECONOMY);
      expect(facts.provider.value).toBe('fake');
    }

    // 7. o implementer rodou NO ALVO, e 2. o profile veio do catálogo do lab.
    const paths = resolveHarnessPaths(target.target, { planFile: target.plan });
    const stdout = await readFile(path.join(paths.logsDir, 'T1.stdout.log'), 'utf8');
    expect(stdout).toContain(`AGENTLAB_WORKER_CWD=${target.target}`);
    const launch = JSON.parse(
      await readFile(path.join(paths.logsDir, 'T1.launch.json'), 'utf8'),
    ) as { profile_id: string; argv: string[] };
    expect(launch.profile_id).toBe(ECONOMY);
    expect(launch.argv.join(' ')).toContain(
      path.join(resolveHarnessInstallationRoot(), 'fixtures/fake-worker.mjs'),
    );
    expect(await exists(path.join(target.target, 'dev', 'profiles', `${ECONOMY}.yaml`))).toBe(false);

    expect((await readState(paths)).tasks.map((task) => task.status)).toEqual(['PASS', 'PASS']);

    // Sem review exigida, o caminho rápido continua: nenhum candidate declara
    // exigência e nenhum veredito é gravado.
    for (const taskId of ['T1', 'T2']) {
      const attempts = getTaskState(await readState(paths), taskId).attempts;
      expect(
        (await readOrchestratedFinalization(paths, taskId, attempts))?.review_requirement,
      ).toBeUndefined();
      expect(await exists(candidateReviewPath(paths, taskId, attempts))).toBe(false);
    }
  }, 120_000);

  it('CAPABILITY — FAIL, repair FAIL, diagnosis, escalation autorizada e PASS sem gate humano', async () => {
    const target = await fixture(
      planYaml({ secondValidation: "['grep', '-qx', 'repaired', 'src/t2.txt']" }),
      authorizationYaml(),
    );

    const result = await runPlan(target, 'official-fail-until-escalation');
    expect(result.exitCode, result.stderr).toBe(0);
    const output = parse(result);

    expect(output.stopped_by).toBe('ALL_DONE');
    expect(output.iterations.map((item) => [item.task_id, item.result])).toEqual([
      ['T1', 'PASS'],
      ['T2', 'FAIL'],
      ['T2', 'FAIL'],
      ['T2', 'PASS'],
    ]);

    const units = output.project_lifecycle.work_units;
    const t2 = units.filter((unit) => unit.task_id === 'T2');
    expect(t2.map((unit) => unit.attempt_role)).toEqual(['initial', 'repair', 'escalation']);
    expect(t2.map((unit) => unit.routing.selected_profile_id)).toEqual([
      ECONOMY,
      ECONOMY,
      ADVANCED,
    ]);
    expect(t2.map((unit) => unit.validation_outcome)).toEqual(['FAIL', 'FAIL', 'PASS']);
    expect(t2[1]?.diagnosis).toBe('CAPABILITY');

    expect(output.project_lifecycle.escalations).toEqual([
      {
        task_id: 'T2',
        from_profile_id: ECONOMY,
        to_profile_id: ADVANCED,
        cross_provider: false,
        step_index: 1,
        decision_owner: 'agent_strategy_lab_harness',
      },
    ]);
    // zero gate humano dentro da ladder autorizada.
    expect(output.project_lifecycle.human_gate).toBeNull();
    expect(JSON.stringify(output)).not.toContain('HUMAN_REQUIRED');

    const paths = resolveHarnessPaths(target.target, { planFile: target.plan });
    expect((await readState(paths)).tasks.map((task) => task.status)).toEqual(['PASS', 'PASS']);
  }, 180_000);

  it('MAX-ITERATIONS — escalation da MESMA task cabe no ciclo primário; T2 não lança', async () => {
    const target = await fixture(
      planYaml({
        firstValidation: "['grep', '-qx', 'repaired', 'src/t1.txt']",
        secondValidation: "['true']",
      }),
      authorizationYaml(),
    );

    const result = await runPlan(target, 'official-fail-until-escalation', [
      '--max-iterations',
      '1',
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    const output = parse(result);

    // Um único ciclo primário cobriu first pass, bounded repair e escalation.
    expect(output.iterations.map((item) => [item.task_id, item.result])).toEqual([
      ['T1', 'FAIL'],
      ['T1', 'FAIL'],
      ['T1', 'PASS'],
    ]);
    expect(output.project_lifecycle.escalations.map((item) => item.task_id)).toEqual(['T1']);

    // O budget primário acabou: T2 continua pendente e o desfecho diz isso.
    expect(output.stopped_by).toBe('LIMIT_REACHED');
    expect(output.reason).toContain('T2');
    const paths = resolveHarnessPaths(target.target, { planFile: target.plan });
    const state = await readState(paths);
    expect(getTaskState(state, 'T1').status).toBe('PASS');
    expect(getTaskState(state, 'T2').status).toBe('READY');
    expect(await exists(launchRecordPath(paths, 'T2'))).toBe(false);
  }, 180_000);

  it('MAX-ITERATIONS — escalation conclui a única task do plano com ALL_DONE', async () => {
    const target = await fixture(
      singleTaskPlanYaml("['grep', '-qx', 'repaired', 'src/t1.txt']"),
      authorizationYaml(),
    );

    const result = await runPlan(target, 'official-fail-until-escalation', [
      '--max-iterations',
      '1',
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    const output = parse(result);

    expect(output.iterations.map((item) => item.result)).toEqual(['FAIL', 'FAIL', 'PASS']);
    expect(output.stopped_by).toBe('ALL_DONE');
    const paths = resolveHarnessPaths(target.target, { planFile: target.plan });
    expect(getTaskState(await readState(paths), 'T1').status).toBe('PASS');
  }, 180_000);

  it('BENCHMARK — policy de profile único nunca é ampliada: escalation exigida vira HUMAN_REQUIRED', async () => {
    const target = await fixture(
      planYaml({ secondValidation: "['grep', '-qx', 'repaired', 'src/t2.txt']" }),
      authorizationYaml({ profiles: [{ id: ECONOMY, rank: 0 }] }),
    );

    const result = await runPlan(target, 'official-fail-until-escalation');
    expect(result.exitCode).toBe(9);
    const output = parse(result);

    expect(output.stopped_by).toBe('HUMAN_REQUIRED');
    expect(output.project_lifecycle.eligible_profile_ids).toEqual([ECONOMY]);
    // Inspection, assessment, routing, budget e validação continuam acontecendo.
    const units = output.project_lifecycle.work_units;
    expect(units.every((unit) => unit.routing.selected_profile_id === ECONOMY)).toBe(true);
    expect(units.some((unit) => unit.validation_outcome === 'FAIL')).toBe(true);
    expect(units.some((unit) => unit.diagnosis === 'CAPABILITY')).toBe(true);
    expect(output.project_lifecycle.escalations).toEqual([]);
    expect(output.project_lifecycle.human_gate?.why_automation_stopped).toContain(
      'único profile elegível',
    );
    expect(output.project_lifecycle.human_gate?.options.join(' ')).toContain(
      'aceitar o resultado do profile fixado pelo experimento',
    );
  }, 180_000);

  it('REVIEW — quando a policy exige, a review roda em invocação nova e read-only', async () => {
    const target = await fixture(
      planYaml({ secondValidation: "['true']" }),
      authorizationYaml({ risk: 'high' }),
    );

    const result = await runPlan(target, 'orchestrator-success');
    expect(result.exitCode, result.stderr).toBe(0);
    const output = parse(result);
    expect(output.stopped_by).toBe('ALL_DONE');

    for (const unit of output.project_lifecycle.work_units) {
      expect(unit.path).toBe('REVIEWED');
      expect(unit.review.required).toBe(true);
      expect(unit.review.outcome).toBe('ACCEPT');
      // risco alto sobe o tier requerido: o routing troca de profile sozinho.
      expect(unit.routing.selected_profile_id).toBe(ADVANCED);
    }
  }, 120_000);

  it('REVIEW ACCEPT — PASS só existe DEPOIS do veredito durável, e então libera T2', async () => {
    const target = await fixture(
      planYaml({ secondValidation: "['true']" }),
      authorizationYaml({ risk: 'high' }),
    );

    const result = await runPlan(target, 'orchestrator-success');
    expect(result.exitCode, result.stderr).toBe(0);
    const output = parse(result);
    expect(output.stopped_by).toBe('ALL_DONE');

    const paths = resolveHarnessPaths(target.target, { planFile: target.plan });
    const state = await readState(paths);
    const t1 = getTaskState(state, 'T1');

    // O candidate preparado DECLARA a exigência de review: é o que faz a
    // fronteira sobreviver ao processo que a criou.
    const finalization = await readOrchestratedFinalization(paths, 'T1', t1.attempts);
    expect(finalization?.review_requirement?.required).toBe(true);
    expect(finalization?.review_requirement?.reviewer_profile_id).toBe(ADVANCED);

    // O veredito é DURÁVEL e amarrado ao candidate revisado.
    const review = await readCandidateReview(paths, 'T1', t1.attempts);
    expect(review?.decision).toBe('ACCEPT');
    expect(review?.candidate_sha).toBe(finalization?.candidate_commit);
    expect(review?.reviewer_invocation.workspace_access).toBe('READ_ONLY');
    expect(review?.reviewer_invocation.fresh_context).toBe(true);
    expect(review?.reviewer_invocation.argv.join(' ')).toContain('--agentlab-read-only');

    // Só DEPOIS do ACCEPT a aceitação existe.
    expect(t1.status).toBe('PASS');
    expect(t1.accepted_commit).toBe(finalization?.candidate_commit);

    // E a próxima work unit foi liberada sobre o commit aceito.
    expect(getTaskState(state, 'T2').status).toBe('PASS');
    expect(output.iterations.map((item) => [item.task_id, item.result])).toEqual([
      ['T1', 'PASS'],
      ['T2', 'PASS'],
    ]);
  }, 120_000);

  it('REVIEW — veredito REJECT para a automação com gate humano, sem PASS silencioso', async () => {
    const target = await fixture(
      planYaml({ secondValidation: "['true']" }),
      authorizationYaml({ risk: 'high' }),
    );

    const result = await runPlan(target, 'orchestrator-success', [], {
      AGENTLAB_FAKE_REVIEW: 'reject',
    });
    expect(result.exitCode).toBe(9);
    const output = parse(result);
    expect(output.stopped_by).toBe('HUMAN_REQUIRED');
    expect(output.project_lifecycle.work_units[0]?.review.outcome).toBe('REJECT');
    expect(output.project_lifecycle.human_gate?.why_automation_stopped).toContain(
      'review independente não aceitou a mudança',
    );

    // O bug original: o reviewer REJEITAVA e a task já estava aceita.
    const paths = resolveHarnessPaths(target.target, { planFile: target.plan });
    const state = await readState(paths);
    const t1 = getTaskState(state, 'T1');
    expect(t1.status).not.toBe('PASS');
    expect(t1.accepted_commit).toBeNull();

    // O candidate REPROVADO continua preservado, mas não é autoridade nenhuma.
    const finalization = await readOrchestratedFinalization(paths, 'T1', t1.attempts);
    expect(finalization?.candidate_commit).toBeTruthy();
    expect(state.authorized_head_sha).not.toBe(finalization?.candidate_commit);
    const review = await readCandidateReview(paths, 'T1', t1.attempts);
    expect(review?.decision).toBe('REJECT');
    expect(review?.candidate_sha).toBe(finalization?.candidate_commit);

    // T2 nunca foi lançada.
    expect(getTaskState(state, 'T2').status).toBe('READY');
    expect(await exists(launchRecordPath(paths, 'T2'))).toBe(false);
  }, 120_000);

  it('REVIEW REJECT — rerun do mesmo comando continua HUMAN_REQUIRED, sem novo launch', async () => {
    const target = await fixture(
      planYaml({ secondValidation: "['true']" }),
      authorizationYaml({ risk: 'high' }),
    );

    const first = await runPlan(target, 'orchestrator-success', [], {
      AGENTLAB_FAKE_REVIEW: 'reject',
    });
    expect(first.exitCode).toBe(9);

    const paths = resolveHarnessPaths(target.target, { planFile: target.plan });
    const before = await readLaunchRecord(paths, 'T1');
    const attemptsBefore = getTaskState(await readState(paths), 'T1').attempts;

    // Rerun SEM intervenção humana e SEM o env que causou o REJECT: o veredito
    // durável é que continua valendo, não a configuração do rerun.
    const second = await runPlan(target, 'orchestrator-success');
    expect(second.exitCode).toBe(9);
    const output = parse(second);
    expect(output.stopped_by).toBe('HUMAN_REQUIRED');
    expect(output.reason).toContain('review independente não aceitou a mudança');

    // Zero implementer novo, zero attempt novo, zero bypass para T2.
    expect(output.iteration_count).toBe(0);
    const after = await readLaunchRecord(paths, 'T1');
    expect(after?.launch_id).toBe(before?.launch_id);
    const state = await readState(paths);
    expect(getTaskState(state, 'T1').attempts).toBe(attemptsBefore);
    expect(getTaskState(state, 'T1').status).not.toBe('PASS');
    expect(getTaskState(state, 'T1').accepted_commit).toBeNull();
    expect(getTaskState(state, 'T2').status).toBe('READY');
    expect(await exists(launchRecordPath(paths, 'T2'))).toBe(false);
  }, 180_000);

  it('REVIEW pendente — crash antes do veredito retoma a review, sem repetir o implementer', async () => {
    const target = await fixture(
      planYaml({ secondValidation: "['true']" }),
      authorizationYaml({ risk: 'high' }),
    );

    // Review exigida que não pôde ser CONCLUÍDA: o candidate fica preparado e
    // validado, sem veredito publicado — exatamente o estado em disco de um
    // crash entre a preparação do candidate e a decisão do reviewer.
    const interrupted = await runPlan(target, 'orchestrator-success', [], {
      AGENTLAB_FAKE_REVIEW: 'invalid',
    });
    expect(interrupted.exitCode).toBe(9);

    const paths = resolveHarnessPaths(target.target, { planFile: target.plan });
    const beforeState = await readState(paths);
    const t1Before = getTaskState(beforeState, 'T1');
    const candidate = (await readOrchestratedFinalization(paths, 'T1', t1Before.attempts))
      ?.candidate_commit;
    expect(candidate).toBeTruthy();
    expect(t1Before.status).not.toBe('PASS');
    expect(await exists(candidateReviewPath(paths, 'T1', t1Before.attempts))).toBe(false);
    const launchBefore = await readLaunchRecord(paths, 'T1');

    const resumed = await runPlan(target, 'orchestrator-success');
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    expect(parse(resumed).stopped_by).toBe('ALL_DONE');

    // Mesmo candidate promovido; nenhum implementer novo para T1.
    const state = await readState(paths);
    const t1 = getTaskState(state, 'T1');
    expect(t1.status).toBe('PASS');
    expect(t1.accepted_commit).toBe(candidate);
    expect(t1.attempts).toBe(t1Before.attempts);
    expect((await readCandidateReview(paths, 'T1', t1.attempts))?.candidate_sha).toBe(candidate);
    expect((await readLaunchRecord(paths, 'T1'))?.launch_id).toBe(launchBefore?.launch_id);
  }, 180_000);

  it('HUMAN GATE — capability fora do boundary para antes de qualquer spawn', async () => {
    const target = await fixture(
      planYaml({ secondValidation: "['true']" }),
      authorizationYaml({
        boundary: ['DISPOSABLE_LOCAL_WORKSPACE', 'DETERMINISTIC_VALIDATION'],
      }),
    );

    const result = await runPlan(target, 'orchestrator-success');
    expect(result.exitCode).toBe(9);
    const output = parse(result);

    expect(output.stopped_by).toBe('HUMAN_REQUIRED');
    expect(output.iteration_count).toBe(0);
    expect(output.project_lifecycle.work_units[0]?.launch_authorization).toBe('HUMAN_REQUIRED');
    expect(output.project_lifecycle.human_gate?.why_automation_stopped).toContain(
      'fora do autonomous_execution_boundary',
    );

    // nenhum provider foi lançado depois do gate.
    const paths = resolveHarnessPaths(target.target, { planFile: target.plan });
    expect(await exists(path.join(paths.logsDir, 'T1.launch.json'))).toBe(false);
    expect((await readState(paths)).tasks.map((task) => task.status)).toEqual(['READY', 'READY']);
  }, 120_000);

  it('HUMAN GATE — risco crítico é ação security-sensitive e nunca é executado sozinho', async () => {
    const target = await fixture(
      planYaml({ secondValidation: "['true']" }),
      authorizationYaml({ risk: 'critical' }),
    );

    const result = await runPlan(target, 'orchestrator-success');
    expect(result.exitCode).toBe(9);
    const output = parse(result);
    expect(output.stopped_by).toBe('HUMAN_REQUIRED');
    expect(output.iteration_count).toBe(0);
    expect(output.reason).toContain('risco crítico');
  }, 120_000);
});
