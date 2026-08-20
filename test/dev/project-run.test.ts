/**
 * Control plane de runs de projeto externo: contrato de autorização, derivação
 * de capability, construção da work unit a partir do PlanFile confiável,
 * overlay read-only do worker falso e a separação entre HARNESS
 * SELF-MAINTENANCE e PROJECT REMEDIATION.
 *
 * Nenhum provider real e nenhum projeto real: os únicos perfis usados apontam
 * para `fixtures/fake-worker.mjs`.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { capabilityOf } from '../../src/routing/index.js';
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
      timeout_seconds: 60,
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

  it('sem source anchor observado, a fronteira não é inventada', () => {
    expect(() =>
      buildWorkUnitFromPlan({
        planTask,
        inspection: { ...inspection, source_anchors: [] },
        classification,
      }),
    ).toThrow(ProjectAuthorizationError);
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
