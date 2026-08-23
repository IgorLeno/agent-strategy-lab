/**
 * Fronteiras OPERACIONAIS da Onda 1, exercitadas contra Git real, .gitignore
 * real e o lifecycle real — não contra fixtures que imitam o harness.
 *
 * Cada teste aqui corresponde a um blocker observado no primeiro piloto real
 * (Augmented Chess, `foundation_app_scaffold`). O que eles provam é sempre a
 * mesma regra: A TECHNICAL PROBLEM IS NOT A HUMAN DECISION.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { changedFiles, headSha, workingTreeFiles } from '../../dev/lib/git.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan } from '../../dev/lib/plan.js';
import { readCompletion, readHandoff, writePacket } from '../../dev/lib/records.js';
import { buildTaskPacket } from '../../dev/lib/packet.js';
import {
  buildInitialState,
  ensureRuntimeDirs,
  readState,
  withTaskState,
  writeState,
} from '../../dev/lib/state.js';
import { commitAll, makeSandboxRepo, runDevCli, type Sandbox } from './helpers.js';
import { readFile } from 'node:fs/promises';
import { loadProjectRunAuthorization } from '../../dev/lib/project-authorization.js';
import { createProjectControlPlane } from '../../dev/lib/project-run.js';
import { runOrchestrate } from '../../dev/lib/orchestrate.js';
import { operationalAttemptPath } from '../../dev/lib/operational-attempt.js';



const PROFILE = 'fake-orchestrator-boundaries-v1';

/** Autorização mínima: fake worker, sem billing, sem review independente. */
const AUTHORIZATION = [
  'schema_version: 1',
  'requested_scope:',
  '  summary: criar os marcadores declarados pelo plano',
  'constraints: []',
  'exclusions: [deploy]',
  'autonomous_execution_boundary:',
  '  - DISPOSABLE_LOCAL_WORKSPACE',
  '  - CONFIGURED_SUBSCRIPTION_WORKER',
  '  - DETERMINISTIC_VALIDATION',
  '  - BOUNDED_REPAIR',
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
  `    - id: ${PROFILE}`,
  '      capability_rank: 1',
  '      rationale: degrau único declarado pela policy',
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
  '      changed_files: {expected: 3, maximum: 8}',
  '',
].join('\n');

/**
 * Plano de uma tarefa só: a validação oficial exige o arquivo que o worker
 * REALMENTE consegue versionar, e nada mais.
 */
const PLAN = `
schema_version: 1
tasks:
  - id: T1
    title: primeira tarefa
    objective: criar src/t1.txt
    initial_files: [README.md]
    acceptance: ['arquivo criado']
    validation:
      - argv: ['test', '-f', 'src/t1.txt']
        timeout_seconds: 30
`;

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Fixture {
  readonly sandbox: Sandbox;
  readonly paths: HarnessPaths;
  readonly baseline: string;
}

async function setup(options: { gitignore?: string } = {}): Promise<Fixture> {
  const sandbox = await makeSandboxRepo(PLAN);
  roots.push(sandbox.root);
  const paths = resolveHarnessPaths(sandbox.root);
  await writeFile(
    path.join(sandbox.root, 'dev', 'profiles', `${PROFILE}.yaml`),
    [
      `id: ${PROFILE}`,
      'agent: fake',
      'commit_owner: orchestrator',
      'official_validation_owner: orchestrator',
      'worker_validation_policy: targeted',
      'argv: [node, fixtures/fake-worker.mjs]',
      'prompt_delivery: argv',
      'timeout_seconds: 300',
      'forbidden_flags: []',
      'env_allowlist: [PATH, HOME, AGENTLAB_FAKE_MODE]',
      // `capabilityOf` e o router classificam MODELOS; um worker falso não tem
      // modelo. Sem este double, o control plane não consegue rotear nada —
      // nenhum provider real é envolvido por causa dele.
      'test_double_of:',
      '  agent: codex',
      '  model: gpt-5.6-luna',
      '  reasoning_effort: medium',
      '  sandbox: workspace-write',
    ].join('\n'),
    'utf8',
  );
  // Stack autoritativa: sem ela a materialização canônica é SKIPPED e o teste
  // de telemetria degradada não exercitaria nada.
  await writeFile(
    path.join(sandbox.root, 'package.json'),
    `${JSON.stringify({ name: 'alvo-fronteiras', version: '0.0.0', private: true }, null, 2)}\n`,
    'utf8',
  );
  if (options.gitignore !== undefined) {
    await writeFile(path.join(sandbox.root, '.gitignore'), options.gitignore, 'utf8');
  }
  const baseline = await commitAll(sandbox.root, 'perfil de fronteiras operacionais');
  const loaded = await loadPlan(paths.planFile);
  await ensureRuntimeDirs(paths);
  await writeState(
    paths,
    buildInitialState(loaded.plan, loaded.planSha256, { baselineSha: baseline }),
  );
  return { sandbox, paths, baseline };
}

function orchestrate(fixture: Fixture, mode: string, maxIterations = 1) {
  return runDevCli(
    'dev-orchestrate.ts',
    [
      '--repo',
      fixture.sandbox.root,
      '--profile',
      PROFILE,
      '--max-iterations',
      String(maxIterations),
    ],
    { AGENTLAB_DEV_DIR: fixture.sandbox.devDir, AGENTLAB_FAKE_MODE: mode },
  );
}

describe('fronteiras operacionais — Onda 1', () => {
  /**
   * BLOCKER #6 DO PILOTO, na sua forma exata.
   *
   * O worker declarou `src/coverage/.gitkeep`, o arquivo existe no filesystem,
   * e o Git o ignora por `.gitignore: coverage/`. Antes, isso travava a work
   * unit em RUNNING/FINALIZING para sempre. Agora o candidate é simplesmente o
   * que o Git consegue representar.
   */
  it('artifact ignorado pelo Git não vira HUMAN_REQUIRED', async () => {
    const fixture = await setup({ gitignore: '.dev/\n.dev-inbox/\ncoverage/\n' });

    // O worker escreve o arquivo ignorado ALÉM do arquivo da tarefa.
    await mkdir(path.join(fixture.sandbox.root, 'src', 'coverage'), { recursive: true });
    await writeFile(
      path.join(fixture.sandbox.root, 'src', 'coverage', '.gitkeep'),
      '',
      'utf8',
    );

    const result = await orchestrate(fixture, 'orchestrator-success');

    expect(result.exitCode, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      stopped_by: string;
      why_automation_stopped?: string;
      iterations: readonly { result: string }[];
    };
    expect(output.stopped_by).not.toBe('HUMAN_REQUIRED');
    expect(output.why_automation_stopped ?? null).toBeNull();
    expect(output.iterations[0]?.result).toBe('PASS');

    const state = await readState(fixture.paths);
    expect(state.tasks[0]).toMatchObject({ id: 'T1', status: 'PASS' });

    // O Git é a autoridade: o artifact ignorado NÃO entrou no candidate, e o
    // control plane não forçou `git add -f` nem tocou o .gitignore.
    const accepted = state.authorized_head_sha as string;
    expect(await changedFiles(fixture.sandbox.root, accepted)).not.toContain(
      'src/coverage/.gitkeep',
    );
    expect(await changedFiles(fixture.sandbox.root, accepted)).toContain('src/t1.txt');
  }, 60_000);

  /**
   * A nota do worker é informação semântica AUXILIAR. Ausente, a validação
   * oficial roda igual e o candidate real é aceito.
   */
  it('worker sem nota nenhuma não impede validação oficial nem aceitação', async () => {
    const fixture = await setup();
    const result = await orchestrate(fixture, 'incomplete-output-always');

    expect(result.exitCode, result.stderr).toBe(0);
    expect((JSON.parse(result.stdout) as { iterations: readonly { result: string }[] })
      .iterations[0]?.result).toBe('PASS');

    const completion = await readCompletion(fixture.paths, 'T1');
    expect(completion?.status).toBe('PASS');
    // A validação OFICIAL aconteceu — é ela, e não o worker, que decidiu.
    expect(completion?.orchestrator_evidence.revalidation.length).toBeGreaterThan(0);
    expect(completion?.orchestrator_evidence.revalidation[0]?.exit_code).toBe(0);
    // A nota ausente sobrevive como discrepância observável.
    expect(completion?.report).toBeNull();
    expect(completion?.report_matches_evidence).toBe(false);
    expect(completion?.discrepancies.join(' ')).toMatch(/AgentCompletionReport ausente/i);

    // O handoff selado continua com os fatos do ORQUESTRADOR.
    const handoff = await readHandoff(fixture.paths, 'T1');
    expect(handoff?.changed_files).toEqual(['src/t1.txt']);
    expect(handoff?.accepted_commit).toBe(await headSha(fixture.sandbox.root));
  }, 60_000);

  /**
   * BLOCKER #7 DO PILOTO.
   *
   * O processo do worker terminou e o fechamento não chegou ao state. Rerodar
   * o MESMO comando precisa retomar a finalização — sem o operador conhecer
   * `dev-close`, `closeTaskByLaunchPolicy` ou `dev-recover-*`.
   */
  it('rerodar o entrypoint retoma uma task deixada em RUNNING/FINALIZING', async () => {
    const fixture = await setup();
    const env = {
      AGENTLAB_DEV_DIR: fixture.sandbox.devDir,
      AGENTLAB_FAKE_MODE: 'orchestrator-success',
    };

    // INTERRUPÇÃO REAL, no ponto exato do piloto: persiste o packet, lança o
    // worker e para. `dev-launch` não fecha — quem fechava era um `dev-close`
    // que o operador tinha que saber rodar.
    const loaded = await loadPlan(fixture.paths.planFile);
    await writePacket(
      fixture.paths,
      buildTaskPacket({
        task: loaded.byId.get('T1')!,
        baseSha: fixture.baseline,
        previousHandoff: null,
      }),
    );
    const launched = await runDevCli(
      'dev-launch.ts',
      ['--repo', fixture.sandbox.root, '--task', 'T1', '--profile', PROFILE],
      env,
    );
    expect(launched.exitCode, launched.stderr).toBe(0);

    const interrupted = await readState(fixture.paths);
    expect(interrupted.tasks[0]).toMatchObject({
      id: 'T1',
      status: 'RUNNING',
      phase: 'FINALIZING',
    });
    expect(interrupted.authorized_head_sha).toBe(fixture.baseline);

    // Interface de resume: o MESMO comando de topo, de novo. Sem dev-close,
    // sem dev-recover-*, sem conhecer primitive nenhuma.
    const resumed = await orchestrate(fixture, 'orchestrator-success');

    expect(resumed.exitCode, resumed.stderr).toBe(0);
    const output = JSON.parse(resumed.stdout) as { stopped_by: string };
    expect(output.stopped_by).not.toBe('PREFLIGHT_BLOCKED');
    expect(output.stopped_by).not.toBe('HUMAN_REQUIRED');

    const state = await readState(fixture.paths);
    expect(state.tasks[0]).toMatchObject({ id: 'T1', status: 'PASS', attempts: 1 });
    // O attempt interrompido foi CONCLUÍDO, não repetido.
    expect(state.authorized_head_sha).toBe(await headSha(fixture.sandbox.root));
    expect(state.authorized_head_sha).not.toBe(fixture.baseline);
    expect(await workingTreeFiles(fixture.sandbox.root)).toEqual([]);
  }, 90_000);

  it('retomar duas vezes é idempotente: nenhum commit novo', async () => {
    const fixture = await setup();
    expect((await orchestrate(fixture, 'orchestrator-success')).exitCode).toBe(0);
    const accepted = await headSha(fixture.sandbox.root);

    const again = await orchestrate(fixture, 'orchestrator-success');
    expect(again.exitCode, again.stderr).toBe(0);
    expect(await headSha(fixture.sandbox.root)).toBe(accepted);
    expect((await readState(fixture.paths)).authorized_head_sha).toBe(accepted);
  }, 90_000);

  /**
   * O contraponto fail-closed: um worker que não produz material NENHUM
   * continua sem candidate. A Onda 1 removeu cerimônia, não a exigência de que
   * exista trabalho real para aceitar.
   */
  it('worker sem material real continua sem candidate', async () => {
    const fixture = await setup();
    const result = await orchestrate(fixture, 'no-commit');

    expect(result.exitCode).not.toBe(0);
    const state = await readState(fixture.paths);
    expect(state.tasks[0]?.status).not.toBe('PASS');
    expect(state.authorized_head_sha).toBe(fixture.baseline);
    expect(await headSha(fixture.sandbox.root)).toBe(fixture.baseline);
  }, 60_000);

  /**
   * FRONTEIRA 2I/2K.
   *
   * A materialização canônica é BENCHMARK-STYLE: envelope, execution record,
   * comparable facts, evaluation, score, qualification, manifests, index e
   * binding. Aqui ela é sabotada — `historyLabRoot` aponta para um ARQUIVO, e
   * nenhum data dir pode ser criado embaixo dele.
   *
   * O que precisa sobreviver: a work unit já validada AVANÇA, o candidate
   * continua aceito, e a degradação fica registrada em vez de reverter
   * trabalho válido.
   */
  it('falha de telemetria não reverte work unit já validada', async () => {
    const fixture = await setup();
    const loaded = await loadPlan(fixture.paths.planFile);

    // FORA do repositório alvo: um arquivo dentro dele sujaria a working tree
    // e o preflight recusaria antes de qualquer launch.
    const outside = await mkdtemp(path.join(os.tmpdir(), 'agentlab-telemetry-'));
    roots.push(outside);

    // `historyLabRoot` como arquivo: qualquer mkdir do data dir falha.
    const brokenLabRoot = path.join(outside, 'broken-lab-root');
    await writeFile(brokenLabRoot, 'não é um diretório\n', 'utf8');

    const authorizationFile = path.join(outside, 'agentlab-run.yaml');
    await writeFile(authorizationFile, AUTHORIZATION, 'utf8');
    const authorization = await loadProjectRunAuthorization(authorizationFile);

    const controlPlane = await createProjectControlPlane({
      paths: fixture.paths,
      loaded,
      authorization: authorization.file,
      authorizationFile: authorization.source_file,
      historyLabRoot: brokenLabRoot,
    });

    // `runOrchestrate` roda EM PROCESSO: o modo do worker falso precisa vir do
    // ambiente deste processo, não do env que o helper de CLI monta.
    const previousMode = process.env['AGENTLAB_FAKE_MODE'];
    process.env['AGENTLAB_FAKE_MODE'] = 'orchestrator-success';
    let result;
    try {
      result = await runOrchestrate({
        paths: fixture.paths,
        loaded,
        profileId: PROFILE,
        maxIterations: 1,
        controlPlane,
      });
    } finally {
      if (previousMode === undefined) delete process.env['AGENTLAB_FAKE_MODE'];
      else process.env['AGENTLAB_FAKE_MODE'] = previousMode;
    }

    // PROGRESSO OPERACIONAL PRESERVADO.
    expect(result.stop.status).not.toBe('HUMAN_REQUIRED');
    const state = await readState(fixture.paths);
    expect(state.tasks[0]).toMatchObject({ id: 'T1', status: 'PASS' });
    expect(state.authorized_head_sha).toBe(await headSha(fixture.sandbox.root));
    expect(await readCompletion(fixture.paths, 'T1')).toMatchObject({ status: 'PASS' });

    // DEGRADAÇÃO REGISTRADA, não silenciada.
    const unit = controlPlane.snapshot().work_units.at(-1);
    expect(unit?.telemetry_status).toBe('OBSERVABILITY_DEGRADED');
    expect(unit?.telemetry_reason).toBeTruthy();

    // O record operacional leve existe mesmo com o plano canônico quebrado.
    const record = JSON.parse(
      await readFile(operationalAttemptPath(fixture.paths, 'T1', 1), 'utf8'),
    ) as Record<string, unknown>;
    expect(record['task_id']).toBe('T1');
    expect(record['telemetry_status']).toBe('OBSERVABILITY_DEGRADED');
    expect(record['candidate_commit']).toBe(state.authorized_head_sha);
    expect(record['validation_outcome']).toBe('PASS');
    // UNKNOWN nunca vira zero.
    expect(record['usage_tokens']).toBeNull();
  }, 90_000);
});
