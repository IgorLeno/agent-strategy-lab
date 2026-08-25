/**
 * Control plane de runs de projeto externo: contrato de autorização, derivação
 * de capability, construção da work unit a partir do PlanFile confiável,
 * overlay read-only do worker falso e a separação entre HARNESS
 * SELF-MAINTENANCE e PROJECT REMEDIATION.
 *
 * Nenhum provider real e nenhum projeto real: os únicos perfis usados apontam
 * para `fixtures/fake-worker.mjs`.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CapabilityRegistry,
  capabilityOf,
  routeInitialProfileWithHistory,
} from '../../src/routing/index.js';
import { assessExecution } from '../../src/planner/assess.js';
import { EvaluationOutcome, QualificationStatus } from '../../src/core/index.js';
import { AttemptRole, queryPerformanceHistory } from '../../src/performance/index.js';
import { RunIndex, verifyRunIntegrity } from '../../src/storage/index.js';
import { EvaluationRecord, InterventionType, type InterventionRecord } from '../../src/schemas/index.js';
import { resolveHarnessInstallationRoot, resolveHarnessPaths } from '../../dev/lib/paths.js';
import { loadProfileFromCatalog, LauncherProfile } from '../../dev/lib/profile.js';
import {
  assertReadOnlyArgv,
  buildRoleArgv,
  FAKE_READ_ONLY_FLAG,
} from '../../dev/lib/project-roles.js';
import {
  classificationFor,
  loadProjectRunAuthorization,
  ProjectAuthorizationError,
  ProjectRunAuthorizationFile,
} from '../../dev/lib/project-authorization.js';
import { buildWorkUnitFromPlan, capabilityInputOf } from '../../dev/lib/project-run.js';
import {
  materializeCanonicalProjectAttempt,
  observedTokensOf,
  projectProfileFingerprint,
  projectWorkDefinitionFingerprint,
  queryCanonicalProjectHistory,
} from '../../dev/lib/project-history.js';
import type { CommandRunner } from '../../dev/lib/billing.js';
import {
  collectProjectLaunchFacts,
  escalationPreflightOf,
  evidenceOf,
  quotaFactOf,
  type ProjectLaunchFacts,
} from '../../dev/lib/project-preflight.js';
import { launchRecordPath } from '../../dev/lib/records.js';
import { CandidateReviewRecord, LaunchRecord, PlanTask } from '../../dev/lib/schemas.js';
import {
  resolveRoutinePreflight,
  type RoutineAutonomyDriver,
  type RoutineCandidate,
  type RoutineIncidentContext,
} from '../../dev/lib/routine-autonomy.js';
import type { PreflightResult } from '../../dev/lib/orchestrate-preflight.js';
import { REPO_ROOT } from './helpers.js';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temporaryDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentlab-project-run-'));
  created.push(dir);
  return dir;
}

const AUTHORIZATION_YAML = [
  'schema_version: 1',
  'requested_scope:',
  '  summary: escopo declarado explicitamente pela run',
  'autonomous_execution_boundary:',
  '  - CONFIGURED_SUBSCRIPTION_WORKER',
  '  - DETERMINISTIC_VALIDATION',
  'human_gated_capabilities:',
  '  - UNAUTHORIZED_API_BILLING',
  '  - SCOPE_EXPANSION',
  'billing:',
  '  allowed_billing_modes: [not_applicable]',
  'profile_policy:',
  '  id: fake-policy',
  '  allowed_providers: [fake]',
  '  profiles:',
  '    - id: fake-worker-economy-v1',
  '      capability_rank: 0',
  '      rationale: baseline configurado',
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
  '  overrides:',
  '    T2:',
  '      risk: medium',
  '',
].join('\n');

async function writeAuthorization(contents: string): Promise<string> {
  const dir = await temporaryDir();
  const file = path.join(dir, 'agentlab-run.yaml');
  await writeFile(file, contents, 'utf8');
  return file;
}

/**
 * LaunchRecord mínimo com observação de rate limit — evidência gravada por um
 * launch anterior, exatamente como o launcher a grava. Nenhum provider é
 * chamado para produzi-la.
 */
async function writeRateLimitedLaunchRecord(
  paths: ReturnType<typeof resolveHarnessPaths>,
  profileId: string,
  observation: { readonly status: string; readonly resetsAt: string | number },
): Promise<void> {
  await mkdir(paths.logsDir, { recursive: true });
  await writeFile(
    launchRecordPath(paths, 'T1'),
    JSON.stringify({
      schema_version: 1,
      task_id: 'T1',
      profile_id: profileId,
      argv: ['claude', '--print'],
      process: {
        pid: 1,
        pgid: 1,
        started_at: '2029-01-01T00:00:00.000Z',
        proc_start_ticks: 0,
        command_sha256: '0'.repeat(64),
      },
      launch_id: '00000000-0000-4000-8000-000000000000',
      started_at: '2029-01-01T00:00:00.000Z',
      finished_at: '2029-01-01T00:01:00.000Z',
      duration_ms: 60_000,
      exit_code: 0,
      timed_out: false,
      controlled: {},
      rate_limit_observations: {
        source: 'claude_stream_json',
        observed: [
          {
            sequence: 1,
            status: observation.status,
            rate_limit_type: 'five_hour',
            utilization: 100,
            utilization_scale: 'percentage',
            utilization_percentage: 100,
            resets_at: observation.resetsAt,
            session_id: null,
            raw: {},
          },
        ],
        window_deltas: [],
      },
    }),
    'utf8',
  );
}

describe('contrato de autorização da run', () => {
  it('separa work definition de execution authorization e aplica overrides por task', async () => {
    const loaded = await loadProjectRunAuthorization(await writeAuthorization(AUTHORIZATION_YAML));
    expect(loaded.file.profile_policy.id).toBe('fake-policy');
    expect(classificationFor(loaded.file, 'T1').classification.risk).toBe('low');
    expect(classificationFor(loaded.file, 'T1').provenance).toBe('authorization.work_units.default');
    expect(classificationFor(loaded.file, 'T2').classification.risk).toBe('medium');
    expect(classificationFor(loaded.file, 'T2').provenance).toContain('overrides.T2');
    // O override não apaga o resto do default.
    expect(classificationFor(loaded.file, 'T2').classification.task_class).toBe('feature');
  });

  it('recusa cobrança por API: nenhum arquivo de run autoriza categoria human-gated', () => {
    const parsed = ProjectRunAuthorizationFile.safeParse({
      ...(ProjectRunAuthorizationFile.parse(
        JSON.parse(JSON.stringify(minimalAuthorizationObject())),
      ) as unknown as Record<string, unknown>),
      billing: { allowed_billing_modes: ['api'] },
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed)).toContain('cobrança por API é human-gated');
  });

  it('arquivo ausente vira erro estruturado, nunca autorização parcial', async () => {
    await expect(
      loadProjectRunAuthorization(path.join(await temporaryDir(), 'nao-existe.yaml')),
    ).rejects.toBeInstanceOf(ProjectAuthorizationError);
  });

  it('classificação ausente é recusada: o harness nunca inventa risco', () => {
    const object = minimalAuthorizationObject() as Record<string, unknown>;
    const units = object['work_units'] as { default: Record<string, unknown> };
    delete units.default['risk'];
    const parsed = ProjectRunAuthorizationFile.safeParse(object);
    expect(parsed.success).toBe(false);
  });

  it('reviewer fora da policy é recusado antes de qualquer execução', () => {
    const object = minimalAuthorizationObject() as Record<string, unknown>;
    object['review'] = { reviewer_profile_id: 'profile-nao-declarado-v1' };
    const parsed = ProjectRunAuthorizationFile.safeParse(object);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed)).toContain('não pertence à profile policy');
  });
});

function minimalAuthorizationObject(): unknown {
  return {
    schema_version: 1,
    requested_scope: { summary: 'escopo declarado' },
    constraints: [],
    exclusions: [],
    autonomous_execution_boundary: ['CONFIGURED_SUBSCRIPTION_WORKER'],
    human_gated_capabilities: ['UNAUTHORIZED_API_BILLING'],
    billing: { allowed_billing_modes: ['not_applicable'] },
    profile_policy: {
      id: 'fake-policy',
      allowed_providers: ['fake'],
      profiles: [{ id: 'fake-worker-economy-v1', capability_rank: 0, rationale: 'baseline' }],
    },
    work_units: {
      default: {
        task_class: 'feature',
        difficulty_declared: 'easy',
        risk: 'low',
        complexity: 'local',
        ambiguity: 'low',
        verification: 'deterministic',
        resource_envelope: {
          duration_ms: { expected: 20000, maximum: 60000 },
          tokens: { expected: 30000, maximum: 90000 },
          changed_files: { expected: 3, maximum: 8 },
        },
      },
      overrides: {},
    },
  };
}

// ---------------------------------------------------------------------------
// Fatos de credencial e quota: nada aqui chama provider real. O probe de
// credencial roda com um `CommandRunner` injetado, e a quota é derivada de
// evidência já gravada em disco.
// ---------------------------------------------------------------------------

const CLAUDE_LIKE_PROFILE = LauncherProfile.parse({
  id: 'claude-fatos-de-teste-v1',
  agent: 'claude',
  billing_mode: 'subscription_only',
  commit_owner: 'orchestrator',
  official_validation_owner: 'orchestrator',
  worker_validation_policy: 'targeted',
  argv: ['claude', '--print'],
  prompt_delivery: 'argv',
  forbidden_flags: [],
  env_allowlist: ['PATH', 'HOME'],
});

function runnerReturning(output: string): CommandRunner {
  return async () => ({ code: 0, output });
}

async function factsFor(
  profile: LauncherProfile,
  options: { readonly runner?: CommandRunner; readonly now?: () => Date } = {},
): Promise<ProjectLaunchFacts> {
  const repoRoot = await temporaryDir();
  return collectProjectLaunchFacts({
    paths: resolveHarnessPaths(repoRoot),
    profile,
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

describe('proveniência de credencial e quota', () => {
  it('A — credencial PROVEN TRUE quando o probe local prova a assinatura', async () => {
    const facts = await factsFor(CLAUDE_LIKE_PROFILE, {
      runner: runnerReturning(
        JSON.stringify({
          loggedIn: true,
          authMethod: 'claude.ai',
          apiProvider: 'firstParty',
          subscriptionType: 'max',
        }),
      ),
    });
    expect(facts.credential.availability).toBe(true);
    expect(evidenceOf(facts.credential)).toBe('PROVEN_TRUE');
    expect(facts.credential.provenance).toContain('claude_subscription_oauth');
  });

  it('A — worker falso é PROVEN TRUE por não falar com provider nenhum', async () => {
    const profile = await loadProfileFromCatalog(
      resolveHarnessInstallationRoot(),
      'fake-worker-economy-v1',
    );
    const facts = await factsFor(profile);
    expect(facts.credential.availability).toBe(true);
    expect(facts.credential.provenance).toContain('não fala com provider nenhum');
  });

  it('B — credencial PROVEN FALSE quando o probe prova fonte de API', async () => {
    const facts = await factsFor(CLAUDE_LIKE_PROFILE, {
      runner: runnerReturning(
        JSON.stringify({ loggedIn: true, authMethod: 'apiKey', apiProvider: 'console' }),
      ),
    });
    expect(facts.credential.availability).toBe(false);
    expect(evidenceOf(facts.credential)).toBe('PROVEN_FALSE');
    // O preflight canônico recusa pelo mesmo fato: as duas camadas concordam.
    expect(facts.provider.availability).toBe(false);
  });

  it('C — credencial UNKNOWN quando o probe não prova nada, e UNKNOWN não vira TRUE', async () => {
    for (const output of ['', 'saída que não é JSON', JSON.stringify({ loggedIn: false })]) {
      const facts = await factsFor(CLAUDE_LIKE_PROFILE, { runner: runnerReturning(output) });
      expect(facts.credential.availability).toBeNull();
      expect(evidenceOf(facts.credential)).toBe('UNKNOWN');
    }
  });

  it('E — quota UNKNOWN sem observação, e nenhum probe pago é executado para sabê-la', async () => {
    const facts = await factsFor(CLAUDE_LIKE_PROFILE, {
      runner: runnerReturning(JSON.stringify({ loggedIn: false })),
    });
    expect(facts.quota.availability).toBeNull();
    expect(evidenceOf(facts.quota)).toBe('UNKNOWN');
    expect(facts.quota.provenance).toContain('não é probada antes do launch');
  });

  it('D — quota PROVEN FALSE com recusa observada e janela ainda aberta', async () => {
    const repoRoot = await temporaryDir();
    const paths = resolveHarnessPaths(repoRoot);
    await writeRateLimitedLaunchRecord(paths, CLAUDE_LIKE_PROFILE.id, {
      status: 'rejected',
      resetsAt: '2030-01-01T00:00:00.000Z',
    });

    const fact = await quotaFactOf({
      paths,
      profile: CLAUDE_LIKE_PROFILE,
      now: () => new Date('2029-12-31T23:00:00.000Z'),
    });
    expect(fact.availability).toBe(false);
    expect(fact.provenance).toContain('2030-01-01T00:00:00.000Z');
  });

  it('E — janela já resetada volta a UNKNOWN: reset não prova quota suficiente', async () => {
    const repoRoot = await temporaryDir();
    const paths = resolveHarnessPaths(repoRoot);
    await writeRateLimitedLaunchRecord(paths, CLAUDE_LIKE_PROFILE.id, {
      status: 'rejected',
      resetsAt: '2030-01-01T00:00:00.000Z',
    });

    const fact = await quotaFactOf({
      paths,
      profile: CLAUDE_LIKE_PROFILE,
      now: () => new Date('2030-01-01T01:00:00.000Z'),
    });
    expect(fact.availability).toBeNull();
    expect(fact.provenance).toContain('já resetou');
  });

  it('E — reset não datável nunca vira quota insuficiente nem suficiente', async () => {
    const repoRoot = await temporaryDir();
    const paths = resolveHarnessPaths(repoRoot);
    await writeRateLimitedLaunchRecord(paths, CLAUDE_LIKE_PROFILE.id, {
      status: 'rejected',
      resetsAt: 1893456000,
    });

    const fact = await quotaFactOf({ paths, profile: CLAUDE_LIKE_PROFILE });
    expect(fact.availability).toBeNull();
    expect(fact.provenance).toContain('não é datável');
  });

  it('E — observação sem recusa continua UNKNOWN: ausência de recusa não é prova', async () => {
    const repoRoot = await temporaryDir();
    const paths = resolveHarnessPaths(repoRoot);
    await writeRateLimitedLaunchRecord(paths, CLAUDE_LIKE_PROFILE.id, {
      status: 'allowed',
      resetsAt: '2030-01-01T00:00:00.000Z',
    });

    const fact = await quotaFactOf({ paths, profile: CLAUDE_LIKE_PROFILE });
    expect(fact.availability).toBeNull();
    expect(fact.provenance).toContain('ausência de recusa não prova');
  });

  it('F — a evidência da escalation reusa os MESMOS fatos, sem segundo preflight', async () => {
    const facts = await factsFor(CLAUDE_LIKE_PROFILE, {
      runner: runnerReturning(JSON.stringify({ loggedIn: false })),
    });
    const preflight = escalationPreflightOf(CLAUDE_LIKE_PROFILE, facts);
    expect(preflight.credential_availability.value).toBeNull();
    expect(preflight.credential_availability.provenance).toBe(facts.credential.provenance);
    expect(preflight.real_execution_authorization.quota.availability.value).toBeNull();

    const insufficient = escalationPreflightOf(CLAUDE_LIKE_PROFILE, {
      ...facts,
      quota: { availability: false, provenance: 'provider recusou por limite' },
    });
    expect(insufficient.real_execution_authorization.quota.availability.value).toBe('INSUFFICIENT');
  });
});

describe('capability de profile para routing real', () => {
  it('perfil falso sem test_double_of continua sem modelo e fora do routing', async () => {
    const profile = await loadProfileFromCatalog(resolveHarnessInstallationRoot(), 'fake-worker-v1');
    const capability = capabilityOf(capabilityInputOf(profile));
    expect(capability.model).toBe('not_applicable');
    expect(capability.role_compatibility.implementer.value).toBeNull();
  });

  it('perfil falso com test_double_of representa a capability declarada', async () => {
    const profile = await loadProfileFromCatalog(
      resolveHarnessInstallationRoot(),
      'fake-worker-advanced-v1',
    );
    expect(profile.agent).toBe('fake');
    expect(profile.billing_mode).toBe('not_applicable');
    const capability = capabilityOf(capabilityInputOf(profile));
    expect(capability.agent).toBe('codex');
    expect(capability.model).toBe('gpt-5.6-sol');
    expect(capability.reasoning_effort).toBe('high');
    expect(capability.role_compatibility.implementer.value).toBe(true);
  });

  it('perfil REAL não pode declarar capability que o argv não prova', () => {
    const parsed = LauncherProfile.safeParse({
      id: 'codex-mentiroso-v1',
      agent: 'codex',
      billing_mode: 'subscription_only',
      argv: ['codex', 'exec'],
      prompt_delivery: 'stdin',
      forbidden_flags: [],
      env_allowlist: ['PATH'],
      test_double_of: { agent: 'codex', model: 'gpt-5.6-sol', reasoning_effort: 'max' },
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed)).toContain('test_double_of só existe em perfil fake');
  });

  it('capability real continua derivada do argv versionado, sem duplicar o doctor', async () => {
    const profile = await loadProfileFromCatalog(
      resolveHarnessInstallationRoot(),
      'codex-build-worker-subscription-sol-medium-v2',
    );
    const capability = capabilityOf(capabilityInputOf(profile));
    expect(capability.agent).toBe('codex');
    expect(capability.model).toBe('gpt-5.6-sol');
    expect(capability.reasoning_effort).toBe('medium');
    expect(capability.billing_mode).toBe('subscription_only');
  });
});

describe('overlay read-only estrutural do worker falso', () => {
  it('reviewer falso recebe a flag no argv e a prova depois do fato', async () => {
    const profile = await loadProfileFromCatalog(
      resolveHarnessInstallationRoot(),
      'fake-worker-economy-v1',
    );
    const overlay = buildRoleArgv(profile, { role: 'reviewer', prompt: 'packet' });
    expect(overlay.workspace_access).toBe('READ_ONLY');
    expect(overlay.argv).toContain(FAKE_READ_ONLY_FLAG);
    expect(overlay.mechanism).toContain(FAKE_READ_ONLY_FLAG);
    expect(() => assertReadOnlyArgv('reviewer', 'fake', overlay.argv)).not.toThrow();
  });

  it('implementer falso NÃO recebe a flag: a fronteira é por role, não por agente', async () => {
    const profile = await loadProfileFromCatalog(
      resolveHarnessInstallationRoot(),
      'fake-worker-economy-v1',
    );
    const overlay = buildRoleArgv(profile, { role: 'implementer', prompt: 'packet' });
    expect(overlay.workspace_access).toBe('MUTATION_IN_AUTHORIZED_WORKSPACE');
    expect(overlay.argv).not.toContain(FAKE_READ_ONLY_FLAG);
    expect(() => assertReadOnlyArgv('reviewer', 'fake', overlay.argv)).toThrow(
      /não prova overlay read-only/,
    );
  });
});

describe('work unit a partir do PlanFile confiável', () => {
  const inspection = {
    schema_version: 1 as const,
    repo_root: '/target',
    inspected_at: '2026-08-19T00:00:00.000Z',
    git: {
      known: true as const,
      value: { head_sha: 'a'.repeat(40), branch: 'main', dirty: false, remotes: [] },
      provenance: 'git',
    },
    stack: {
      known: true as const,
      value: { primary_ecosystem: 'node', ecosystems_detected: ['node'] },
      provenance: 'package.json',
    },
    package_manager: { known: true as const, value: 'pnpm', provenance: 'lock' },
    build_system: { known: true as const, value: 'typescript', provenance: 'tsconfig' },
    directories: [{ path: 'src', role: 'source' as const }],
    tests: {
      known: true as const,
      value: { framework: 'vitest', test_directories: ['test'] },
      provenance: 'pkg',
    },
    validation_command_candidates: [
      { name: 'typecheck', command: 'true', source: 'package.json:scripts' as const },
    ],
    dependencies_state: {
      known: true as const,
      value: { lockfile_path: 'pnpm-lock.yaml', installed: true },
      provenance: 'fs',
    },
    required_tools: [{ name: 'node', reason: 'runtime', source: 'package.json:engines' as const }],
    required_services: [],
    filesystem_permissions: {
      known: true as const,
      value: { readable: true, writable: true },
      provenance: 'fs',
    },
    feedback_sources: [],
    project_instructions: [
      { path: 'CLAUDE.md', scope: 'root' as const, relevance: 'general' as const },
    ],
    source_anchors: [
      { area: 'greet', path: 'src/greet.ts' },
      { area: 'outra', path: 'src/outra.ts' },
    ],
    relevant_files: ['src/greet.ts'],
    risks: [],
  };

  const classification = {
    task_class: 'feature' as const,
    difficulty_declared: 'easy' as const,
    risk: 'low' as const,
    complexity: 'local' as const,
    ambiguity: 'low' as const,
    verification: 'deterministic' as const,
    resource_envelope: {
      duration_ms: { expected: 20_000, maximum: 60_000 },
      tokens: { expected: 30_000, maximum: 90_000 },
      changed_files: { expected: 3, maximum: 8 },
    },
  };

  const planTask = {
    id: 'T1',
    title: 'work unit',
    blocked_by: [],
    objective: 'objetivo declarado pelo usuário',
    initial_files: ['src/greet.ts'],
    acceptance: ['critério declarado pelo usuário'],
    validation: [{ argv: ['pnpm', 'test'], timeout_seconds: 30 }],
    constraints: [],
    include_previous_handoff: false,
  };

  it('acceptance, validation e dependências entram VERBATIM do PlanFile', () => {
    const built = buildWorkUnitFromPlan({ planTask, inspection, classification });
    expect(built.task.objective).toBe('objetivo declarado pelo usuário');
    expect(built.task.acceptance).toEqual(['critério declarado pelo usuário']);
    expect(built.task.validation).toEqual([{ argv: ['pnpm', 'test'], timeout_seconds: 30 }]);
    expect(built.provenance).toContain('work_definition=plan_file');
  });

  it('context_scope vem dos source anchors OBSERVADOS que cobrem os initial_files', () => {
    const built = buildWorkUnitFromPlan({ planTask, inspection, classification });
    expect(built.task.context_scope.areas).toEqual(['greet']);
    expect(built.provenance.join(' ')).toContain('inspection.source_anchors ∩ plan.initial_files');
  });

  it('validation_budget é derivado dos timeouts declarados, não estimado', () => {
    const built = buildWorkUnitFromPlan({
      planTask: {
        ...planTask,
        validation: [
          { argv: ['a'], timeout_seconds: 30 },
          { argv: ['b'], timeout_seconds: 15 },
        ],
      },
      inspection,
      classification,
    });
    expect(built.task.validation_budget).toEqual({ expected: 45_000, maximum: 45_000 });
  });

  it('repositório greenfield (sem source anchors) usa a fronteira declarada pela própria task', () => {
    const built = buildWorkUnitFromPlan({
      planTask,
      inspection: { ...inspection, source_anchors: [] },
      classification,
    });
    expect(built.task.context_scope.areas).toEqual(['src']);
    expect(built.provenance.join(' ')).toContain('plan.initial_files');
  });

  it('plano manual sem planner_metadata continua usando a classificação da autorização', () => {
    const built = buildWorkUnitFromPlan({ planTask, inspection, classification });
    expect(built.task.risk).toBe(classification.risk);
    expect(built.task.taxonomy.task_class).toBe(classification.task_class);
    expect(built.task.resource_envelope).toEqual(classification.resource_envelope);
    expect(built.provenance.join(' ')).toContain('taxonomy/risk/resource_envelope=authorization.work_units');
  });

  it('plano gerado com planner_metadata usa a classificação do planner, não o default da autorização', () => {
    const plannerMetadata = {
      taxonomy: {
        version: 1 as const,
        task_class: 'chore' as const,
        difficulty_declared: 'easy' as const,
        complexity: 'local' as const,
        ambiguity: 'low' as const,
        verification: 'deterministic' as const,
      },
      risk: 'medium' as const,
      probable_files: ['src/greet.ts'],
      context_scope: { areas: ['bootstrap'] },
      context_requirements: [{ description: 'README do projeto', source_anchor: 'README.md' }],
      environment_requirements: [{ kind: 'tool' as const, name: 'pnpm', reason: 'toolchain' }],
      estimated_duration: { expected: 120_000, maximum: 300_000 },
      validation_budget: { expected: 30_000, maximum: 60_000 },
      resource_envelope: {
        duration_ms: { expected: 120_000, maximum: 300_000 },
        tokens: { expected: 10_000, maximum: 25_000 },
        changed_files: { expected: 2, maximum: 5 },
      },
    };
    const built = buildWorkUnitFromPlan({
      planTask: { ...planTask, planner_metadata: plannerMetadata },
      inspection,
      classification,
    });
    expect(built.task.risk).toBe('medium');
    expect(built.task.taxonomy).toEqual(plannerMetadata.taxonomy);
    expect(built.task.resource_envelope).toEqual(plannerMetadata.resource_envelope);
    expect(built.task.estimated_duration).toEqual(plannerMetadata.estimated_duration);
    expect(built.task.validation_budget).toEqual(plannerMetadata.validation_budget);
    expect(built.task.context_scope.areas).toEqual(['bootstrap']);
    expect(built.task.probable_files).toEqual(['src/greet.ts']);
    expect(built.provenance.join(' ')).toContain('taxonomy/risk/resource_envelope=plan.planner_metadata');
    expect(built.task.risk).not.toBe(classification.risk);
  });
});

// ---------------------------------------------------------------------------
// Harness self-maintenance vs project remediation.
// ---------------------------------------------------------------------------

const BLOCKED_PREFLIGHT: PreflightResult = {
  status: 'BLOCKED',
  maintenance: {
    status: 'NOOP',
    previous_authorized_head_sha: '4'.repeat(40),
    authorized_head_sha: '4'.repeat(40),
    commit_count: 0,
    adoption_kind: null,
    commits: [],
    validation_results: [],
    reason: null,
  },
  recover: null,
  next: null,
  blocker: 'HISTORICAL_GAP',
  reason: 'gap histórico mecânico',
};

class RecordingDriver implements RoutineAutonomyDriver {
  readonly calls: string[] = [];
  async recover(actionId: string) {
    this.calls.push(actionId);
    return { action: 'recover' };
  }
  async maintain(actionId: string): Promise<RoutineCandidate> {
    this.calls.push(actionId);
    throw new Error('maintainer não deveria ter sido chamado');
  }
  async review(actionId: string) {
    this.calls.push(actionId);
    return { decision: 'ACCEPT' as const, reason: 'n/a' };
  }
  async adopt(actionId: string) {
    this.calls.push(actionId);
    return { authorized_head_after: '5'.repeat(40), official_primitive: true as const };
  }
  async retryPreflight(actionId: string): Promise<PreflightResult> {
    this.calls.push(actionId);
    return BLOCKED_PREFLIGHT;
  }
}

function maintenanceIncident(): RoutineIncidentContext {
  return {
    preflight: BLOCKED_PREFLIGHT,
    authorized_head_before: '4'.repeat(40),
    task_id: 'T1',
    attempt: 1,
    lifecycle_records: ['ProtocolInvalidAttemptRecord'],
  };
}

describe('harness self-maintenance nunca é aplicada num repositório alvo', () => {
  it('fail-closed: sem prova de identidade do harness, a maintenance não roda', async () => {
    const paths = resolveHarnessPaths(await temporaryDir());
    const driver = new RecordingDriver();

    const result = await resolveRoutinePreflight({
      paths,
      incident: maintenanceIncident(),
      driver,
      harnessSelfMaintenance: {
        allowed: false,
        reason: 'repoRoot difere da instalação do harness',
      },
    });

    expect(result.status).toBe('HUMAN_REQUIRED');
    expect(result.human_required?.why_automation_stopped).toContain('HARNESS SELF-MAINTENANCE');
    expect(result.human_required?.why_automation_stopped).toContain(
      'Remediação de projeto pertence ao alvo',
    );
    expect(driver.calls.some((call) => call.includes('maintain'))).toBe(false);
  });

  it('o comportamento histórico do próprio lab permanece: identidade provada libera a recipe', async () => {
    const paths = resolveHarnessPaths(await temporaryDir());
    const driver = new RecordingDriver();

    const result = await resolveRoutinePreflight({
      paths,
      incident: maintenanceIncident(),
      driver,
      harnessSelfMaintenance: {
        allowed: true,
        reason: 'repositório conduzido é a própria instalação do harness',
      },
    });

    // A recipe roda: o maintainer é chamado (e o duplo recusa de propósito),
    // provando que o gate anterior era a única coisa impedindo a maintenance.
    expect(result.status).toBe('HUMAN_REQUIRED');
    expect(driver.calls.some((call) => call.includes('maintain'))).toBe(true);
  });

  it('o orquestrador calcula a identidade a partir da instalação, não do cwd', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(path.join(REPO_ROOT, 'dev/lib/orchestrate.ts'), 'utf8');
    expect(source).toContain('resolveHarnessInstallationRoot()');
    expect(source).toContain('harnessSelfMaintenance');
    expect(source).toMatch(/paths\.repoRoot === harnessRoot/);
  });
});

describe('policies versionadas do repositório', () => {
  it.each([
    'docs/agentlab-run.example.yaml',
    'docs/agentlab-run.codex-sol-medium-only.yaml',
  ])('%s satisfaz o contrato e só declara profiles que existem no catálogo', async (relative) => {
    const loaded = await loadProjectRunAuthorization(path.join(REPO_ROOT, relative));
    expect(loaded.file.billing.allowed_billing_modes).not.toContain('api');
    for (const entry of loaded.file.profile_policy.profiles) {
      const profile = await loadProfileFromCatalog(resolveHarnessInstallationRoot(), entry.id);
      expect(profile.id).toBe(entry.id);
      expect(loaded.file.billing.allowed_billing_modes).toContain(profile.billing_mode);
      expect(profile.commit_owner).toBe('orchestrator');
      expect(profile.official_validation_owner).toBe('orchestrator');
    }
  });

  it('a policy do benchmark A/B fixa exatamente um profile Codex Sol Medium', async () => {
    const loaded = await loadProjectRunAuthorization(
      path.join(REPO_ROOT, 'docs/agentlab-run.codex-sol-medium-only.yaml'),
    );
    expect(loaded.file.profile_policy.id).toBe('codex-sol-medium-only');
    expect(loaded.file.profile_policy.profiles.map((entry) => entry.id)).toEqual([
      'codex-build-worker-subscription-sol-medium-v2',
    ]);
    // Sem degrau seguinte, nenhuma troca de modelo/provider é possível.
    expect(loaded.file.autonomous_execution_boundary).not.toContain(
      'CAPABILITY_ESCALATION_WITHIN_LADDER',
    );
    expect(loaded.file.autonomous_execution_boundary).not.toContain(
      'CROSS_PROVIDER_WITHIN_ALLOWED_SUBSCRIPTION_PROFILES',
    );
  });
});

const HISTORY_PROFILE_A = LauncherProfile.parse({
  id: 'fake-history-a',
  agent: 'fake',
  billing_mode: 'not_applicable',
  environment_mode: 'controlled',
  instruction_environment: 'sanitized_user_home',
  commit_owner: 'orchestrator',
  official_validation_owner: 'orchestrator',
  worker_validation_policy: 'targeted',
  argv: ['node', 'fake-worker.mjs'],
  prompt_delivery: 'argv',
  forbidden_flags: [],
  env_allowlist: ['PATH'],
  test_double_of: {
    agent: 'codex',
    model: 'gpt-5.6-sol',
    reasoning_effort: 'medium',
    sandbox: 'workspace-write',
  },
});

const HISTORY_PROFILE_B = LauncherProfile.parse({
  ...HISTORY_PROFILE_A,
  id: 'fake-history-b',
  test_double_of: { ...HISTORY_PROFILE_A.test_double_of!, model: 'gpt-5.6-terra' },
});

const HISTORY_TASK = PlanTask.parse({
  id: 'T-HISTORY',
  title: 'History fixture',
  blocked_by: [],
  objective: 'Implementar a mudança observável',
  initial_files: ['src/index.ts'],
  acceptance: ['validação oficial passa'],
  validation: [{ argv: ['pnpm', 'typecheck'], timeout_seconds: 60 }],
  constraints: [],
  include_previous_handoff: false,
});

const HISTORY_CLASSIFICATION = classificationFor(
  ProjectRunAuthorizationFile.parse(minimalAuthorizationObject()),
  HISTORY_TASK.id,
).classification;

function historyInspection(repoRoot: string) {
  return {
    schema_version: 1 as const,
    repo_root: repoRoot,
    inspected_at: '2026-08-20T10:00:00.000Z',
    git: { known: true as const, value: { head_sha: 'a'.repeat(40), branch: 'main', dirty: false, remotes: [] }, provenance: 'fixture.git' },
    stack: { known: true as const, value: { primary_ecosystem: 'node', ecosystems_detected: ['node'] }, provenance: 'fixture.package' },
    package_manager: { known: true as const, value: 'pnpm', provenance: 'fixture.lockfile' },
    build_system: { known: true as const, value: 'typescript', provenance: 'fixture.tsconfig' },
    directories: [],
    tests: { known: true as const, value: { framework: 'vitest', test_directories: ['test'] }, provenance: 'fixture.tests' },
    validation_command_candidates: [
      { name: 'typecheck', command: 'pnpm typecheck', source: 'package.json:scripts' as const },
    ],
    dependencies_state: { known: true as const, value: { lockfile_path: 'pnpm-lock.yaml', installed: true }, provenance: 'fixture.dependencies' },
    required_tools: [],
    required_services: [],
    filesystem_permissions: { known: true as const, value: { readable: true, writable: true }, provenance: 'fixture.fs' },
    feedback_sources: [],
    project_instructions: [{ path: 'CLAUDE.md', scope: 'root' as const, relevance: 'general' as const }],
    source_anchors: [{ area: 'index', path: 'src/index.ts' }],
    relevant_files: ['src/index.ts'],
    risks: [],
  };
}

function historyLaunch(options: {
  readonly taskId: string;
  readonly attempt: number;
  readonly apiEquivalent?: number | null;
  readonly durationMs?: number;
  readonly quotaPp?: number | null;
  /** Contagem reportada pelo provider; `null` reproduz um record sem stream. */
  readonly observedTokensTotal?: number | null;
}) {
  const minute = String(options.attempt).padStart(2, '0');
  const apiEquivalent = options.apiEquivalent === undefined ? 1 : options.apiEquivalent;
  const durationMs = options.durationMs ?? 1_000;
  const quotaPp = options.quotaPp === undefined ? 1 : options.quotaPp;
  const probe = {
    available: true,
    zero_inference_verified: false,
    reason_code: 'OK' as const,
    reason: null,
    result_text_sha256: '1'.repeat(64),
    command: 'usage',
    exit_code: 0,
  };
  const window = (consumed: number) => ({
    before_used_pct: 10,
    after_used_pct: 10 + consumed,
    before_reset_label: 'reset',
    after_reset_label: 'reset',
    same_window: true,
    consumed_pp: consumed,
    window_match_method: 'exact' as const,
    reason_code: 'OK' as const,
  });
  return LaunchRecord.parse({
    schema_version: 1,
    task_id: options.taskId,
    profile_id: HISTORY_PROFILE_A.id,
    argv: ['node', 'fake-worker.mjs'],
    process: { pid: options.attempt, pgid: options.attempt, started_at: `2026-08-20T10:${minute}:00.000Z`, proc_start_ticks: options.attempt, command_sha256: '1'.repeat(64) },
    launch_id: `00000000-0000-4000-8000-${String(options.attempt).padStart(12, '0')}`,
    survivors_killed: [],
    survivors_remaining: [],
    started_at: `2026-08-20T10:${minute}:00.000Z`,
    finished_at: `2026-08-20T10:${minute}:01.000Z`,
    duration_ms: durationMs,
    exit_code: 0,
    timed_out: false,
    controlled: {},
    billing: {
      mode: 'not_applicable',
      credential_source: 'not_applicable',
      included_allowance_consumed: false,
      provider_estimated_api_equivalent_usd: apiEquivalent,
      actual_incremental_charge_usd: null,
      authoritative_billing_verified: false,
    },
    rate_limit_observations: null,
    observed_tokens:
      options.observedTokensTotal === undefined || options.observedTokensTotal === null
        ? null
        : {
            total: options.observedTokensTotal,
            input: options.observedTokensTotal,
            cached_input: null,
            output: null,
            reasoning: null,
            provenance: 'fixture: turn.completed.usage',
          },
    subscription_usage: quotaPp === null
      ? null
      : {
          source: 'claude_print_usage',
          probe_contract: { before: probe, after: probe },
          five_hour: window(quotaPp),
          seven_day_all_models: window(quotaPp),
        },
    provider_failure: null,
  });
}

async function historyAttempt(input: {
  readonly target: string;
  readonly labRoot: string;
  readonly attempt: number;
  readonly role: AttemptRole.INITIAL | AttemptRole.REPAIR | AttemptRole.ESCALATION;
  readonly profile?: LauncherProfile;
  readonly validationExit?: number;
  readonly apiEquivalent?: number | null;
  readonly reviewRequired?: boolean;
  readonly reviewDecision?: 'ACCEPT' | 'REJECT';
  readonly tokens?: 'OBSERVED' | 'UNKNOWN';
  readonly validationArgv?: readonly string[];
  /** Default: o lifecycle prova zero intervenções, como no control plane real. */
  readonly interventions?: 'PROVEN_ZERO' | 'UNKNOWN' | readonly InterventionRecord[];
  readonly episodeId?: string;
  readonly ordinal?: number;
  readonly initialProfile?: LauncherProfile;
  readonly durationMs?: number;
  readonly totalTokens?: number;
  readonly quotaPp?: number | null;
  readonly observedTokensTotal?: number | null;
  readonly afterStage?: Parameters<typeof materializeCanonicalProjectAttempt>[0]['afterStage'];
}) {
  const profile = input.profile ?? HISTORY_PROFILE_A;
  const paths = resolveHarnessPaths(input.target);
  const launch = LaunchRecord.parse({
    ...historyLaunch({
      taskId: HISTORY_TASK.id,
      attempt: input.attempt,
      apiEquivalent: input.apiEquivalent === undefined ? 1 : input.apiEquivalent,
      ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
      ...(input.quotaPp === undefined ? {} : { quotaPp: input.quotaPp }),
      ...(input.observedTokensTotal === undefined
        ? {}
        : { observedTokensTotal: input.observedTokensTotal }),
    }),
    profile_id: profile.id,
  });
  const interventions = input.interventions ?? 'PROVEN_ZERO';
  const interventionEvidence =
    interventions === 'UNKNOWN'
      ? null
      : {
          provenance:
            interventions === 'PROVEN_ZERO'
              ? 'lifecycle autônomo provou zero intervenções'
              : 'gate humano liberado entre attempts do episódio',
          interventions: interventions === 'PROVEN_ZERO' ? [] : interventions,
        };
  const initialProfile = input.initialProfile ?? HISTORY_PROFILE_A;
  return materializeCanonicalProjectAttempt({
    paths,
    labRoot: input.labRoot,
    planTask: HISTORY_TASK,
    classification: HISTORY_CLASSIFICATION,
    inspection: historyInspection(input.target),
    profile,
    capability: capabilityInputOf(profile),
    launch,
    attempt: input.attempt,
    attemptRole: input.role,
    executionEpisodeId: input.episodeId ?? 'episode-history-1',
    episodeAttemptOrdinal: input.ordinal ?? input.attempt,
    initialProfileId: initialProfile.id,
    initialProfileFingerprintSha256: projectProfileFingerprint(initialProfile),
    interventionEvidence,
    baseSha: 'a'.repeat(40),
    compiledPrompt: JSON.stringify(HISTORY_TASK),
    validationResults: [{ argv: [...(input.validationArgv ?? ['pnpm', 'typecheck'])], exit_code: input.validationExit ?? 0, timed_out: false, duration_ms: 100 }],
    reviewRequired: input.reviewRequired ?? false,
    reviewRecord: input.reviewDecision === undefined
      ? null
      : CandidateReviewRecord.parse({
          schema_version: 1,
          task_id: HISTORY_TASK.id,
          attempt: input.attempt,
          candidate_sha: 'b'.repeat(40),
          finalization_record_sha256: 'c'.repeat(64),
          validation_results_sha256: 'd'.repeat(64),
          reviewer_profile_id: HISTORY_PROFILE_B.id,
          reviewer_invocation: {
            role: 'reviewer',
            workspace_access: 'READ_ONLY',
            read_only_mechanism: 'fixture sem mutação',
            argv: ['node', 'fake-reviewer.mjs'],
            diversity_requirement: 'independent review',
            fresh_context: true,
          },
          decision: input.reviewDecision,
          reason: `fixture ${input.reviewDecision}`,
          decided_at: '2026-08-20T10:59:00.000Z',
        }),
    changedFiles: ['src/index.ts'],
    contextPressure: 'low',
    environmentReadiness: 'READY',
    // Mesmo caminho do control plane real: a contagem entra na história a
    // partir do LaunchRecord quando o provider a reportou.
    ...(launch.observed_tokens !== null
      ? { observedTokens: observedTokensOf(launch) }
      : input.tokens === 'UNKNOWN'
        ? {}
        : {
            observedTokens: {
              total: input.totalTokens ?? 100,
              input: 70,
              cachedInput: 10,
              output: 30,
              reasoning: 5,
              provenance: 'fixture observed usage',
            },
          }),
    ...(input.afterStage === undefined ? {} : { afterStage: input.afterStage }),
  });
}

describe('inferência provada — regressão do piloto Augmented Chess', () => {
  /**
   * Forma EXATA dos 13 launches reais do piloto: provider de assinatura sem
   * medidor de conta (`/usage` é comando do Claude) e sem custo de API. Antes
   * da correção o attempt caía em `had_inference UNKNOWN`, nenhuma run
   * canônica nascia, a história ficava permanentemente vazia e todo routing
   * reescolhia o mesmo provider pelo fallback estático.
   */
  const PILOT_LAUNCH_SHAPE = { apiEquivalent: null, quotaPp: null } as const;

  it('attempt de assinatura sem medidor vira run canônica quando o provider reporta tokens', async () => {
    const target = await temporaryDir();
    const labRoot = await temporaryDir();
    const result = await historyAttempt({
      target,
      labRoot,
      attempt: 1,
      role: AttemptRole.INITIAL,
      ...PILOT_LAUNCH_SHAPE,
      observedTokensTotal: 759_082,
    });

    expect(result.outcome).toBe('MATERIALIZED');
    if (result.outcome === 'SKIPPED') throw new Error(result.reason);
    expect((await verifyRunIntegrity(path.join(labRoot, 'data', 'runs', result.run_id))).ok).toBe(true);
  });

  it('sem nenhuma das três evidências o attempt continua UNKNOWN e não vira amostra', async () => {
    const target = await temporaryDir();
    const labRoot = await temporaryDir();
    const result = await historyAttempt({
      target,
      labRoot,
      attempt: 1,
      role: AttemptRole.INITIAL,
      ...PILOT_LAUNCH_SHAPE,
      observedTokensTotal: null,
    });

    expect(result).toMatchObject({
      outcome: 'SKIPPED',
      reason: expect.stringContaining('had_inference UNKNOWN'),
    });
    await expect(readdir(path.join(labRoot, 'data', 'runs'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('o LaunchRecord carrega a contagem do provider como evidência durável', async () => {
    const target = await temporaryDir();
    const labRoot = await temporaryDir();
    const result = await historyAttempt({
      target,
      labRoot,
      attempt: 1,
      role: AttemptRole.INITIAL,
      ...PILOT_LAUNCH_SHAPE,
      observedTokensTotal: 12_345,
    });
    if (result.outcome === 'SKIPPED') throw new Error(result.reason);

    const execution = JSON.parse(
      await readFile(
        path.join(labRoot, 'data', 'runs', result.run_id, 'execution', 'execution-record.json'),
        'utf8',
      ),
    ) as { metrics: { tokens: { value: number | null } } };
    expect(execution.metrics.tokens.value).toBe(12_345);
  });
});

describe('história canônica de project attempts', () => {
  it('fingerprint de work definition ignora id literal, mas não mistura semântica diferente', () => {
    const sameWorkDifferentId = PlanTask.parse({
      ...HISTORY_TASK,
      id: 'OUTRO-ID',
      title: 'Outro rótulo humano',
    });
    const differentObjective = PlanTask.parse({
      ...sameWorkDifferentId,
      objective: 'Implementar outra mudança',
    });
    const expected = projectWorkDefinitionFingerprint({
      planTask: HISTORY_TASK,
      classification: HISTORY_CLASSIFICATION,
    });
    expect(projectWorkDefinitionFingerprint({
      planTask: sameWorkDifferentId,
      classification: HISTORY_CLASSIFICATION,
    })).toBe(expected);
    expect(projectWorkDefinitionFingerprint({
      planTask: differentObjective,
      classification: HISTORY_CLASSIFICATION,
    })).not.toBe(expected);
  });

  it('materializa PASS/FAIL, REPAIR e ESCALATION em runs íntegros e episódio V2 único', async () => {
    const target = await temporaryDir();
    const labRoot = await temporaryDir();
    const first = await historyAttempt({ target, labRoot, attempt: 1, role: AttemptRole.INITIAL, validationExit: 1 });
    const repair = await historyAttempt({ target, labRoot, attempt: 2, role: AttemptRole.REPAIR, validationExit: 1 });
    const escalation = await historyAttempt({ target, labRoot, attempt: 3, role: AttemptRole.ESCALATION, profile: HISTORY_PROFILE_B });
    expect(first.outcome).toBe('MATERIALIZED');
    expect(repair.outcome).toBe('MATERIALIZED');
    expect(escalation.outcome).toBe('MATERIALIZED');
    if (first.outcome === 'SKIPPED' || repair.outcome === 'SKIPPED' || escalation.outcome === 'SKIPPED') return;

    const runsDir = path.join(labRoot, 'data', 'runs');
    expect(await verifyRunIntegrity(path.join(runsDir, first.run_id))).toMatchObject({ ok: true });
    expect(await verifyRunIntegrity(path.join(runsDir, repair.run_id))).toMatchObject({ ok: true });
    expect(await verifyRunIntegrity(path.join(runsDir, escalation.run_id))).toMatchObject({ ok: true });
    expect(repair.trial_id).toBe(first.trial_id);
    expect(escalation.trial_id).not.toBe(first.trial_id);

    const firstEvaluation = EvaluationRecord.parse(JSON.parse(await readFile(
      path.join(runsDir, first.run_id, 'evaluations', first.evaluation_id, 'evaluation-record.json'),
      'utf8',
    )));
    const escalationEvaluation = EvaluationRecord.parse(JSON.parse(await readFile(
      path.join(runsDir, escalation.run_id, 'evaluations', escalation.evaluation_id, 'evaluation-record.json'),
      'utf8',
    )));
    expect(firstEvaluation.outcome).toBe(EvaluationOutcome.FAIL);
    expect(escalationEvaluation.outcome).toBe(EvaluationOutcome.PASS);
    const executionManifest = JSON.parse(await readFile(
      path.join(runsDir, first.run_id, 'execution', 'manifest.json'),
      'utf8',
    )) as { digest_sha256: string };
    const evaluationEnvelope = JSON.parse(await readFile(
      path.join(runsDir, first.run_id, 'evaluations', first.evaluation_id, 'evaluation-envelope.json'),
      'utf8',
    )) as { execution_manifest_sha256: string };
    expect(evaluationEnvelope.execution_manifest_sha256).toBe(executionManifest.digest_sha256);
    const facts = JSON.parse(await readFile(
      path.join(runsDir, escalation.run_id, 'execution', 'comparable-run-facts.json'),
      'utf8',
    )) as { provider: { value: string }; attempt_role: { value: string } };
    expect(facts).toMatchObject({
      provider: { value: HISTORY_PROFILE_B.agent },
      attempt_role: { value: AttemptRole.ESCALATION },
    });

    const rebuilt = await RunIndex.rebuild(path.join(labRoot, 'data', 'rebuilt.sqlite'), runsDir);
    expect(rebuilt.report).toMatchObject({ runsScanned: 3, runsIndexed: 3 });
    rebuilt.index.close();

    const selections = Object.fromEntries(
      [first, repair, escalation].map((item) => [item.run_id, { evaluation_id: item.evaluation_id, score_id: item.score_id }]),
    );
    const queried = await queryPerformanceHistory({
      schema_version: 2,
      runs_dir: runsDir,
      minimum_sample_size: 1,
      work_definition_fingerprint_sha256: projectWorkDefinitionFingerprint({ planTask: HISTORY_TASK, classification: HISTORY_CLASSIFICATION }),
      trials: [
        { trial_id: first.trial_id, selection: selections },
        { trial_id: escalation.trial_id, selection: selections },
      ],
    });
    expect(queried.episodes).toHaveLength(1);
    expect(queried.episodes[0]?.performance.attempts).toMatchObject({ repair_attempts: 1, escalations: 1 });
    expect(queried.episodes[0]?.performance.success.final_pass).toBe(true);
    expect(queried.series).toHaveLength(2);

    const discovered = await queryCanonicalProjectHistory({
      labRoot,
      workDefinitionFingerprintSha256: projectWorkDefinitionFingerprint({
        planTask: HISTORY_TASK,
        classification: HISTORY_CLASSIFICATION,
      }),
      eligibleProfileIds: [HISTORY_PROFILE_A.id, HISTORY_PROFILE_B.id],
      minimumSampleSize: 1,
      filter: { task_class: 'feature', difficulty: 'easy', stack: ['node'] },
    });
    expect(discovered.episodes).toHaveLength(1);
    expect(discovered.series).toHaveLength(2);
  });

  it('não duplica no replay nem em nenhuma janela de crash/resume', async () => {
    const stages = [
      'RUN_CREATED',
      'EXECUTION_WRITTEN',
      'EXECUTION_SEALED',
      'EVALUATION_SEALED',
      'SCORE_SEALED',
      'INDEXED',
      'BOUND',
    ] as const;
    for (const crashStage of stages) {
      const target = await temporaryDir();
      const labRoot = await temporaryDir();
      let crashed = false;
      await expect(historyAttempt({
        target,
        labRoot,
        attempt: 1,
        role: AttemptRole.INITIAL,
        afterStage(stage) {
          if (stage === crashStage && !crashed) {
            crashed = true;
            throw new Error(`crash injetado em ${stage}`);
          }
        },
      })).rejects.toThrow(`crash injetado em ${crashStage}`);
      const resumed = await historyAttempt({ target, labRoot, attempt: 1, role: AttemptRole.INITIAL });
      const replay = await historyAttempt({ target, labRoot, attempt: 1, role: AttemptRole.INITIAL });
      expect(['MATERIALIZED', 'ALREADY_MATERIALIZED']).toContain(resumed.outcome);
      expect(replay.outcome).toBe('ALREADY_MATERIALIZED');
      expect(await readdir(path.join(labRoot, 'data', 'runs'))).toHaveLength(1);
    }
  });

  it('operational retry sem prova positiva de inference não vira sample', async () => {
    const target = await temporaryDir();
    const labRoot = await temporaryDir();
    const result = await historyAttempt({ target, labRoot, attempt: 1, role: AttemptRole.INITIAL, apiEquivalent: 0 });
    expect(result).toMatchObject({ outcome: 'SKIPPED', reason: expect.stringContaining('zero inference') });
    await expect(readdir(path.join(labRoot, 'data', 'runs'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserva PASS determinístico + review REJECT como grader independente FAIL', async () => {
    const target = await temporaryDir();
    const labRoot = await temporaryDir();
    const result = await historyAttempt({
      target,
      labRoot,
      attempt: 1,
      role: AttemptRole.INITIAL,
      reviewRequired: true,
      reviewDecision: 'REJECT',
    });
    expect(result.outcome).toBe('MATERIALIZED');
    if (result.outcome === 'SKIPPED') return;
    const record = EvaluationRecord.parse(JSON.parse(await readFile(
      path.join(labRoot, 'data', 'runs', result.run_id, 'evaluations', result.evaluation_id, 'evaluation-record.json'),
      'utf8',
    )));
    expect(record.outcome).toBe(EvaluationOutcome.FAIL);
    expect(record.grader_results).toMatchObject({
      'official-validation-1': { outcome: EvaluationOutcome.PASS, required: true },
      'independent-review': { outcome: EvaluationOutcome.FAIL, required: true },
    });
  });

  it('review obrigatória indisponível permanece NOT_EVALUATED', async () => {
    const target = await temporaryDir();
    const labRoot = await temporaryDir();
    const result = await historyAttempt({
      target,
      labRoot,
      attempt: 1,
      role: AttemptRole.INITIAL,
      reviewRequired: true,
    });
    expect(result.outcome).toBe('MATERIALIZED');
    if (result.outcome === 'SKIPPED') return;
    const record = EvaluationRecord.parse(JSON.parse(await readFile(
      path.join(labRoot, 'data', 'runs', result.run_id, 'evaluations', result.evaluation_id, 'evaluation-record.json'),
      'utf8',
    )));
    expect(record.outcome).toBe(EvaluationOutcome.NOT_EVALUATED);
    expect(record.grader_results['independent-review']?.outcome).toBe(EvaluationOutcome.NOT_EVALUATED);
    const envelope = JSON.parse(await readFile(
      path.join(labRoot, 'data', 'runs', result.run_id, 'evaluations', result.evaluation_id, 'evaluation-envelope.json'),
      'utf8',
    )) as { evaluation_commands: Record<string, readonly string[]> };
    expect(envelope.evaluation_commands).not.toHaveProperty('independent-review');
    await expect(readFile(
      path.join(labRoot, 'data', 'runs', result.run_id, 'evaluations', result.evaluation_id, 'candidate-review-unavailable.json'),
      'utf8',
    )).resolves.toContain('review evidence unavailable');
  });

  it('resultado de command diferente não é atribuído ao grader oficial', async () => {
    const target = await temporaryDir();
    const labRoot = await temporaryDir();
    const result = await historyAttempt({
      target,
      labRoot,
      attempt: 1,
      role: AttemptRole.INITIAL,
      validationArgv: ['true'],
    });
    expect(result.outcome).toBe('MATERIALIZED');
    if (result.outcome === 'SKIPPED') return;
    const record = EvaluationRecord.parse(JSON.parse(await readFile(
      path.join(labRoot, 'data', 'runs', result.run_id, 'evaluations', result.evaluation_id, 'evaluation-record.json'),
      'utf8',
    )));
    expect(record.outcome).toBe(EvaluationOutcome.NOT_EVALUATED);
    expect(record.grader_results['official-validation-1']?.outcome).toBe(EvaluationOutcome.NOT_EVALUATED);
  });

  it('tokens UNKNOWN não viram zero e tornam score UNSCORABLE', async () => {
    const target = await temporaryDir();
    const labRoot = await temporaryDir();
    const result = await historyAttempt({
      target,
      labRoot,
      attempt: 1,
      role: AttemptRole.INITIAL,
      tokens: 'UNKNOWN',
    });
    expect(result.outcome).toBe('MATERIALIZED');
    if (result.outcome === 'SKIPPED') return;
    expect(result.qualification.status).toBe(QualificationStatus.UNSCORABLE);
    const execution = JSON.parse(await readFile(
      path.join(labRoot, 'data', 'runs', result.run_id, 'execution', 'execution-record.json'),
      'utf8',
    )) as { metrics: { tokens: { value: number | null } } };
    expect(execution.metrics.tokens.value).toBeNull();
  });

  it('reconstrói a mesma história somente de data/runs, sem .dev e sem índice', async () => {
    const target = await temporaryDir();
    const labRoot = await temporaryDir();
    const first = await historyAttempt({ target, labRoot, attempt: 1, role: AttemptRole.INITIAL, validationExit: 1 });
    const repair = await historyAttempt({ target, labRoot, attempt: 2, role: AttemptRole.REPAIR, validationExit: 1 });
    const escalation = await historyAttempt({ target, labRoot, attempt: 3, role: AttemptRole.ESCALATION, profile: HISTORY_PROFILE_B });
    expect([first.outcome, repair.outcome, escalation.outcome]).toEqual([
      'MATERIALIZED',
      'MATERIALIZED',
      'MATERIALIZED',
    ]);
    if (first.outcome === 'SKIPPED' || repair.outcome === 'SKIPPED' || escalation.outcome === 'SKIPPED') return;

    const query = {
      labRoot,
      workDefinitionFingerprintSha256: projectWorkDefinitionFingerprint({
        planTask: HISTORY_TASK,
        classification: HISTORY_CLASSIFICATION,
      }),
      eligibleProfileIds: [HISTORY_PROFILE_A.id, HISTORY_PROFILE_B.id],
      minimumSampleSize: 1,
    };
    const before = await queryCanonicalProjectHistory(query);
    expect(before.episodes).toHaveLength(1);
    expect(before.series).toHaveLength(2);

    // A fonte de verdade é `data/runs`: o binding do runtime e o índice SQLite
    // são descartáveis e não podem ser exigidos por M81 V2.
    const paths = resolveHarnessPaths(target);
    const runsDir = path.join(labRoot, 'data', 'runs');
    await rm(paths.projectHistoryBindingsDir, { recursive: true, force: true });
    await rm(path.join(labRoot, 'data', 'index.sqlite'), { force: true });
    await expect(readdir(paths.projectHistoryBindingsDir)).rejects.toMatchObject({ code: 'ENOENT' });

    const rebuilt = await RunIndex.rebuild(path.join(labRoot, 'data', 'index.sqlite'), runsDir);
    expect(rebuilt.report).toMatchObject({ runsScanned: 3, runsIndexed: 3 });
    rebuilt.index.close();

    const after = await queryCanonicalProjectHistory(query);
    expect(after.episodes[0]?.performance.intervention.human_intervention).toMatchObject({
      value: false,
      provenance: 'zero_interventions_recorded_all_attempts',
    });
    expect(after.episodes).toEqual(before.episodes);
    expect(after.series).toEqual(before.series);
    expect(after.episodes[0]?.run_ids).toEqual([first.run_id, repair.run_id, escalation.run_id]);
  });

  it('evidência de intervenção só existe quando o lifecycle prova o conjunto observado', async () => {
    const target = await temporaryDir();
    const labRoot = await temporaryDir();
    const proven = await historyAttempt({ target, labRoot, attempt: 1, role: AttemptRole.INITIAL });
    const unknown = await historyAttempt({
      target,
      labRoot,
      attempt: 2,
      role: AttemptRole.INITIAL,
      episodeId: 'episode-unknown',
      interventions: 'UNKNOWN',
    });
    const intervened = await historyAttempt({
      target,
      labRoot,
      attempt: 3,
      role: AttemptRole.REPAIR,
      episodeId: 'episode-history-1',
      ordinal: 2,
      interventions: [
        {
          intervention_id: 'human-release:T-HISTORY:attempt-1',
          type: InterventionType.DESIGN_DECISION,
          description: 'humano liberou o gate de review REJECT do attempt 1',
          occurred_at: '2026-08-20T10:30:00.000Z',
          affects_autonomy: true,
        },
      ],
    });
    if (proven.outcome === 'SKIPPED' || unknown.outcome === 'SKIPPED' || intervened.outcome === 'SKIPPED') {
      throw new Error('fixture não materializou');
    }
    const runsDir = path.join(labRoot, 'data', 'runs');
    const interventionsPath = (runId: string) => path.join(runsDir, runId, 'execution', 'interventions.json');

    expect(JSON.parse(await readFile(interventionsPath(proven.run_id), 'utf8'))).toMatchObject({
      schema_version: 1,
      interventions: [],
    });
    await expect(readFile(interventionsPath(unknown.run_id), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(interventionsPath(intervened.run_id), 'utf8'))).toMatchObject({
      interventions: [{ type: InterventionType.DESIGN_DECISION, affects_autonomy: true }],
    });

    const history = await queryPerformanceHistory({
      schema_version: 2,
      runs_dir: runsDir,
      minimum_sample_size: 1,
      work_definition_fingerprint_sha256: projectWorkDefinitionFingerprint({
        planTask: HISTORY_TASK,
        classification: HISTORY_CLASSIFICATION,
      }),
      trials: [proven.trial_id, unknown.trial_id]
        .filter((trialId, index, all) => all.indexOf(trialId) === index)
        .map((trialId) => ({
          trial_id: trialId,
          selection: {
            [proven.run_id]: { evaluation_id: proven.evaluation_id, score_id: proven.score_id },
            [unknown.run_id]: { evaluation_id: unknown.evaluation_id, score_id: unknown.score_id },
            [intervened.run_id]: { evaluation_id: intervened.evaluation_id, score_id: intervened.score_id },
          },
        })),
    });
    const withHuman = history.episodes.find((item) => item.execution_episode_id === 'episode-history-1');
    const unknownEpisode = history.episodes.find((item) => item.execution_episode_id === 'episode-unknown');
    expect(withHuman?.performance.intervention.human_intervention).toMatchObject({
      value: true,
      provenance: 'intervention_recorded',
    });
    expect(unknownEpisode?.performance.intervention.human_intervention).toMatchObject({
      value: null,
      provenance: 'not_recorded',
    });
  });

  it('história canônica real muda M78 (A) para M82 HISTORY (B) e volta a M78 sem métrica obrigatória', async () => {
    const cheap = LauncherProfile.parse({
      ...HISTORY_PROFILE_A,
      id: 'fake-routing-cheap',
      test_double_of: { ...HISTORY_PROFILE_A.test_double_of!, model: 'gpt-5.6-terra' },
    });
    const strong = LauncherProfile.parse({
      ...HISTORY_PROFILE_A,
      id: 'fake-routing-strong',
      test_double_of: { ...HISTORY_PROFILE_A.test_double_of!, model: 'gpt-5.6-sol' },
    });

    async function buildHistory(options: { readonly strongTokens: 'OBSERVED' | 'UNKNOWN' }) {
      const target = await temporaryDir();
      const labRoot = await temporaryDir();
      let attempt = 0;
      for (let episode = 1; episode <= 3; episode += 1) {
        attempt += 1;
        await historyAttempt({
          target, labRoot, attempt, role: AttemptRole.INITIAL, profile: cheap,
          initialProfile: cheap, episodeId: `episode-cheap-${episode}`, ordinal: 1,
          validationExit: 1, durationMs: 4_000, totalTokens: 400, quotaPp: 4, apiEquivalent: 4,
        });
        attempt += 1;
        await historyAttempt({
          target, labRoot, attempt, role: AttemptRole.REPAIR, profile: cheap,
          initialProfile: cheap, episodeId: `episode-cheap-${episode}`, ordinal: 2,
          durationMs: 4_000, totalTokens: 400, quotaPp: 4, apiEquivalent: 4,
        });
      }
      for (let episode = 1; episode <= 3; episode += 1) {
        attempt += 1;
        await historyAttempt({
          target, labRoot, attempt, role: AttemptRole.INITIAL, profile: strong,
          initialProfile: strong, episodeId: `episode-strong-${episode}`, ordinal: 1,
          durationMs: 1_000, totalTokens: 100, quotaPp: 1, apiEquivalent: 1,
          tokens: options.strongTokens,
        });
      }
      return queryCanonicalProjectHistory({
        labRoot,
        workDefinitionFingerprintSha256: projectWorkDefinitionFingerprint({
          planTask: HISTORY_TASK,
          classification: HISTORY_CLASSIFICATION,
        }),
        eligibleProfileIds: [cheap.id, strong.id],
        minimumSampleSize: 3,
        filter: { task_class: 'feature', difficulty: 'easy', stack: ['node'] },
      });
    }

    const inspection = historyInspection(await temporaryDir());
    const built = buildWorkUnitFromPlan({
      planTask: HISTORY_TASK,
      inspection,
      classification: HISTORY_CLASSIFICATION,
    });
    const assessment = assessExecution(built.task, {
      inspection,
      expectedBaseRevisionSha: 'a'.repeat(40),
      factsSource: 'full_inspection',
    });
    const routingInput = {
      work_unit: {
        source: 'direct_task_normalization' as const,
        task: built.task,
        assessment,
        project_facts: inspection,
      },
      role: 'implementer' as const,
      capability_registry: new CapabilityRegistry([
        capabilityOf(capabilityInputOf(cheap)),
        capabilityOf(capabilityInputOf(strong)),
      ]),
      candidates: [cheap, strong].map((profile) => ({
        profile_id: profile.id,
        availability: { value: true, provenance: 'fixture: profile carregado do catálogo' },
      })),
      profile_fingerprints_sha256: {
        [cheap.id]: projectProfileFingerprint(cheap),
        [strong.id]: projectProfileFingerprint(strong),
      },
    };

    const emptyLabRoot = await temporaryDir();
    const empty = await queryCanonicalProjectHistory({
      labRoot: emptyLabRoot,
      workDefinitionFingerprintSha256: projectWorkDefinitionFingerprint({
        planTask: HISTORY_TASK,
        classification: HISTORY_CLASSIFICATION,
      }),
      eligibleProfileIds: [cheap.id, strong.id],
      minimumSampleSize: 3,
    });
    const withoutHistory = routeInitialProfileWithHistory({ ...routingInput, history: empty });
    expect(withoutHistory.source).toBe('M78_FALLBACK');
    expect(withoutHistory.fallback).toMatchObject({ outcome: 'ROUTED', profile: { profile_id: cheap.id } });

    const sufficient = await buildHistory({ strongTokens: 'OBSERVED' });
    expect(sufficient.episodes).toHaveLength(6);
    const routed = routeInitialProfileWithHistory({ ...routingInput, history: sufficient });
    expect(routed.source).toBe('HISTORY');
    expect(routed.recommendation?.profile.profile_id).toBe(strong.id);
    expect(routed.evidence.selected_series_sample_size).toBe(3);

    const degraded = await buildHistory({ strongTokens: 'UNKNOWN' });
    const fellBack = routeInitialProfileWithHistory({ ...routingInput, history: degraded });
    expect(fellBack.source).toBe('M78_FALLBACK');
    expect(fellBack.fallback).toMatchObject({ outcome: 'ROUTED', profile: { profile_id: cheap.id } });
    expect(fellBack.evidence.series_considered).toContainEqual(
      expect.objectContaining({ profile_id: strong.id, status: 'INSUFFICIENT_EVIDENCE' }),
    );
  }, 60_000);
});
