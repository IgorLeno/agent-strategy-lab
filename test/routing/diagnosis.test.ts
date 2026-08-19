import { describe, expect, it } from 'vitest';

import {
  FailureDiagnosis,
  FailureDiagnosisClassification,
  decideFailureIntervention,
  type FailureDiagnosis as FailureDiagnosisValue,
} from '../../src/routing/index.js';

function diagnosis(
  classification: FailureDiagnosisValue['classification'],
): FailureDiagnosisValue {
  return {
    schema_version: 1,
    classification,
    rationale: `rationale para ${classification}`,
    boundary: 'um bounded repair no mesmo profile já foi consumido',
    retry_budget: {
      kind: 'BOUNDED_REPAIR',
      maximum_attempts: 1,
      attempts_used: 1,
      same_profile_required: true,
    },
    decision_needed: `decidir tratamento para ${classification}`,
    why_automation_stopped: `automation boundary de ${classification}`,
    options: ['corrigir a causa', 'pedir decisão humana'],
    evidence_paths: ['.dev/evidence/failure.json'],
    provenance: ['evaluation record + attempt facts'],
  };
}

describe('FailureDiagnosis', () => {
  it('formaliza as sete classes com razão, boundary, evidência e provenance', () => {
    const classes = FailureDiagnosisClassification.options;
    expect(classes).toEqual([
      'INFRA',
      'ENVIRONMENT_NOT_READY',
      'TASK_DEFINITION_TOO_BROAD',
      'CONTEXT_PRESSURE',
      'VALIDATION_OR_TOOLING_GAP',
      'CAPABILITY',
      'UNKNOWN_INSUFFICIENT_EVIDENCE',
    ]);
    for (const classification of classes) {
      expect(FailureDiagnosis.parse(diagnosis(classification))).toEqual(diagnosis(classification));
    }
  });

  it('torna somente CAPABILITY elegível para escalation', () => {
    for (const classification of FailureDiagnosisClassification.options) {
      const decision = decideFailureIntervention(diagnosis(classification));
      expect(decision.status === 'ACTION_REQUIRED' && decision.action === 'ESCALATION_ELIGIBLE').toBe(
        classification === 'CAPABILITY',
      );
    }
  });

  it('não muda profile para infra ou environment not ready', () => {
    expect(decideFailureIntervention(diagnosis('INFRA'))).toMatchObject({
      action: 'RETRY_INFRA_SAME_PROFILE',
      changes_profile: false,
      consumes_escalation_step: false,
    });
    expect(decideFailureIntervention(diagnosis('ENVIRONMENT_NOT_READY'))).toMatchObject({
      action: 'REMEDIATE_ENVIRONMENT',
      changes_profile: false,
      consumes_escalation_step: false,
    });
  });

  it('encaminha task ampla e pressão de contexto para replan ou re-escopo', () => {
    expect(decideFailureIntervention(diagnosis('TASK_DEFINITION_TOO_BROAD'))).toMatchObject({
      action: 'REPLAN_OR_DECOMPOSE',
    });
    expect(decideFailureIntervention(diagnosis('CONTEXT_PRESSURE'))).toMatchObject({
      action: 'RESCOPE_CONTEXT',
    });
  });

  it('encaminha gap para harness quando há primitive e exige humano quando não há', () => {
    expect(
      decideFailureIntervention(diagnosis('VALIDATION_OR_TOOLING_GAP'), {
        harness_remediation_available: true,
      }),
    ).toMatchObject({ action: 'REPAIR_HARNESS_OR_TOOLING', status: 'ACTION_REQUIRED' });
    const blocked = decideFailureIntervention(diagnosis('VALIDATION_OR_TOOLING_GAP'));
    expect(blocked).toMatchObject({ status: 'HUMAN_REQUIRED', action: 'NONE' });
  });

  it('faz fail closed de evidência insuficiente preservando os campos de human intervention', () => {
    const decision = decideFailureIntervention(diagnosis('UNKNOWN_INSUFFICIENT_EVIDENCE'));
    expect(decision).toMatchObject({
      status: 'HUMAN_REQUIRED',
      action: 'NONE',
      human_required: {
        status: 'HUMAN_REQUIRED',
        decision_needed: 'decidir tratamento para UNKNOWN_INSUFFICIENT_EVIDENCE',
        why_automation_stopped: 'automation boundary de UNKNOWN_INSUFFICIENT_EVIDENCE',
        options: ['corrigir a causa', 'pedir decisão humana'],
        evidence_paths: ['.dev/evidence/failure.json'],
      },
    });
  });
});
