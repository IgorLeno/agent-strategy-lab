/**
 * Perfil de score v1: sub-scores de outcome, tempo, tokens e escopo,
 * relativos aos budgets `expected`/`maximum` do TaskSpec — nunca a
 * constantes mágicas. `outcome` FAIL impõe um teto que zera todo sub-score
 * medido, não só o dele: um run que falha na avaliação não pode parecer bom
 * só porque foi rápido ou econômico.
 *
 * Métrica obrigatória ausente vira UNSCORABLE. Métrica opcional ausente vira
 * sub-score `null` com o peso preservado — coverage cai, mas nada é
 * redistribuído. Este módulo pontua UM run; estatística agregada (variância,
 * intervalo de confiança, comparação entre estratégias) é a fase de compare.
 */

import { EvaluationOutcome, QualificationStatus } from '../core/enums.js';
import type {
  EvaluationRecord,
  ExecutionRecord,
  QualificationRecord,
  ScoreRecord,
  SubScore,
  TaskBudget,
  TaskBudgets,
} from '../schemas/index.js';

export const SCORE_PROFILE_V1_ID = 'v1';
export const SCORE_PROFILE_V1_VERSION = '1.0.0';

const OUTCOME_WEIGHT = 0.4;
const DURATION_WEIGHT = 0.2;
const TOKENS_WEIGHT = 0.2;
const SCOPE_WEIGHT = 0.2;

export interface ScoreProfileV1Options {
  readonly executionRecord: ExecutionRecord;
  readonly evaluationRecord: EvaluationRecord;
  readonly budgets: TaskBudgets;
}

export interface ScoreProfileV1Result {
  readonly score: ScoreRecord;
  readonly qualification: QualificationRecord;
}

/**
 * 1 dentro do `expected`, degradando linearmente até 0 no `maximum` — a
 * mesma régua para tempo, tokens e escopo, só troca o budget.
 */
function budgetSubScoreValue(actual: number, budget: TaskBudget): number {
  if (actual <= budget.expected) return 1;
  if (actual >= budget.maximum) return 0;
  return 1 - (actual - budget.expected) / (budget.maximum - budget.expected);
}

function outcomeSubScoreValue(outcome: EvaluationOutcome): number {
  switch (outcome) {
    case EvaluationOutcome.PASS:
      return 1;
    case EvaluationOutcome.PARTIAL:
      return 0.5;
    case EvaluationOutcome.FAIL:
    case EvaluationOutcome.NOT_EVALUATED:
      return 0;
    default:
      return 0;
  }
}

interface RawSubScore {
  readonly value: number | null;
  readonly weight: number;
  readonly required: boolean;
}

/**
 * Sela o teto de `outcome` FAIL: todo sub-score medido cai para 0, não só o
 * de `outcome`. Sub-score ausente (`null`) continua ausente — teto não
 * inventa uma medição que não existe.
 */
function applyOutcomeCeiling(
  subScores: Readonly<Record<string, RawSubScore>>,
  outcome: EvaluationOutcome,
): Record<string, RawSubScore> {
  if (outcome !== EvaluationOutcome.FAIL) return { ...subScores };

  const capped: Record<string, RawSubScore> = {};
  for (const [id, subScore] of Object.entries(subScores)) {
    capped[id] = subScore.value === null ? subScore : { ...subScore, value: 0 };
  }
  return capped;
}

/**
 * Constrói ScoreRecord + QualificationRecord do perfil v1 a partir de um
 * ExecutionRecord e EvaluationRecord já selados. Não faz I/O: a materialização
 * em `scores/<id>/` é responsabilidade de quem chama.
 */
export function scoreRunV1(options: ScoreProfileV1Options): ScoreProfileV1Result {
  const { executionRecord, evaluationRecord, budgets } = options;

  const rawSubScores: Record<string, RawSubScore> = {
    outcome: {
      value: outcomeSubScoreValue(evaluationRecord.outcome),
      weight: OUTCOME_WEIGHT,
      required: true,
    },
    duration: {
      value: budgetSubScoreValue(executionRecord.duration_ms, budgets.duration_ms),
      weight: DURATION_WEIGHT,
      required: true,
    },
    tokens: {
      value:
        executionRecord.metrics.tokens.value === null
          ? null
          : budgetSubScoreValue(executionRecord.metrics.tokens.value, budgets.tokens),
      weight: TOKENS_WEIGHT,
      required: true,
    },
    scope: {
      value:
        executionRecord.metrics.changed_files.value === null
          ? null
          : budgetSubScoreValue(executionRecord.metrics.changed_files.value, budgets.changed_files),
      weight: SCOPE_WEIGHT,
      required: false,
    },
  };

  const subScores = applyOutcomeCeiling(rawSubScores, evaluationRecord.outcome);

  const sub_scores: Record<string, SubScore> = {};
  let coverage = 0;
  const missingRequired: string[] = [];
  for (const [id, subScore] of Object.entries(subScores)) {
    sub_scores[id] = { value: subScore.value, weight: subScore.weight, required: subScore.required };
    if (subScore.value !== null) {
      coverage += subScore.weight;
    } else if (subScore.required) {
      missingRequired.push(id);
    }
  }

  const score: ScoreRecord = {
    score_profile_id: SCORE_PROFILE_V1_ID,
    score_profile_version: SCORE_PROFILE_V1_VERSION,
    sub_scores,
    budgets_used: budgets,
    coverage,
  };

  const qualification: QualificationRecord =
    missingRequired.length > 0
      ? {
          status: QualificationStatus.UNSCORABLE,
          justification: `Métrica obrigatória ausente: ${missingRequired.sort().join(', ')}`,
        }
      : { status: QualificationStatus.QUALIFIED, justification: null };

  return { score, qualification };
}
