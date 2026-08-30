import { describe, expect, it } from 'vitest';

import { AttemptRole } from '../../src/performance/index.js';
import {
  HumanAuthority,
  HumanGatedCapability,
  TechnicalBlocker,
} from '../../src/intake/index.js';
import {
  CapabilityRegistry,
  capabilityOf,
  decideEscalation,
  decideFailureIntervention,
  routeInitialProfile,
  type EscalationDecisionInput,
  type EscalationExecutionPolicy,
  type EscalationLadder,
  type FailureDiagnosis,
  type ProfileCapability,
  type RepairSequenceEvidence,
} from '../../src/routing/index.js';

/**
 * PROPRIEDADE CENTRAL DESTE PR:
 *
 *   `HUMAN_REQUIRED` só existe quando o Lab consegue nomear a autoridade que
 *   apenas um humano fornece. Todo o resto que antes parava a run pedindo uma
 *   decisão humana continua parando — como BLOQUEIO TÉCNICO tipado.
 */
describe('HumanAuthority é fechado e não tem escape hatch', () => {
  it('não oferece OTHER/UNKNOWN/GENERIC/TECHNICAL_PROBLEM', () => {
    for (const forbidden of ['OTHER', 'UNKNOWN', 'GENERIC', 'TECHNICAL_PROBLEM']) {
      expect(HumanAuthority.options).not.toContain(forbidden);
    }
  });

  it('INSUFFICIENT_EVIDENCE não é autoridade humana, e é a única diferença', () => {
    expect(HumanAuthority.options).not.toContain('INSUFFICIENT_EVIDENCE');
    const missing = HumanGatedCapability.options.filter(
      (capability) => !(HumanAuthority.options as readonly string[]).includes(capability),
    );
    expect(missing).toEqual(['INSUFFICIENT_EVIDENCE']);
  });

  it('toda autoridade continua sendo uma categoria human-gated conhecida', () => {
    for (const authority of HumanAuthority.options) {
      expect(HumanGatedCapability.options).toContain(authority);
    }
  });

  it('nenhum blocker técnico se apresenta como autoridade humana', () => {
    for (const blocker of TechnicalBlocker.options) {
      expect(HumanAuthority.safeParse(blocker).success).toBe(false);
    }
  });
});

const diagnosisOf = (
  classification: FailureDiagnosis['classification'],
): FailureDiagnosis => ({
  schema_version: 1,
  classification,
  rationale: `diagnóstico ${classification}`,
  boundary: 'bounded repair já consumido',
  retry_budget: {
    kind: 'BOUNDED_REPAIR',
    maximum_attempts: 1,
    attempts_used: 1,
    same_profile_required: true,
  },
  decision_needed: 'decidir o próximo passo',
  why_automation_stopped: 'automação parou',
  options: ['inspecionar a evidência'],
  evidence_paths: ['failed-attempts/t/attempt-1'],
  provenance: ['orchestrator'],
});

describe('failure diagnosis nunca fabrica HUMAN_REQUIRED', () => {
  it('falha técnica de provider com recuperação já autorizada apenas repete o profile', () => {
    const decision = decideFailureIntervention(diagnosisOf('INFRA'));
    expect(decision.status).toBe('ACTION_REQUIRED');
    expect(decision.human_required).toBeNull();
    if (decision.status !== 'ACTION_REQUIRED') throw new Error('esperava ACTION_REQUIRED');
    expect(decision.action).toBe('RETRY_INFRA_SAME_PROFILE');
  });

  it('evidência insuficiente vira blocker técnico, não decisão humana', () => {
    const decision = decideFailureIntervention(diagnosisOf('UNKNOWN_INSUFFICIENT_EVIDENCE'));
    expect(decision.status).toBe('TECHNICAL_BLOCKER');
    expect(decision.human_required).toBeNull();
    if (decision.status !== 'TECHNICAL_BLOCKER') throw new Error('esperava TECHNICAL_BLOCKER');
    expect(decision.blocker).toBe('INSUFFICIENT_EVIDENCE');
    // Fail-closed preservado: nada avança e nenhum degrau é consumido.
    expect(decision.action).toBe('NONE');
    expect(decision.consumes_escalation_step).toBe(false);
    expect(decision.changes_profile).toBe(false);
  });

  it('tooling quebrada sem remediação vira blocker técnico e continua fail-closed', () => {
    const decision = decideFailureIntervention(diagnosisOf('VALIDATION_OR_TOOLING_GAP'));
    expect(decision.status).toBe('TECHNICAL_BLOCKER');
    if (decision.status !== 'TECHNICAL_BLOCKER') throw new Error('esperava TECHNICAL_BLOCKER');
    expect(decision.blocker).toBe('VALIDATION_OR_TOOLING_GAP');
    expect(decision.action).toBe('NONE');
  });

  it('tooling quebrada COM remediação conhecida é resolvida sozinha', () => {
    const decision = decideFailureIntervention(diagnosisOf('VALIDATION_OR_TOOLING_GAP'), {
      harness_remediation_available: true,
    });
    expect(decision.status).toBe('ACTION_REQUIRED');
    if (decision.status !== 'ACTION_REQUIRED') throw new Error('esperava ACTION_REQUIRED');
    expect(decision.action).toBe('REPAIR_HARNESS_OR_TOOLING');
  });
});

const capability = (
  profileId: string,
  overrides: Partial<Parameters<typeof capabilityOf>[0]> = {},
): ProfileCapability =>
  capabilityOf({
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

const LADDER: EscalationLadder = {
  schema_version: 1,
  ordering: 'CONFIGURED_CAPABILITY_ASCENDING',
  ordering_rationale: 'ranks declarados na policy do projeto',
  steps: [
    { profile_id: 'profile-low', capability_rank: 0, rationale: 'degrau inicial' },
    { profile_id: 'profile-high', capability_rank: 1, rationale: 'degrau seguinte' },
  ],
};

const POLICY: EscalationExecutionPolicy = {
  schema_version: 1,
  authorization_scope: {
    schema_version: 1,
    requested_scope: { summary: 'implementar a task' },
    autonomous_execution_boundary: ['BOUNDED_REPAIR', 'CAPABILITY_ESCALATION_WITHIN_LADDER'],
    human_gated_capabilities: ['UNAUTHORIZED_API_BILLING', 'SCOPE_EXPANSION'],
  },
  allowed_profile_ids: ['profile-low', 'profile-high'],
  allowed_providers: ['codex'],
  authorized_billing_modes: ['subscription_only'],
  evidence_paths: ['policy/execution.json'],
  provenance: 'project_execution_policy',
};

const SEQUENCE: RepairSequenceEvidence = {
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
};

const escalationInput = (
  overrides: Partial<EscalationDecisionInput> = {},
  capabilities: readonly ProfileCapability[] = [
    capability('profile-low'),
    capability('profile-high'),
  ],
): EscalationDecisionInput => ({
  diagnosis: diagnosisOf('CAPABILITY'),
  repair_sequence: SEQUENCE,
  ladder: LADDER,
  capability_registry: new CapabilityRegistry(capabilities),
  execution_policy: POLICY,
  ...overrides,
});

describe('escalation separa fronteira de autorização de defeito de evidência', () => {
  it('ladder esgotada é HUMAN_REQUIRED com autoridade nomeada', () => {
    // O profile atual JÁ é o último degrau: a ladder autorizada acabou, e só
    // o operador pode ampliá-la.
    const decision = decideEscalation(
      escalationInput({
        repair_sequence: {
          initial: { ...SEQUENCE.initial, profile_id: 'profile-high' },
          repair: { ...SEQUENCE.repair, profile_id: 'profile-high' },
        },
      }),
    );
    expect(decision.outcome).toBe('HUMAN_REQUIRED');
    if (decision.outcome !== 'HUMAN_REQUIRED') throw new Error('esperava HUMAN_REQUIRED');
    expect(decision.reason_code).toBe('SAFE_ESCALATION_EXHAUSTED');
    expect(decision.human_required.human_authority).toBe('SAFE_ESCALATION_EXHAUSTED');
    expect(HumanAuthority.safeParse(decision.human_required.human_authority).success).toBe(true);
  });

  it('escalation fora do boundary autorizado nomeia SCOPE_EXPANSION', () => {
    const decision = decideEscalation(
      escalationInput({
        execution_policy: {
          ...POLICY,
          authorization_scope: {
            ...POLICY.authorization_scope,
            autonomous_execution_boundary: ['BOUNDED_REPAIR'],
          },
        },
      }),
    );
    expect(decision.outcome).toBe('HUMAN_REQUIRED');
    if (decision.outcome !== 'HUMAN_REQUIRED') throw new Error('esperava HUMAN_REQUIRED');
    expect(decision.reason_code).toBe('ESCALATION_NOT_AUTHORIZED');
    expect(decision.human_required.human_authority).toBe('SCOPE_EXPANSION');
  });

  it('billing por API não autorizado nomeia a autoridade de cobrança', () => {
    const decision = decideEscalation(
      escalationInput({}, [
        capability('profile-low'),
        capability('profile-high', { billing_mode: 'api' }),
      ]),
    );
    expect(decision.outcome).toBe('HUMAN_REQUIRED');
    if (decision.outcome !== 'HUMAN_REQUIRED') throw new Error('esperava HUMAN_REQUIRED');
    expect(decision.reason_code).toBe('UNAUTHORIZED_API_BILLING');
    expect(decision.human_required.human_authority).toBe('UNAUTHORIZED_API_BILLING');
  });

  it('registry incompleto é blocker técnico, não pedido de autorização', () => {
    const decision = decideEscalation(escalationInput({}, [capability('profile-low')]));
    expect(decision.outcome).toBe('TECHNICAL_BLOCKER');
    if (decision.outcome !== 'TECHNICAL_BLOCKER') throw new Error('esperava TECHNICAL_BLOCKER');
    expect(decision.blocker).toBe('RUNTIME_CONFIGURATION_INVALID');
    // Fail-closed: nenhum degrau autorizado, nenhum provider escolhido.
    expect(decision.authorization).toBeNull();
    expect(decision.attempt_role).toBeNull();
    expect(decision.human_required).toBeNull();
  });

  it('sequência de repair inválida é blocker técnico e não concede degrau', () => {
    const decision = decideEscalation(
      escalationInput({ repair_sequence: { schema_version: 1 } as never }),
    );
    expect(decision.outcome).toBe('TECHNICAL_BLOCKER');
    if (decision.outcome !== 'TECHNICAL_BLOCKER') throw new Error('esperava TECHNICAL_BLOCKER');
    expect(decision.reason_code).toBe('INVALID_REPAIR_SEQUENCE');
    expect(decision.blocker).toBe('INSUFFICIENT_EVIDENCE');
    expect(decision.authorization).toBeNull();
  });

  it('histórico de autorização incoerente é INVALID_PROVENANCE, e nada é concedido', () => {
    const decision = decideEscalation(
      escalationInput({
        prior_authorizations: [
          {
            decision: 'ALLOWED',
            schema_version: 1,
            step_index: 1,
            from_profile_id: 'inexistente',
            to_profile_id: 'profile-high',
          } as never,
        ],
      }),
    );
    expect(decision.outcome).toBe('TECHNICAL_BLOCKER');
    if (decision.outcome !== 'TECHNICAL_BLOCKER') throw new Error('esperava TECHNICAL_BLOCKER');
    expect(decision.blocker).toBe('INVALID_PROVENANCE');
    expect(decision.authorization).toBeNull();
  });

  it('escalation legítima continua sendo concedida sem gate humano', () => {
    const decision = decideEscalation(escalationInput());
    expect(decision.outcome).toBe('ESCALATE');
    if (decision.outcome !== 'ESCALATE') throw new Error('esperava ESCALATE');
    expect(decision.to_profile.profile_id).toBe('profile-high');
    expect(decision.human_required).toBeNull();
  });
});

describe('routing bloqueado nunca se apresenta como decisão humana', () => {
  it('lista de candidatos vazia é BLOCKED técnico e não oferece gate humano', () => {
    const result = routeInitialProfile({
      work_unit: {} as never,
      role: 'implementer',
      capability_registry: new CapabilityRegistry([]),
      candidates: [],
    });
    expect(result.outcome).toBe('BLOCKED');
    if (result.outcome !== 'BLOCKED') throw new Error('esperava BLOCKED');
    expect(TechnicalBlocker.safeParse(result.blocker).success).toBe(true);
    expect(result.allowed_next_steps).not.toContain('HUMAN_REQUIRED');
  });

  it('role inválido é configuração de runtime, não autorização', () => {
    const result = routeInitialProfile({
      work_unit: {} as never,
      role: 'inexistente' as never,
      capability_registry: new CapabilityRegistry([]),
      candidates: [],
    });
    expect(result.outcome).toBe('BLOCKED');
    if (result.outcome !== 'BLOCKED') throw new Error('esperava BLOCKED');
    expect(result.blocker).toBe('RUNTIME_CONFIGURATION_INVALID');
  });
});
