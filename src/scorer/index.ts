/**
 * Score e qualificação: perfis de score versionados que transformam um
 * EvaluationRecord + métricas de execução em ScoreRecord e QualificationRecord.
 *
 * Fronteira: score é de UM run. Estatística agregada (variância, intervalo de
 * confiança, comparação entre estratégias) é a fase de compare, não aqui.
 * Métrica obrigatória ausente resulta em UNSCORABLE; opcional ausente resulta
 * em sub-score null e coverage menor — o peso nunca é redistribuído.
 *
 * Preenchido por M29.
 */
export {
  scoreRunV1,
  SCORE_PROFILE_V1_ID,
  SCORE_PROFILE_V1_VERSION,
  type ScoreProfileV1Options,
  type ScoreProfileV1Result,
} from './score-profile.js';
