import { describe, expect, it } from 'vitest';

import { AttemptRole } from '../../src/performance/index.js';
import {
  CapabilityRegistry,
  EscalationLadder,
  capabilityOf,
  decideEscalation,
  resolveEscalationLadder,
  type EscalationAuthorization,
  type EscalationDecisionInput,
  type EscalationExecutionPolicy,
  type EscalationLadder as EscalationLadderValue,
  type FailureDiagnosis,
  type ProfileCapability,
  type RepairSequenceEvidence,
} from '../../src/routing/index.js';

function capability(
  profileId: string,
  overrides: Partial<Parameters<typeof capabilityOf>[0]> = {},
): ProfileCapability {
  return capabilityOf({
    profile_id: profileId,
    agent: 'codex',
    model: `configured-model-${profileId}`,
    reasoning_effort: 'configured',
    reasoning_effort_source: 'codex_config_override',
    billing_mode: 'subscription_only',
    credential_source: 'subscription',
    environment_mode: 'real-world',
    instruction_environment: 'sanitized',
    commit_owner: 'orchestrator',
    official_validation_owner: 'orchestrator',
    worker_validation_policy: 'targeted',
    sandbox: 'workspace-write',
    session_persistence: 'ephemeral',
    ...overrides,
  });
}

function diagnosis(classification: FailureDiagnosis['classification'] = 'CAPABILITY'): FailureDiagnosis {
  return {
    schema_version: 1,
    classification,
    rationale: `diagnóstico ${classification}`,
    boundary: 'bounded repair esgotado',
    retry_budget: {
      kind: 'BOUNDED_REPAIR',
      maximum_attempts: 1,
      attempts_used: 1,
      same_profile_required: true,
    },
    decision_needed: 'escolher intervenção',
    why_automation_stopped: 'automation boundary alcançada',
    options: ['replanear', 'autorizar mudança'],
    evidence_paths: ['evidence/diagnosis.json'],
    provenance: ['evaluation record'],
  };
}

function sequence(overrides: Partial<RepairSequenceEvidence> = {}): RepairSequenceEvidence {
  return {
    initial: {
      attempt_role: AttemptRole.INITIAL,
      profile_id: 'profile-low',
      evaluation_outcome: 'FAIL',
      evidence_paths: ['evidence/initial.json'],
    },
    repair: {
      attempt_role: AttemptRole.REPAIR,
      profile_id: 'profile-low',
      evaluation_outcome: 'FAIL',
      retry_budget: 1,
      authorization_provenance: 'bounded_repair_policy',
      evidence_paths: ['evidence/repair.json'],
    },
    ...overrides,
  };
}

function ladder(profileIds = ['profile-low', 'profile-mid', 'profile-high']): EscalationLadderValue {
  return {
    schema_version: 1,
    ordering: 'CONFIGURED_CAPABILITY_ASCENDING',
    ordering_rationale: 'project policy ranks capability from narrower to broader',
    steps: profileIds.map((profile_id, capability_rank) => ({
      profile_id,
      capability_rank,
      rationale: `policy rank ${capability_rank}`,
    })),
  };
}

function policy(overrides: Partial<EscalationExecutionPolicy> = {}): EscalationExecutionPolicy {
  return {
    schema_version: 1,
    authorization_scope: {
      schema_version: 1,
      requested_scope: { summary: 'implementar a task' },
      autonomous_execution_boundary: [
        'BOUNDED_REPAIR',
        'CAPABILITY_ESCALATION_WITHIN_LADDER',
      ],
      human_gated_capabilities: [
        'UNAUTHORIZED_API_BILLING',
        'PROFILE_OR_PROVIDER_OUTSIDE_POLICY',
        'INSUFFICIENT_EVIDENCE',
        'SAFE_ESCALATION_EXHAUSTED',
      ],
    },
    allowed_profile_ids: ['profile-low', 'profile-mid', 'profile-high'],
    allowed_providers: ['codex'],
    authorized_billing_modes: ['subscription_only'],
    evidence_paths: ['policy/execution.json'],
    provenance: 'project_execution_policy',
    ...overrides,
  };
}

function input(
  overrides: Partial<EscalationDecisionInput> = {},
  capabilities: readonly ProfileCapability[] = [
    capability('profile-low'),
    capability('profile-mid'),
    capability('profile-high'),
  ],
): EscalationDecisionInput {
  return {
    diagnosis: diagnosis(),
    repair_sequence: sequence(),
    ladder: ladder(),
    capability_registry: new CapabilityRegistry(capabilities),
    execution_policy: policy(),
    ...overrides,
  };
}

describe('EscalationLadder', () => {
  it('resolve a ordem configurada contra o capability registry', () => {
    const decisionInput = input();
    const resolved = resolveEscalationLadder(
      decisionInput.ladder,
      decisionInput.capability_registry,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error('unreachable');
    expect(resolved.steps.map((step) => step.profile.profile_id)).toEqual([
      'profile-low',
      'profile-mid',
      'profile-high',
    ]);
  });

  it('rejeita rank não crescente e profile duplicado sem inferir família de modelo', () => {
    expect(() =>
      EscalationLadder.parse({
        ...ladder(),
        steps: [
          { profile_id: 'same', capability_rank: 1, rationale: 'first' },
          { profile_id: 'same', capability_rank: 1, rationale: 'second' },
        ],
      }),
    ).toThrow();
  });
});

describe('decideEscalation', () => {
  it('deriva autorização própria da project execution policy e prossegue automaticamente', () => {
    const result = decideEscalation(input());
    expect(result).toMatchObject({
      outcome: 'ESCALATE',
      classification: 'CAPABILITY',
      attempt_role: AttemptRole.ESCALATION,
      to_profile: { profile_id: 'profile-mid' },
      authorization: {
        decision: 'ALLOWED',
        capability: 'CAPABILITY_ESCALATION_WITHIN_LADDER',
        step_index: 1,
        from_profile_id: 'profile-low',
        to_profile_id: 'profile-mid',
        provenance: 'project_execution_policy',
      },
      human_required: null,
    });
    if (result.outcome !== 'ESCALATE') throw new Error('unreachable');
    expect(result.authorization.provenance).not.toBe(
      input().repair_sequence.repair.authorization_provenance,
    );
    expect(result.authorization.evidence_paths).toEqual(
      expect.arrayContaining(['evidence/diagnosis.json', 'evidence/repair.json', 'policy/execution.json']),
    );
  });

  it('não cria authorization nem consome degrau para infra, mesmo em sequência', () => {
    const infraInput = input({ diagnosis: diagnosis('INFRA') });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(decideEscalation(infraInput)).toMatchObject({
        outcome: 'NO_ESCALATION',
        attempt_role: null,
        authorization: null,
        intervention: {
          action: 'RETRY_INFRA_SAME_PROFILE',
          changes_profile: false,
          consumes_escalation_step: false,
        },
      });
    }
  });

  it.each([
    ['ENVIRONMENT_NOT_READY', 'NO_ESCALATION'],
    ['TASK_DEFINITION_TOO_BROAD', 'NO_ESCALATION'],
    ['CONTEXT_PRESSURE', 'NO_ESCALATION'],
    ['VALIDATION_OR_TOOLING_GAP', 'HUMAN_REQUIRED'],
    ['UNKNOWN_INSUFFICIENT_EVIDENCE', 'HUMAN_REQUIRED'],
  ] as const)('não escala diagnóstico %s', (classification, expected) => {
    expect(decideEscalation(input({ diagnosis: diagnosis(classification) }))).toMatchObject({
      outcome: expected,
      authorization: null,
    });
  });

  it('exige humano para pedido que pula ou sai do próximo degrau', () => {
    expect(decideEscalation(input({ requested_profile_id: 'profile-high' }))).toMatchObject({
      outcome: 'HUMAN_REQUIRED',
      reason_code: 'STEP_OUTSIDE_AUTHORIZED_LADDER',
      authorization: null,
    });
  });

  it('exige humano para profile/provider fora da policy e não permite cross-provider', () => {
    expect(
      decideEscalation(
        input({ execution_policy: policy({ allowed_profile_ids: ['profile-low', 'profile-high'] }) }),
      ),
    ).toMatchObject({
      outcome: 'HUMAN_REQUIRED',
      reason_code: 'PROFILE_OR_PROVIDER_OUTSIDE_POLICY',
    });

    const profiles = [capability('profile-low'), capability('profile-mid', { agent: 'claude' })];
    const crossProvider = input(
      {
        ladder: ladder(['profile-low', 'profile-mid']),
        execution_policy: policy({
          allowed_profile_ids: ['profile-low', 'profile-mid'],
          allowed_providers: ['codex', 'claude'],
        }),
      },
      profiles,
    );
    expect(decideEscalation(crossProvider)).toMatchObject({
      outcome: 'HUMAN_REQUIRED',
      reason_code: 'PROFILE_OR_PROVIDER_OUTSIDE_POLICY',
    });
  });

  it('exige humano para billing de API não autorizado', () => {
    const profiles = [capability('profile-low'), capability('profile-mid', { billing_mode: 'api' })];
    const result = decideEscalation(
      input(
        {
          ladder: ladder(['profile-low', 'profile-mid']),
          execution_policy: policy({ allowed_profile_ids: ['profile-low', 'profile-mid'] }),
        },
        profiles,
      ),
    );
    expect(result).toMatchObject({
      outcome: 'HUMAN_REQUIRED',
      reason_code: 'UNAUTHORIZED_API_BILLING',
    });
  });

  it('exige humano quando o scope não autoriza escalation', () => {
    const result = decideEscalation(
      input({
        execution_policy: policy({
          authorization_scope: {
            ...policy().authorization_scope,
            autonomous_execution_boundary: ['BOUNDED_REPAIR'],
          },
        }),
      }),
    );
    expect(result).toMatchObject({
      outcome: 'HUMAN_REQUIRED',
      reason_code: 'ESCALATION_NOT_AUTHORIZED',
    });
  });

  it('exige humano se repair não foi um só no mesmo profile', () => {
    const invalid = sequence({
      repair: { ...sequence().repair, profile_id: 'profile-other' },
    });
    expect(decideEscalation(input({ repair_sequence: invalid }))).toMatchObject({
      outcome: 'HUMAN_REQUIRED',
      reason_code: 'INVALID_REPAIR_SEQUENCE',
    });
  });

  it('esgota a ladder explicitamente, sem loop', () => {
    const threeStepInput = input();
    const first = decideEscalation(threeStepInput);
    if (first.outcome !== 'ESCALATE') throw new Error('first step should escalate');
    const second = decideEscalation({
      ...threeStepInput,
      prior_authorizations: [first.authorization],
    });
    expect(second).toMatchObject({
      outcome: 'ESCALATE',
      authorization: { step_index: 2, from_profile_id: 'profile-mid', to_profile_id: 'profile-high' },
    });
    if (second.outcome !== 'ESCALATE') throw new Error('second step should escalate');
    const prior: readonly EscalationAuthorization[] = [first.authorization, second.authorization];
    const exhausted = decideEscalation({ ...threeStepInput, prior_authorizations: prior });
    expect(exhausted).toMatchObject({
      outcome: 'HUMAN_REQUIRED',
      reason_code: 'SAFE_ESCALATION_EXHAUSTED',
      authorization: null,
    });
  });
});
