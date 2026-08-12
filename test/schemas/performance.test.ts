import { describe, expect, it } from 'vitest';

import { EvaluationOutcome, ExecutionStatus, QualificationStatus } from '../../src/core/index.js';
import { AttemptRole } from '../../src/performance/index.js';
import {
  InterventionType,
  QuotaObservationStatus,
  QuotaReasonCode,
  RunPerformanceRecord,
  TaskPerformanceRecord,
} from '../../src/schemas/index.js';

const sha = 'a'.repeat(64);

function validRunRecord(): RunPerformanceRecord {
  return {
    schema_version: 1,
    identity: {
      task_id: 'task-001',
      taxonomy: { task_class: 'bugfix', difficulty: 'medium' },
      stack: ['typescript'],
      agent_cli: 'claude',
      model: 'claude-sonnet-5',
      reasoning_effort: { value: 'medium', provenance: 'agent_profile' },
      strategy: { name: 'baseline', version: 1 },
      environment_profile: { id: 'env-001', mode: 'controlled' },
      execution_envelope_sha256: sha,
      evaluation_envelope_sha256: sha,
      evaluation_id: 'evaluation-001',
      score_id: 'score-001',
    },
    quality: {
      execution_status: ExecutionStatus.COMPLETED,
      evaluation_outcome: EvaluationOutcome.PASS,
      qualification_status: QualificationStatus.QUALIFIED,
      score_profile_id: 'default',
      score_profile_version: '1.0.0',
      sub_scores: {
        outcome: { value: 1, weight: 1, required: true },
      },
      coverage: 1,
    },
    facts: {
      had_inference: { value: true, provenance: 'model_events_observed' },
      attempt_role: AttemptRole.INITIAL,
      interventions: [],
    },
    cost: {
      duration_ms: 12_345,
      tokens: {
        total_tokens: { value: 1000, provenance: 'execution_record' },
        input_tokens: { value: 800, provenance: 'execution_record' },
        cached_input_tokens: { value: 200, provenance: 'execution_record' },
        fresh_input_tokens: { value: 600, provenance: 'derived_input_minus_cached' },
        output_tokens: { value: 200, provenance: 'execution_record' },
        reasoning_tokens: { value: 0, provenance: 'execution_record' },
      },
      api_equivalent_usd: { value: 0.42, provenance: 'execution_record' },
      quota_usage: {
        value: {
          provider: 'anthropic',
          observation: {
            status: QuotaObservationStatus.OBSERVED,
            reason_code: QuotaReasonCode.OK,
            provenance: 'provider_probe',
          },
          windows: [],
        },
        provenance: 'provider_probe',
      },
    },
  };
}

function validTaskRecord(): TaskPerformanceRecord {
  return {
    schema_version: 1,
    task_id: 'task-001',
    trial_id: 'trial-001',
    attempts: {
      operational_attempts: 3,
      attempts_with_inference: 2,
      attempts_without_inference: 0,
      attempts_inference_unknown: 1,
      infra_error_attempts: 0,
      repair_attempts: 1,
      escalations: 0,
      attempts_role_unknown: 0,
    },
    success: {
      first_operational_pass: true,
      first_inference_bearing_pass: true,
      autonomous_first_pass: false,
      final_pass: true,
    },
    intervention: {
      human_intervention: { value: true, provenance: 'intervention_log' },
      intervention_types: [InterventionType.MANUAL_FIX],
    },
  };
}

describe('RunPerformanceRecord', () => {
  it('parses a complete run record', () => {
    const input = validRunRecord();

    expect(RunPerformanceRecord.parse(input)).toEqual(input);
  });

  it('parses without taxonomy when absent', () => {
    const { taxonomy: _taxonomy, ...identity } = validRunRecord().identity;
    const input = { ...validRunRecord(), identity };

    expect(RunPerformanceRecord.parse(input)).toEqual(input);
  });

  it('accepts had_inference null with provenance', () => {
    const input: RunPerformanceRecord = {
      ...validRunRecord(),
      facts: {
        ...validRunRecord().facts,
        had_inference: { value: null, provenance: 'insufficient_evidence' },
      },
    };

    expect(RunPerformanceRecord.parse(input)).toEqual(input);
  });

  it('accepts a QUALITY section with sub_scores/coverage/score_profile all null and no scalar score', () => {
    const input: RunPerformanceRecord = {
      ...validRunRecord(),
      quality: {
        execution_status: ExecutionStatus.INFRA_ERROR,
        evaluation_outcome: EvaluationOutcome.NOT_EVALUATED,
        qualification_status: QualificationStatus.UNSCORABLE,
        score_profile_id: null,
        score_profile_version: null,
        sub_scores: null,
        coverage: null,
      },
    };

    expect(RunPerformanceRecord.parse(input)).toEqual(input);
  });

  it.each(['score', 'aggregate_score', 'total_score', 'weighted_score'])(
    'rejects a scalar %s field on quality',
    (field) => {
      const input = {
        ...validRunRecord(),
        quality: { ...validRunRecord().quality, [field]: 0.9 },
      };

      expect(RunPerformanceRecord.safeParse(input).success).toBe(false);
    },
  );

  it('rejects unknown top-level fields', () => {
    expect(RunPerformanceRecord.safeParse({ ...validRunRecord(), extra: true }).success).toBe(
      false,
    );
  });

  it('rejects null evaluation_id and score_id being anything other than identifier or null', () => {
    const input: RunPerformanceRecord = {
      ...validRunRecord(),
      identity: { ...validRunRecord().identity, evaluation_id: null, score_id: null },
    };

    expect(RunPerformanceRecord.parse(input)).toEqual(input);
    expect(
      RunPerformanceRecord.safeParse({
        ...validRunRecord(),
        identity: { ...validRunRecord().identity, evaluation_id: '' },
      }).success,
    ).toBe(false);
  });
});

describe('TaskPerformanceRecord', () => {
  it('parses a complete task record', () => {
    const input = validTaskRecord();

    expect(TaskPerformanceRecord.parse(input)).toEqual(input);
  });

  it('accepts human_intervention null with provenance and forces autonomous_first_pass null', () => {
    const input: TaskPerformanceRecord = {
      ...validTaskRecord(),
      success: { ...validTaskRecord().success, autonomous_first_pass: null },
      intervention: {
        human_intervention: { value: null, provenance: 'no_intervention_log' },
        intervention_types: [],
      },
    };

    expect(TaskPerformanceRecord.parse(input)).toEqual(input);
  });

  it('rejects human_intervention null with autonomous_first_pass non-null', () => {
    const input = {
      ...validTaskRecord(),
      success: { ...validTaskRecord().success, autonomous_first_pass: false },
      intervention: {
        human_intervention: { value: null, provenance: 'no_intervention_log' },
        intervention_types: [],
      },
    };

    expect(TaskPerformanceRecord.safeParse(input).success).toBe(false);
  });

  it('validates that attempts_with_inference + attempts_without_inference + attempts_inference_unknown equals operational_attempts', () => {
    const input = {
      ...validTaskRecord(),
      attempts: { ...validTaskRecord().attempts, attempts_with_inference: 99 },
    };

    expect(TaskPerformanceRecord.safeParse(input).success).toBe(false);
  });

  it('accepts infra_error_attempts intersecting attempts_with_inference', () => {
    const input: TaskPerformanceRecord = {
      ...validTaskRecord(),
      attempts: {
        operational_attempts: 2,
        attempts_with_inference: 2,
        attempts_without_inference: 0,
        attempts_inference_unknown: 0,
        infra_error_attempts: 2,
        repair_attempts: 0,
        escalations: 0,
        attempts_role_unknown: 0,
      },
    };

    expect(TaskPerformanceRecord.parse(input)).toEqual(input);
  });

  it('rejects autonomous_first_pass true when human_intervention is true', () => {
    const input = {
      ...validTaskRecord(),
      success: { ...validTaskRecord().success, autonomous_first_pass: true },
      intervention: {
        human_intervention: { value: true, provenance: 'intervention_log' },
        intervention_types: [InterventionType.MANUAL_FIX],
      },
    };

    expect(TaskPerformanceRecord.safeParse(input).success).toBe(false);
  });

  it('rejects autonomous_first_pass true when human_intervention is null', () => {
    const input = {
      ...validTaskRecord(),
      success: { ...validTaskRecord().success, autonomous_first_pass: true },
      intervention: {
        human_intervention: { value: null, provenance: 'no_intervention_log' },
        intervention_types: [],
      },
    };

    expect(TaskPerformanceRecord.safeParse(input).success).toBe(false);
  });

  it('accepts autonomous_first_pass true when human_intervention is false', () => {
    const input: TaskPerformanceRecord = {
      ...validTaskRecord(),
      success: { ...validTaskRecord().success, autonomous_first_pass: true },
      intervention: {
        human_intervention: { value: false, provenance: 'no_intervention_recorded' },
        intervention_types: [],
      },
    };

    expect(TaskPerformanceRecord.parse(input)).toEqual(input);
  });

  it('rejects unknown top-level fields', () => {
    expect(TaskPerformanceRecord.safeParse({ ...validTaskRecord(), extra: true }).success).toBe(
      false,
    );
  });
});
