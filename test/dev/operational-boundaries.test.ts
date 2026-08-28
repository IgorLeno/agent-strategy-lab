/**
 * Fronteiras OPERACIONAIS da Onda 1, exercitadas contra Git real, .gitignore
 * real e o lifecycle real — não contra fixtures que imitam o harness.
 *
 * Cada teste aqui corresponde a um blocker observado no primeiro piloto real
 * (Augmented Chess, `foundation_app_scaffold`). O que eles provam é sempre a
 * mesma regra: A TECHNICAL PROBLEM IS NOT A HUMAN DECISION.
 */
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { changedFiles, headSha, workingTreeFiles } from '../../dev/lib/git.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan } from '../../dev/lib/plan.js';
import {
  candidateReviewPath,
  readCandidateReview,
  readCompletion,
  readHandoff,
  readReviewRejectedAttempt,
  readReviewRejectionClassification,
  writePacket,
} from '../../dev/lib/records.js';
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
import { ProviderRoleInvocationError } from '../../dev/lib/project-orchestrate.js';
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
      'forbidden_flags: []',
      'env_allowlist: [PATH, HOME, AGENTLAB_FAKE_MODE, AGENTLAB_FAKE_REVIEW]',
      // `capabilityOf` e o router classificam MODELOS; um worker falso não tem
      // modelo. Sem este double, o control plane não consegue rotear nada —
      // nenhum provider real é envolvido por causa dele.
      'test_double_of:',
      '  agent: codex',
      '  model: gpt-5.6-sol',
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
  it('REJECT de implementation defect aciona um único repair e exige nova review', async () => {
    const fixture = await setup();
    const loaded = await loadPlan(fixture.paths.planFile);
    const outside = await mkdtemp(path.join(os.tmpdir(), 'agentlab-review-repair-'));
    roots.push(outside);
    const authorizationFile = path.join(outside, 'agentlab-run.yaml');
    await writeFile(authorizationFile, AUTHORIZATION.replace('risk: low', 'risk: high'), 'utf8');
    const authorization = await loadProjectRunAuthorization(authorizationFile);
    let reviewInvocations = 0;
    const controlPlane = await createProjectControlPlane({
      paths: fixture.paths,
      loaded,
      authorization: authorization.file,
      authorizationFile: authorization.source_file,
      historyLabRoot: outside,
      reviewerPort: {
        async run() {
          reviewInvocations += 1;
          return JSON.stringify(
            reviewInvocations === 1
              ? {
                  decision: 'REJECT',
                  rejection_disposition: 'IMPLEMENTATION_DEFECT',
                  reason: 'candidate viola acceptance já definido',
                }
              : {
                  decision: 'ACCEPT',
                  reason: 'repair satisfaz acceptance',
                  coverage: {
                    files: ['src/t1.txt'],
                    validations: [['test', '-f', 'src/t1.txt']],
                    behaviors: ['arquivo requerido existe'],
                    handoff_gaps: [],
                  },
                },
          );
        },
      },
    });

    const previousMode = process.env['AGENTLAB_FAKE_MODE'];
    const previousReview = process.env['AGENTLAB_FAKE_REVIEW'];
    process.env['AGENTLAB_FAKE_MODE'] = 'orchestrator-success';
    process.env['AGENTLAB_FAKE_REVIEW'] = 'reject-implementation-once';
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
      if (previousReview === undefined) delete process.env['AGENTLAB_FAKE_REVIEW'];
      else process.env['AGENTLAB_FAKE_REVIEW'] = previousReview;
    }

    expect(result.stop.status, JSON.stringify(result, null, 2)).toBe('ALL_DONE');
    expect(result.iterationCount).toBe(2);
    expect(reviewInvocations).toBe(2);
    expect(await readReviewRejectedAttempt(fixture.paths, 'T1', 1)).toMatchObject({
      rejection_disposition: 'IMPLEMENTATION_DEFECT',
      profile_id: PROFILE,
    });
    expect((await readState(fixture.paths)).tasks[0]).toMatchObject({
      status: 'PASS',
      attempts: 2,
    });
  }, 90_000);

  it('REJECT que exige decisão de produto preserva candidate e para para humano', async () => {
    const fixture = await setup();
    const loaded = await loadPlan(fixture.paths.planFile);
    const outside = await mkdtemp(path.join(os.tmpdir(), 'agentlab-review-human-'));
    roots.push(outside);
    const authorizationFile = path.join(outside, 'agentlab-run.yaml');
    await writeFile(authorizationFile, AUTHORIZATION.replace('risk: low', 'risk: high'), 'utf8');
    const authorization = await loadProjectRunAuthorization(authorizationFile);
    const controlPlane = await createProjectControlPlane({
      paths: fixture.paths,
      loaded,
      authorization: authorization.file,
      authorizationFile: authorization.source_file,
      historyLabRoot: outside,
      reviewerPort: {
        async run() {
          return JSON.stringify({
            decision: 'REJECT',
            rejection_disposition: 'REQUIREMENT_OR_SCOPE_DECISION',
            reason: 'aceite exige escolher uma nova regra de produto',
          });
        },
      },
    });
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

    expect(result.stop.status).toBe('HUMAN_REQUIRED');
    expect(result.stop.reason).toContain('review independente não aceitou');
    expect(await readReviewRejectedAttempt(fixture.paths, 'T1', 1)).toBeNull();
    const state = await readState(fixture.paths);
    expect(state.tasks[0]).toMatchObject({ status: 'RUNNING', phase: 'FINALIZING', attempts: 1 });
    expect(await headSha(fixture.sandbox.root)).not.toBe(fixture.baseline);
  }, 90_000);

  it('saída não parseável do reviewer persiste evidência real e não inventa review.json', async () => {
    const fixture = await setup();
    const loaded = await loadPlan(fixture.paths.planFile);
    const outside = await mkdtemp(path.join(os.tmpdir(), 'agentlab-review-unparseable-'));
    roots.push(outside);
    const authorizationFile = path.join(outside, 'agentlab-run.yaml');
    await writeFile(authorizationFile, AUTHORIZATION.replace('risk: low', 'risk: high'), 'utf8');
    const authorization = await loadProjectRunAuthorization(authorizationFile);
    const leakedSecret = 'sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0123456789AA';
    const unparseableStdout =
      `reviewer prose without a verdict object; leaked=${leakedSecret}\n` +
      'the candidate looks fine overall';
    const controlPlane = await createProjectControlPlane({
      paths: fixture.paths,
      loaded,
      authorization: authorization.file,
      authorizationFile: authorization.source_file,
      historyLabRoot: outside,
      reviewerPort: {
        async run() {
          return unparseableStdout;
        },
      },
    });
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

    expect(result.stop.status, JSON.stringify(result.payload, null, 2)).toBe('HUMAN_REQUIRED');
    expect(result.stop.reason).toContain('review independente não pôde ser concluída');
    expect(result.payload['incident_id']).toEqual(expect.stringContaining('review'));

    const reviewPath = candidateReviewPath(fixture.paths, 'T1', 1);
    await expect(readCandidateReview(fixture.paths, 'T1', 1)).resolves.toBeNull();
    await expect(access(reviewPath)).rejects.toMatchObject({ code: 'ENOENT' });

    const evidencePaths = result.payload['evidence_paths'];
    expect(Array.isArray(evidencePaths) && evidencePaths.length > 0).toBe(true);
    const existingEvidence = evidencePaths as string[];
    for (const evidencePath of existingEvidence) {
      await access(evidencePath);
      expect(evidencePath).not.toBe(reviewPath);
    }

    const diagnosticPath = existingEvidence.find((evidencePath) =>
      evidencePath.includes('unparseable-invocation'),
    );
    expect(diagnosticPath, existingEvidence.join('\n')).toEqual(expect.any(String));
    const diagnostic = JSON.parse(await readFile(diagnosticPath as string, 'utf8')) as {
      kind?: string;
      task_id?: string;
      attempt?: number;
      role?: string;
      profile_id?: string;
      provider?: string;
      code?: string;
      parse_outcome?: string;
      stdout?: string;
      decision?: string;
    };
    expect(diagnostic).toMatchObject({
      kind: 'REVIEW_PARSE_FAILURE',
      task_id: 'T1',
      attempt: 1,
      role: 'reviewer',
      profile_id: PROFILE,
      code: 'REVIEW_VERDICT_NOT_PARSEABLE',
    });
    expect(diagnostic.decision).toBeUndefined();
    expect(diagnostic.parse_outcome).toEqual(expect.any(String));
    expect(diagnostic.provider).toEqual(expect.any(String));
    expect(diagnostic.stdout).toContain('reviewer prose without a verdict object');
    expect(diagnostic.stdout).not.toContain(leakedSecret);
    expect(diagnostic.stdout).toContain('[REDACTED:anthropic-api-key]');

    const state = await readState(fixture.paths);
    expect(state.tasks[0]).toMatchObject({ status: 'RUNNING', phase: 'FINALIZING', attempts: 1 });
    expect(await headSha(fixture.sandbox.root)).not.toBe(fixture.baseline);
  }, 90_000);

  it('exit não-zero do reviewer persiste stdout/stderr e não aponta review.json fantasma', async () => {
    const fixture = await setup();
    const loaded = await loadPlan(fixture.paths.planFile);
    const outside = await mkdtemp(path.join(os.tmpdir(), 'agentlab-review-exit1-'));
    roots.push(outside);
    const authorizationFile = path.join(outside, 'agentlab-run.yaml');
    await writeFile(authorizationFile, AUTHORIZATION.replace('risk: low', 'risk: high'), 'utf8');
    const authorization = await loadProjectRunAuthorization(authorizationFile);
    const leakedSecret = 'sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0123456789AA';
    const stdout = `{"is_error":true,"result":"Claude session limit reached ${leakedSecret}"}`;
    const controlPlane = await createProjectControlPlane({
      paths: fixture.paths,
      loaded,
      authorization: authorization.file,
      authorizationFile: authorization.source_file,
      historyLabRoot: outside,
      reviewerPort: {
        async run() {
          throw new ProviderRoleInvocationError({
            role: 'reviewer',
            exitCode: 1,
            stdout,
            stderr: '',
          });
        },
      },
    });
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

    expect(result.stop.status, JSON.stringify(result.payload, null, 2)).toBe('HUMAN_REQUIRED');
    expect(result.stop.reason).toContain('review independente não pôde ser concluída');
    expect(result.stop.reason).toContain('exit 1');

    const reviewPath = candidateReviewPath(fixture.paths, 'T1', 1);
    await expect(readCandidateReview(fixture.paths, 'T1', 1)).resolves.toBeNull();
    await expect(access(reviewPath)).rejects.toMatchObject({ code: 'ENOENT' });

    const evidencePaths = result.payload['evidence_paths'];
    expect(Array.isArray(evidencePaths) && evidencePaths.length > 0).toBe(true);
    const existingEvidence = evidencePaths as string[];
    for (const evidencePath of existingEvidence) {
      await access(evidencePath);
      expect(evidencePath).not.toBe(reviewPath);
    }
    const diagnosticPath = existingEvidence.find((evidencePath) =>
      evidencePath.includes('unparseable-invocation'),
    );
    expect(diagnosticPath, existingEvidence.join('\n')).toEqual(expect.any(String));
    const diagnostic = JSON.parse(await readFile(diagnosticPath as string, 'utf8')) as {
      kind?: string;
      code?: string;
      parse_outcome?: string;
      stdout?: string;
      decision?: string;
    };
    expect(diagnostic).toMatchObject({
      kind: 'REVIEW_PARSE_FAILURE',
      code: 'REVIEW_INVOCATION_FAILED',
      parse_outcome: 'INVOCATION_FAILED',
    });
    expect(diagnostic.decision).toBeUndefined();
    expect(diagnostic.stdout).toContain('session limit reached');
    expect(diagnostic.stdout).not.toContain(leakedSecret);
    expect(diagnostic.stdout).toContain('[REDACTED:anthropic-api-key]');
  }, 90_000);

  it('implementation defect sem autoridade BOUNDED_REPAIR não arquiva nem relança', async () => {
    const fixture = await setup();
    const loaded = await loadPlan(fixture.paths.planFile);
    const outside = await mkdtemp(path.join(os.tmpdir(), 'agentlab-review-no-authority-'));
    roots.push(outside);
    const authorizationFile = path.join(outside, 'agentlab-run.yaml');
    await writeFile(
      authorizationFile,
      AUTHORIZATION.replace('risk: low', 'risk: high').replace('  - BOUNDED_REPAIR\n', ''),
      'utf8',
    );
    const authorization = await loadProjectRunAuthorization(authorizationFile);
    let reviewerCalls = 0;
    const controlPlane = await createProjectControlPlane({
      paths: fixture.paths,
      loaded,
      authorization: authorization.file,
      authorizationFile: authorization.source_file,
      historyLabRoot: outside,
      reviewerPort: {
        async run() {
          reviewerCalls += 1;
          return JSON.stringify({
            decision: 'REJECT',
            rejection_disposition: 'IMPLEMENTATION_DEFECT',
            reason: 'defeito concreto',
          });
        },
      },
    });
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

    expect(result.stop.status).toBe('HUMAN_REQUIRED');
    expect(result.stop.reason).toContain('não autoriza bounded repair');
    expect(reviewerCalls).toBe(1);
    expect(await readReviewRejectedAttempt(fixture.paths, 'T1', 1)).toBeNull();
    expect((await readState(fixture.paths)).tasks[0]).toMatchObject({ attempts: 1, status: 'RUNNING' });
  }, 90_000);

  it('REJECT legado recebe classificação read-only fresca antes de qualquer repair', async () => {
    const fixture = await setup();
    const loaded = await loadPlan(fixture.paths.planFile);
    const outside = await mkdtemp(path.join(os.tmpdir(), 'agentlab-review-legacy-'));
    roots.push(outside);
    const authorizationFile = path.join(outside, 'agentlab-run.yaml');
    await writeFile(authorizationFile, AUTHORIZATION.replace('risk: low', 'risk: high'), 'utf8');
    const authorization = await loadProjectRunAuthorization(authorizationFile);
    const firstControlPlane = await createProjectControlPlane({
      paths: fixture.paths,
      loaded,
      authorization: authorization.file,
      authorizationFile: authorization.source_file,
      historyLabRoot: outside,
      reviewerPort: {
        async run() {
          return JSON.stringify({
            decision: 'REJECT',
            rejection_disposition: 'INSUFFICIENT_EVIDENCE',
            reason: 'review legado a classificar',
          });
        },
      },
    });
    const previousMode = process.env['AGENTLAB_FAKE_MODE'];
    process.env['AGENTLAB_FAKE_MODE'] = 'orchestrator-success';
    try {
      const first = await runOrchestrate({
        paths: fixture.paths,
        loaded,
        profileId: PROFILE,
        maxIterations: 1,
        controlPlane: firstControlPlane,
      });
      expect(first.stop.status).toBe('HUMAN_REQUIRED');

      const published = await readCandidateReview(fixture.paths, 'T1', 1);
      expect(published).not.toBeNull();
      const { rejection_disposition: _removed, ...legacy } = published!;
      await writeFile(
        candidateReviewPath(fixture.paths, 'T1', 1),
        `${JSON.stringify(legacy, null, 2)}\n`,
        'utf8',
      );

      let freshInvocations = 0;
      const resumedControlPlane = await createProjectControlPlane({
        paths: fixture.paths,
        loaded,
        authorization: authorization.file,
        authorizationFile: authorization.source_file,
        historyLabRoot: outside,
        reviewerPort: {
          async run(request) {
            freshInvocations += 1;
            if (request.prompt.includes('prior_rejection_reason')) {
              return JSON.stringify({
                decision: 'REJECT',
                rejection_disposition: 'IMPLEMENTATION_DEFECT',
                reason: 'classificação fresca do REJECT preservado',
              });
            }
            return JSON.stringify({
              decision: 'ACCEPT',
              reason: 'repair satisfaz acceptance',
              coverage: {
                files: ['src/t1.txt'],
                validations: [['test', '-f', 'src/t1.txt']],
                behaviors: ['arquivo requerido existe'],
                handoff_gaps: [],
              },
            });
          },
        },
      });
      const inbox = path.join(fixture.paths.inboxDir, 'T1');
      const reportBytes = await readFile(path.join(inbox, 'report.json'));
      const handoffBytes = await readFile(path.join(inbox, 'handoff-draft.json'));
      await rm(inbox, { recursive: true, force: true });
      await expect(
        runOrchestrate({
          paths: fixture.paths,
          loaded,
          profileId: PROFILE,
          maxIterations: 1,
          controlPlane: resumedControlPlane,
        }),
      ).rejects.toThrow('output do worker ausente no inbox e no archive');
      expect(freshInvocations).toBe(1);
      await mkdir(inbox, { recursive: true });
      await writeFile(path.join(inbox, 'report.json'), reportBytes);
      await writeFile(path.join(inbox, 'handoff-draft.json'), handoffBytes);

      const resumed = await runOrchestrate({
        paths: fixture.paths,
        loaded,
        profileId: PROFILE,
        maxIterations: 1,
        controlPlane: resumedControlPlane,
      });

      expect(resumed.stop.status, JSON.stringify(resumed, null, 2)).toBe('ALL_DONE');
      expect(freshInvocations).toBe(2);
      expect(await readReviewRejectionClassification(fixture.paths, 'T1', 1)).toMatchObject({
        disposition: 'IMPLEMENTATION_DEFECT',
        classifier_profile_id: PROFILE,
        classifier_invocation: { workspace_access: 'READ_ONLY', fresh_context: true },
      });
      expect((await readState(fixture.paths)).tasks[0]).toMatchObject({ status: 'PASS', attempts: 2 });
    } finally {
      if (previousMode === undefined) delete process.env['AGENTLAB_FAKE_MODE'];
      else process.env['AGENTLAB_FAKE_MODE'] = previousMode;
    }
  }, 90_000);

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
