import { describe, expect, it } from 'vitest';

import { EvaluationOutcome, ExecutionStatus } from '../../src/core/index.js';
import {
  AttemptRole,
  deriveAttemptFacts,
  derivePerformance,
  type AttemptFacts,
  type AttemptFactsInput,
  type AttemptHistory,
} from '../../src/performance/index.js';
import { InterventionType } from '../../src/schemas/index.js';

function attempt(overrides: Partial<AttemptFactsInput> = {}): AttemptFacts {
  return deriveAttemptFacts({
    execution_status: ExecutionStatus.COMPLETED,
    evaluation_outcome: EvaluationOutcome.PASS,
    attempt_role: AttemptRole.INITIAL,
    interventions: [],
    inference_evidence: {
      model_events_observed: true,
      zero_inference_proven: false,
    },
    ...overrides,
  });
}

function history(attempts: readonly AttemptFacts[], overrides: Partial<AttemptHistory> = {}): AttemptHistory {
  return {
    task_id: 'task-001',
    trial_id: 'trial-001',
    attempts,
    ...overrides,
  };
}

describe('derivePerformance', () => {
  it('M26-like: single PASS attempt with an operational intervention is not autonomous', () => {
    const record = derivePerformance(
      history([
        attempt({
          interventions: [
            {
              intervention_id: 'intervention-001',
              type: InterventionType.OPERATIONAL_CLEANUP,
              description: 'Reiniciado o worker travado.',
              occurred_at: '2026-08-11T12:00:00.000Z',
              affects_autonomy: false,
            },
          ],
        }),
      ]),
    );

    expect(record.success.final_pass).toBe(true);
    expect(record.success.autonomous_first_pass).toBe(false);
    expect(record.intervention.human_intervention.value).toBe(true);
  });

  it('M33-like: proven-zero-inference INFRA_ERROR followed by an inference-bearing PASS', () => {
    const record = derivePerformance(
      history([
        attempt({
          execution_status: ExecutionStatus.INFRA_ERROR,
          evaluation_outcome: null,
          inference_evidence: { model_events_observed: false, zero_inference_proven: true },
        }),
        attempt({
          attempt_role: AttemptRole.INITIAL,
          evaluation_outcome: EvaluationOutcome.PASS,
          inference_evidence: { model_events_observed: true, zero_inference_proven: false },
        }),
      ]),
    );

    expect(record.attempts.operational_attempts).toBe(2);
    expect(record.attempts.attempts_with_inference).toBe(1);
    expect(record.attempts.attempts_without_inference).toBe(1);
    expect(record.attempts.attempts_inference_unknown).toBe(0);
    expect(record.attempts.infra_error_attempts).toBe(1);
    expect(record.attempts.repair_attempts).toBe(0);
    expect(record.attempts.escalations).toBe(0);
    expect(record.success.first_operational_pass).toBe(false);
    expect(record.success.first_inference_bearing_pass).toBe(true);
    expect(record.success.final_pass).toBe(true);
  });

  it('infra-inference-unknown: INFRA_ERROR with no events and no authoritative zero proof is distinct from M33-like', () => {
    const record = derivePerformance(
      history([
        attempt({
          execution_status: ExecutionStatus.INFRA_ERROR,
          evaluation_outcome: null,
          inference_evidence: { model_events_observed: false, zero_inference_proven: false },
        }),
      ]),
    );

    expect(record.attempts.infra_error_attempts).toBe(1);
    expect(record.attempts.attempts_with_inference).toBe(0);
    expect(record.attempts.attempts_without_inference).toBe(0);
    expect(record.attempts.attempts_inference_unknown).toBe(1);
  });

  it('M39B-like: legitimate FAIL on attempt 1 (ignoring a false self-report) then a PASS repair', () => {
    const record = derivePerformance(
      history([
        attempt({ evaluation_outcome: EvaluationOutcome.FAIL }),
        attempt({ attempt_role: AttemptRole.REPAIR, evaluation_outcome: EvaluationOutcome.PASS }),
      ]),
    );

    expect(record.attempts.repair_attempts).toBe(1);
    expect(record.attempts.escalations).toBe(0);
    expect(record.success.first_inference_bearing_pass).toBe(false);
    expect(record.success.final_pass).toBe(true);
  });

  it('M23-like: a same-effort repair fails and an escalation attempt passes', () => {
    const record = derivePerformance(
      history([
        attempt({ attempt_role: AttemptRole.REPAIR, evaluation_outcome: EvaluationOutcome.FAIL }),
        attempt({ attempt_role: AttemptRole.ESCALATION, evaluation_outcome: EvaluationOutcome.PASS }),
      ]),
    );

    expect(record.attempts.escalations).toBe(1);
    expect(record.success.final_pass).toBe(true);
  });

  it('infra-after-inference: INFRA_ERROR with proven inference then a PASS, distinct from the other two INFRA cases', () => {
    const record = derivePerformance(
      history([
        attempt({
          execution_status: ExecutionStatus.INFRA_ERROR,
          evaluation_outcome: null,
          inference_evidence: { model_events_observed: true, zero_inference_proven: false },
        }),
        attempt({ attempt_role: AttemptRole.INITIAL, evaluation_outcome: EvaluationOutcome.PASS }),
      ]),
    );

    expect(record.attempts.infra_error_attempts).toBe(1);
    expect(record.attempts.attempts_with_inference).toBe(2);
    expect(record.attempts.attempts_without_inference).toBe(0);
    expect(record.attempts.repair_attempts).toBe(0);
  });

  it('operational attempt number > 1 after INFRA_ERROR does not imply REPAIR', () => {
    const record = derivePerformance(
      history([
        attempt({
          execution_status: ExecutionStatus.INFRA_ERROR,
          evaluation_outcome: null,
          inference_evidence: { model_events_observed: false, zero_inference_proven: true },
        }),
        attempt({
          attempt_role: AttemptRole.INITIAL,
          evaluation_outcome: EvaluationOutcome.PASS,
        }),
      ]),
    );

    // Role comes from AttemptHistory, not from operational index/number.
    expect(record.attempts.operational_attempts).toBe(2);
    expect(record.attempts.repair_attempts).toBe(0);
    expect(record.attempts.escalations).toBe(0);
  });

  it('unknown-intervention: no intervention record at all never becomes a proven zero', () => {
    const record = derivePerformance(history([attempt({ interventions: null })]));

    expect(record.intervention.human_intervention.value).toBeNull();
    expect(record.intervention.human_intervention.provenance).toBe('not_recorded');
    expect(record.success.autonomous_first_pass).toBeNull();
  });

  it('the seven fixtures each produce a distinct record', () => {
    const records = [
      derivePerformance(
        history([
          attempt({
            interventions: [
              {
                intervention_id: 'intervention-001',
                type: InterventionType.OPERATIONAL_CLEANUP,
                description: 'Reiniciado o worker travado.',
                occurred_at: '2026-08-11T12:00:00.000Z',
                affects_autonomy: false,
              },
            ],
          }),
        ]),
      ),
      derivePerformance(
        history([
          attempt({
            execution_status: ExecutionStatus.INFRA_ERROR,
            evaluation_outcome: null,
            inference_evidence: { model_events_observed: false, zero_inference_proven: true },
          }),
          attempt({
            attempt_role: AttemptRole.INITIAL,
            evaluation_outcome: EvaluationOutcome.PASS,
            inference_evidence: { model_events_observed: true, zero_inference_proven: false },
          }),
        ]),
      ),
      derivePerformance(
        history([
          attempt({
            execution_status: ExecutionStatus.INFRA_ERROR,
            evaluation_outcome: null,
            inference_evidence: { model_events_observed: false, zero_inference_proven: false },
          }),
        ]),
      ),
      derivePerformance(
        history([
          attempt({ evaluation_outcome: EvaluationOutcome.FAIL }),
          attempt({ attempt_role: AttemptRole.REPAIR, evaluation_outcome: EvaluationOutcome.PASS }),
        ]),
      ),
      derivePerformance(
        history([
          attempt({ attempt_role: AttemptRole.REPAIR, evaluation_outcome: EvaluationOutcome.FAIL }),
          attempt({ attempt_role: AttemptRole.ESCALATION, evaluation_outcome: EvaluationOutcome.PASS }),
        ]),
      ),
      derivePerformance(
        history([
          attempt({
            execution_status: ExecutionStatus.INFRA_ERROR,
            evaluation_outcome: null,
            inference_evidence: { model_events_observed: true, zero_inference_proven: false },
          }),
          attempt({ attempt_role: AttemptRole.INITIAL, evaluation_outcome: EvaluationOutcome.PASS }),
        ]),
      ),
      derivePerformance(history([attempt({ interventions: null })])),
    ];

    const serialized = records.map((record) => JSON.stringify(record));
    expect(new Set(serialized).size).toBe(records.length);
  });

  it('is deterministic: same input produces the same canonical bytes', () => {
    const input = history([
      attempt({
        interventions: [
          {
            intervention_id: 'intervention-001',
            type: InterventionType.MANUAL_FIX,
            description: 'Corrigido manualmente o estado.',
            occurred_at: '2026-08-11T12:00:00.000Z',
            affects_autonomy: true,
          },
        ],
      }),
      attempt({ attempt_role: AttemptRole.REPAIR, evaluation_outcome: EvaluationOutcome.FAIL }),
    ]);

    const first = JSON.stringify(derivePerformance(input));
    const second = JSON.stringify(derivePerformance(input));
    expect(first).toBe(second);
  });
});
