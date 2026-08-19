import { describe, expect, it } from 'vitest';

import type { RealExecutionAuthorization } from '../../src/billing/index.js';
import { AttemptRole } from '../../src/performance/index.js';
import {
  CapabilityRegistry,
  capabilityOf,
  decideEscalation,
  type EscalationCandidatePreflight,
  type EscalationDecisionInput,
  type EscalationExecutionPolicy,
  type FailureDiagnosis,
  type ProfileCapability,
  type RepairSequenceEvidence,
} from '../../src/routing/index.js';

function capability(
  profileId: string,
  agent: 'claude' | 'codex',
  billingMode = 'subscription_only',
): ProfileCapability {
  return capabilityOf({
    profile_id: profileId,
    agent,
    model: 'configured-' + profileId,
    reasoning_effort: 'high',
    reasoning_effort_source:
      agent === 'codex' ? 'codex_config_override' : 'claude_effort_flag',
    billing_mode: billingMode,
    credential_source: agent + '_subscription',
    environment_mode: 'real-world',
    instruction_environment: 'sanitized',
    commit_owner: 'orchestrator',
    official_validation_owner: 'orchestrator',
    worker_validation_policy: 'targeted',
    sandbox: 'workspace-write',
    session_persistence: 'ephemeral',
  });
}

function diagnosis(
  classification: FailureDiagnosis['classification'] = 'CAPABILITY',
): FailureDiagnosis {
  return {
    schema_version: 1,
    classification,
    rationale: 'diagnóstico ' + classification,
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

function sequence(profileId = 'codex-low'): RepairSequenceEvidence {
  return {
    initial: {
      attempt_role: AttemptRole.INITIAL,
      profile_id: profileId,
      evaluation_outcome: 'FAIL',
      evidence_paths: ['evidence/initial.json'],
    },
    repair: {
      attempt_role: AttemptRole.REPAIR,
      profile_id: profileId,
      evaluation_outcome: 'FAIL',
      retry_budget: 1,
      authorization_provenance: 'bounded_repair_policy',
      evidence_paths: ['evidence/repair.json'],
    },
  };
}

function executionAuthorization(
  overrides: {
    authorization?: RealExecutionAuthorization['authorization']['value'];
    quota?: RealExecutionAuthorization['quota']['availability']['value'];
    billingMode?: RealExecutionAuthorization['billing_mode']['value'];
  } = {},
): RealExecutionAuthorization {
  return {
    authorization: {
      value: overrides.authorization ?? 'AUTHORIZED',
      provenance: 'fake execution policy',
    },
    billing_mode: {
      value: overrides.billingMode ?? 'SUBSCRIPTION',
      provenance: 'configured profile',
    },
    quota: {
      availability: {
        value: overrides.quota ?? 'SUFFICIENT',
        provenance: 'fake quota probe',
      },
      remaining: { value: 80, provenance: 'fake quota probe' },
      unit: 'percent',
    },
    cost: {
      api_equivalent_usd: { value: null, provenance: 'not used' },
      projected_incremental_charge_usd: { value: null, provenance: 'not used' },
      actual_incremental_charge_usd: { value: null, provenance: 'not observed' },
      actual_incremental_charge_authoritative: false,
    },
    budget: {
      maximum_incremental_charge_usd: { value: null, provenance: 'not used' },
    },
  };
}

function preflight(
  profileId: string,
  overrides: {
    provider?: boolean | null;
    credential?: boolean | null;
    authorization?: RealExecutionAuthorization;
  } = {},
): EscalationCandidatePreflight {
  return {
    profile_id: profileId,
    provider_availability: {
      value: overrides.provider === undefined ? true : overrides.provider,
      provenance: 'fake provider probe',
    },
    credential_availability: {
      value: overrides.credential === undefined ? true : overrides.credential,
      provenance: 'fake credential probe',
    },
    real_execution_authorization: overrides.authorization ?? executionAuthorization(),
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
        'CROSS_PROVIDER_WITHIN_ALLOWED_SUBSCRIPTION_PROFILES',
      ],
      human_gated_capabilities: [
        'UNAUTHORIZED_API_BILLING',
        'PROFILE_OR_PROVIDER_OUTSIDE_POLICY',
        'INSUFFICIENT_EVIDENCE',
        'SAFE_ESCALATION_EXHAUSTED',
      ],
    },
    allowed_profile_ids: ['codex-low', 'claude-mid', 'codex-high'],
    allowed_providers: ['codex', 'claude'],
    authorized_billing_modes: ['subscription_only'],
    evidence_paths: ['policy/execution.json'],
    provenance: 'project_execution_policy',
    ...overrides,
  };
}

function input(overrides: Partial<EscalationDecisionInput> = {}): EscalationDecisionInput {
  const capabilities = [
    capability('codex-low', 'codex'),
    capability('claude-mid', 'claude'),
    capability('codex-high', 'codex'),
  ];
  return {
    diagnosis: diagnosis(),
    repair_sequence: sequence(),
    ladder: {
      schema_version: 1,
      ordering: 'CONFIGURED_CAPABILITY_ASCENDING',
      ordering_rationale: 'rank explícito da project policy',
      steps: capabilities.map((profile, capability_rank) => ({
        profile_id: profile.profile_id,
        capability_rank,
        rationale: 'policy rank ' + capability_rank,
      })),
    },
    capability_registry: new CapabilityRegistry(capabilities),
    execution_policy: policy(),
    candidate_preflights: [preflight('claude-mid'), preflight('codex-high')],
    ...overrides,
  };
}

describe('decideEscalation — cross-provider', () => {
  it('troca automaticamente entre providers autorizados por decisão do harness', () => {
    const result = decideEscalation(input());
    expect(result).toMatchObject({
      outcome: 'ESCALATE',
      classification: 'CAPABILITY',
      from_profile: { profile_id: 'codex-low', agent: 'codex' },
      to_profile: { profile_id: 'claude-mid', agent: 'claude' },
      discarded_steps: [],
      authorization: {
        cross_provider: true,
        from_provider: 'codex',
        to_provider: 'claude',
        decision_owner: 'agent_strategy_lab_harness',
        scope_capabilities: [
          'CAPABILITY_ESCALATION_WITHIN_LADDER',
          'CROSS_PROVIDER_WITHIN_ALLOWED_SUBSCRIPTION_PROFILES',
        ],
        provenance: 'project_execution_policy',
      },
    });
    if (result.outcome !== 'ESCALATE') throw new Error('unreachable');
    expect(result.authorization.preflight_provenance).toEqual(
      expect.arrayContaining(['fake provider probe', 'fake credential probe', 'fake quota probe']),
    );
  });

  it('usa a ordem configurada também na direção Claude para Codex', () => {
    const profiles = [capability('claude-low', 'claude'), capability('codex-mid', 'codex')];
    const result = decideEscalation({
      ...input(),
      repair_sequence: sequence('claude-low'),
      ladder: {
        schema_version: 1,
        ordering: 'CONFIGURED_CAPABILITY_ASCENDING',
        ordering_rationale: 'ordem configurada sem preferência de provider',
        steps: [
          { profile_id: 'claude-low', capability_rank: 0, rationale: 'low' },
          { profile_id: 'codex-mid', capability_rank: 1, rationale: 'high' },
        ],
      },
      capability_registry: new CapabilityRegistry(profiles),
      execution_policy: policy({
        allowed_profile_ids: ['claude-low', 'codex-mid'],
        allowed_providers: ['claude', 'codex'],
      }),
      candidate_preflights: [preflight('codex-mid')],
    });
    expect(result).toMatchObject({
      outcome: 'ESCALATE',
      from_profile: { profile_id: 'claude-low', agent: 'claude' },
      to_profile: { profile_id: 'codex-mid', agent: 'codex' },
      authorization: { cross_provider: true, from_provider: 'claude', to_provider: 'codex' },
    });
  });

  it.each([
    ['INFRA', 'RETRY_INFRA_SAME_PROFILE'],
    ['ENVIRONMENT_NOT_READY', 'REMEDIATE_ENVIRONMENT'],
  ] as const)('%s nunca considera o preflight cross-provider', (classification, action) => {
    const result = decideEscalation(
      input({
        diagnosis: diagnosis(classification),
        candidate_preflights: [
          preflight('claude-mid', {
            authorization: executionAuthorization({ authorization: 'DENIED' }),
          }),
        ],
      }),
    );
    expect(result).toMatchObject({
      outcome: 'NO_ESCALATION',
      classification,
      authorization: null,
      discarded_steps: [],
      intervention: {
        action,
        changes_profile: false,
        consumes_escalation_step: false,
      },
    });
  });

  it('mantém INFRA_ERROR capability-neutral via a classe provider-neutral INFRA de M79', () => {
    const infraErrorDiagnosis = diagnosis('INFRA');
    const result = decideEscalation(input({ diagnosis: infraErrorDiagnosis }));
    expect(result).toMatchObject({
      outcome: 'NO_ESCALATION',
      classification: 'INFRA',
      authorization: null,
      discarded_steps: [],
      intervention: { action: 'RETRY_INFRA_SAME_PROFILE', changes_profile: false },
    });
  });

  it('descarta provider, credencial, quota e billing indisponíveis sem capability FAIL', () => {
    const cases = [
      { candidate: preflight('claude-mid', { provider: false }), reason: 'PROVIDER_UNAVAILABLE' },
      { candidate: preflight('claude-mid', { credential: false }), reason: 'CREDENTIAL_MISSING' },
      {
        candidate: preflight('claude-mid', {
          authorization: executionAuthorization({ quota: 'INSUFFICIENT' }),
        }),
        reason: 'QUOTA_INSUFFICIENT',
      },
      {
        candidate: preflight('claude-mid', {
          authorization: executionAuthorization({ authorization: 'DENIED' }),
        }),
        reason: 'BILLING_GUARD_BLOCKED',
      },
    ] as const;
    for (const currentCase of cases) {
      expect(
        decideEscalation(
          input({ candidate_preflights: [currentCase.candidate, preflight('codex-high')] }),
        ),
      ).toMatchObject({
        outcome: 'ESCALATE',
        to_profile: { profile_id: 'codex-high' },
        discarded_steps: [
          {
            profile_id: 'claude-mid',
            reason_codes: expect.arrayContaining([currentCase.reason]),
            capability_failure: false,
            evaluation_outcome: 'NOT_EVALUATED',
          },
        ],
      });
    }
  });

  it('não escolhe profile API implicitamente, mesmo presente na policy', () => {
    const profiles = [
      capability('codex-low', 'codex'),
      capability('claude-api', 'claude', 'api'),
    ];
    const result = decideEscalation({
      ...input(),
      ladder: {
        schema_version: 1,
        ordering: 'CONFIGURED_CAPABILITY_ASCENDING',
        ordering_rationale: 'rank explícito',
        steps: [
          { profile_id: 'codex-low', capability_rank: 0, rationale: 'low' },
          { profile_id: 'claude-api', capability_rank: 1, rationale: 'high' },
        ],
      },
      capability_registry: new CapabilityRegistry(profiles),
      execution_policy: policy({
        allowed_profile_ids: ['codex-low', 'claude-api'],
        authorized_billing_modes: ['subscription_only', 'api'],
      }),
      candidate_preflights: [
        preflight('claude-api', {
          authorization: executionAuthorization({ billingMode: 'API' }),
        }),
      ],
    });
    expect(result).toMatchObject({
      outcome: 'HUMAN_REQUIRED',
      reason_code: 'SAFE_ESCALATION_EXHAUSTED',
      discarded_steps: [
        {
          profile_id: 'claude-api',
          reason_codes: ['API_BILLING_REQUIRES_EXPLICIT_SELECTION'],
          capability_failure: false,
        },
      ],
    });
  });

  it('exige humano para provider, profile ou capability fora da execution policy', () => {
    for (const executionPolicy of [
      policy({ allowed_providers: ['codex'] }),
      policy({ allowed_profile_ids: ['codex-low', 'codex-high'] }),
    ]) {
      expect(decideEscalation(input({ execution_policy: executionPolicy }))).toMatchObject({
        outcome: 'HUMAN_REQUIRED',
        reason_code: 'PROFILE_OR_PROVIDER_OUTSIDE_POLICY',
        authorization: null,
      });
    }
    expect(
      decideEscalation(
        input({
          execution_policy: policy({
            authorization_scope: {
              ...policy().authorization_scope,
              autonomous_execution_boundary: [
                'BOUNDED_REPAIR',
                'CAPABILITY_ESCALATION_WITHIN_LADDER',
              ],
            },
          }),
        }),
      ),
    ).toMatchObject({
      outcome: 'HUMAN_REQUIRED',
      reason_code: 'ESCALATION_NOT_AUTHORIZED',
      authorization: null,
    });
  });

  it('expõe o motivo de cada degrau quando todos estão indisponíveis', () => {
    const result = decideEscalation(
      input({
        candidate_preflights: [
          preflight('claude-mid', { credential: false }),
          preflight('codex-high', { provider: false }),
        ],
      }),
    );
    expect(result).toMatchObject({
      outcome: 'HUMAN_REQUIRED',
      reason_code: 'SAFE_ESCALATION_EXHAUSTED',
      authorization: null,
      discarded_steps: [
        { profile_id: 'claude-mid', reason_codes: expect.arrayContaining(['CREDENTIAL_MISSING']) },
        { profile_id: 'codex-high', reason_codes: expect.arrayContaining(['PROVIDER_UNAVAILABLE']) },
      ],
    });
    if (result.outcome !== 'HUMAN_REQUIRED') throw new Error('unreachable');
    expect(result.human_required.why_automation_stopped).toContain('claude-mid');
    expect(result.human_required.why_automation_stopped).toContain('codex-high');
  });
});
