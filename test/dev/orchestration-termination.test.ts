import { describe, expect, it } from 'vitest';
import { exitCodeForOrchestrationStop } from '../../dev/lib/orchestration-termination.js';

describe('exitCodeForOrchestrationStop', () => {
  it.each(['ALL_DONE', 'LIMIT_REACHED'])('%s é conclusão normal da invocação', (status) => {
    expect(exitCodeForOrchestrationStop({ status })).toBe(0);
  });

  it.each([
    'HUMAN_REQUIRED',
    'PREFLIGHT_BLOCKED',
    'AUTOMATIC_REPAIR_EXHAUSTED',
    'AUTOMATIC_REPAIR_PROFILE_MISMATCH',
    'INCONSISTENT_EVIDENCE',
    'INVALID_EVIDENCE',
    'HISTORICAL_GAP',
    'BASE_DIVERGED',
    'FAIL',
    'TIMED_OUT',
    'INFRA_ERROR',
    'PENDING',
    'UNKNOWN_ABNORMAL_STOP',
  ])('%s continua sendo término bloqueante ou anormal', (status) => {
    expect(exitCodeForOrchestrationStop({ status })).toBe(9);
  });
});
