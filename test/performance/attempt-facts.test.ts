import { describe, expect, it } from 'vitest';

import { EvaluationOutcome, ExecutionStatus } from '../../src/core/index.js';
import {
  AttemptRole,
  deriveAttemptFacts,
  type AttemptFactsInput,
} from '../../src/performance/index.js';
import { InterventionType } from '../../src/schemas/index.js';

function baseInput(overrides: Partial<AttemptFactsInput> = {}): AttemptFactsInput {
  return {
    execution_status: ExecutionStatus.COMPLETED,
    evaluation_outcome: EvaluationOutcome.PASS,
    attempt_role: AttemptRole.INITIAL,
    interventions: [],
    inference_evidence: {
      model_events_observed: false,
      zero_inference_proven: false,
    },
    ...overrides,
  };
}

describe('deriveAttemptFacts', () => {
  it('produces had_inference null for INFRA_ERROR with no events and no authoritative zero proof', () => {
    const facts = deriveAttemptFacts(
      baseInput({
        execution_status: ExecutionStatus.INFRA_ERROR,
        evaluation_outcome: null,
        inference_evidence: { model_events_observed: false, zero_inference_proven: false },
      }),
    );

    expect(facts.execution_status).toBe(ExecutionStatus.INFRA_ERROR);
    expect(facts.had_inference.value).toBeNull();
    expect(facts.had_inference.provenance).toBeTruthy();
  });

  it('produces had_inference false for INFRA_ERROR with authoritative zero-inference proof', () => {
    const facts = deriveAttemptFacts(
      baseInput({
        execution_status: ExecutionStatus.INFRA_ERROR,
        evaluation_outcome: null,
        inference_evidence: { model_events_observed: false, zero_inference_proven: true },
      }),
    );

    expect(facts.had_inference.value).toBe(false);
    expect(facts.had_inference.provenance).toBeTruthy();
  });

  it('produces had_inference true for INFRA_ERROR with positive inference proof', () => {
    const facts = deriveAttemptFacts(
      baseInput({
        execution_status: ExecutionStatus.INFRA_ERROR,
        evaluation_outcome: null,
        inference_evidence: { model_events_observed: true, zero_inference_proven: false },
      }),
    );

    expect(facts.had_inference.value).toBe(true);
    expect(facts.had_inference.provenance).toBeTruthy();
  });

  it('produces had_inference true for TIMED_OUT with model events', () => {
    const facts = deriveAttemptFacts(
      baseInput({
        execution_status: ExecutionStatus.TIMED_OUT,
        evaluation_outcome: null,
        inference_evidence: { model_events_observed: true, zero_inference_proven: false },
      }),
    );

    expect(facts.execution_status).toBe(ExecutionStatus.TIMED_OUT);
    expect(facts.had_inference.value).toBe(true);
  });

  it('never produces had_inference false from absence of evidence alone', () => {
    for (const execution_status of Object.values(ExecutionStatus)) {
      const facts = deriveAttemptFacts(
        baseInput({
          execution_status,
          evaluation_outcome: null,
          inference_evidence: { model_events_observed: false, zero_inference_proven: false },
        }),
      );

      expect(facts.had_inference.value).not.toBe(false);
      expect(facts.had_inference.value).toBeNull();
      expect(facts.had_inference.provenance).toBeTruthy();
    }
  });

  it('passes execution_status through unchanged', () => {
    for (const execution_status of Object.values(ExecutionStatus)) {
      const facts = deriveAttemptFacts(baseInput({ execution_status }));

      expect(facts.execution_status).toBe(execution_status);
    }
  });

  it('passes evaluation_outcome through unchanged, including null when not evaluated', () => {
    expect(deriveAttemptFacts(baseInput({ evaluation_outcome: null })).evaluation_outcome).toBeNull();
    expect(
      deriveAttemptFacts(baseInput({ evaluation_outcome: EvaluationOutcome.FAIL })).evaluation_outcome,
    ).toBe(EvaluationOutcome.FAIL);
  });

  it('passes attempt_role through unchanged for every role', () => {
    for (const attempt_role of Object.values(AttemptRole)) {
      expect(deriveAttemptFacts(baseInput({ attempt_role })).attempt_role).toBe(attempt_role);
    }
  });

  it('distinguishes an empty intervention list (recorded zero) from null (unknown)', () => {
    expect(deriveAttemptFacts(baseInput({ interventions: [] })).interventions).toEqual([]);
    expect(deriveAttemptFacts(baseInput({ interventions: null })).interventions).toBeNull();
  });

  it('passes through recorded interventions unchanged', () => {
    const interventions = [
      {
        intervention_id: 'intervention-001',
        type: InterventionType.OPERATIONAL_CLEANUP,
        description: 'Reiniciado o worker travado.',
        occurred_at: '2026-08-11T12:00:00.000Z',
        affects_autonomy: false,
      },
    ];

    expect(deriveAttemptFacts(baseInput({ interventions })).interventions).toEqual(interventions);
  });
});
