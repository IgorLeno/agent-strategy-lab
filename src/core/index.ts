/**
 * Núcleo: vocabulário que todas as outras áreas importam — enums das três
 * dimensões (execução, avaliação, qualificação), tipos base e a hierarquia de
 * erros do lab.
 *
 * Fronteira: nada aqui faz I/O. Uma área de núcleo que lê disco vira
 * dependência circular de `storage` na primeira refatoração.
 *
 */
export {
  EvaluationOutcome,
  ExecutionStatus,
  QualificationStatus,
  parseEvaluationOutcome,
  parseExecutionStatus,
  parseQualificationStatus,
} from './enums.js';
export {
  InvalidEnumValueError,
  LAB_ERROR_CODES,
  LabError,
  LabValidationError,
  type LabErrorCode,
} from './errors.js';
export type { Brand, IsoDateTime, JsonPrimitive, JsonValue, Sha256 } from './types.js';
export { LAB_CORE_VERSION } from './version.js';
