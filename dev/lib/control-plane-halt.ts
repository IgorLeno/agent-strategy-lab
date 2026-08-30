/**
 * PARADAS DO CONTROL PLANE: uma autoridade humana real ou um blocker técnico
 * tipado — nunca "a automação não soube o que fazer".
 *
 * O invariante que este módulo torna estrutural:
 *
 *   Um mecanismo do control plane só pode bloquear progresso quando protege
 *   uma restrição REAL. E `HUMAN_REQUIRED` tem um invariante mais forte ainda:
 *   só pode ser criado quando o Lab consegue NOMEAR a autoridade, autorização
 *   ou decisão autoritativa que apenas um humano/operador pode fornecer.
 *
 * BLOQUEIO TÉCNICO != DECISÃO HUMANA. E também != "continuar às cegas": os
 * dois lados desta união param o loop, não promovem candidate e não lançam
 * provider. A diferença é o que o operador vê e o que resolve o caso — uma
 * autorização, ou um conserto técnico.
 *
 * Antes desta separação, `HumanRequiredOutput` dependia inteiramente de texto
 * livre (`decision_needed`, `why_automation_stopped`, `options`). Isso deixava
 * "a review não pôde ser executada" e "o worker estourou a quota" virarem
 * HUMAN_REQUIRED com opções genéricas de "autorizar uma mudança fora das
 * fronteiras" — pedindo ao operador uma decisão que nunca existiu.
 */

import { HumanAuthority, TechnicalBlocker } from '../../src/intake/index.js';

export { HumanAuthority, TechnicalBlocker };

/** Campos comuns às duas paradas: a evidência não muda de forma. */
interface ControlPlaneHaltBody {
  readonly incident_id: string;
  readonly decision_needed: string;
  readonly why_automation_stopped: string;
  readonly options: readonly string[];
  readonly evidence_paths: readonly string[];
}

/**
 * Parada que EXIGE autoridade humana. `human_authority` é obrigatório: um
 * caminho novo que não consegue nomear a autoridade que falta não compila
 * como HUMAN_REQUIRED — é essa a diferença entre bloquear por restrição real
 * e bloquear por falta de ideia.
 */
export interface HumanRequiredOutput extends ControlPlaneHaltBody {
  readonly status: 'HUMAN_REQUIRED';
  readonly human_authority: HumanAuthority;
}

/**
 * Parada por defeito TÉCNICO. Fail-closed idêntico ao HUMAN_REQUIRED — nada
 * é promovido, nenhum provider é lançado — sem inventar autoridade.
 */
export interface TechnicalBlockedOutput extends ControlPlaneHaltBody {
  readonly status: 'BLOCKED';
  readonly blocker: TechnicalBlocker;
}

/**
 * O que o loop propaga. Os NOMES dos campos são idênticos nos dois lados de
 * propósito: quem só repassa `why_automation_stopped` continua funcionando, e
 * quem precisa decidir olha `status`.
 */
export type ControlPlaneHalt = HumanRequiredOutput | TechnicalBlockedOutput;

export interface HumanRequiredInput extends ControlPlaneHaltBody {
  /** A autoridade que falta. Sem ela isto não é uma decisão humana. */
  readonly human_authority: HumanAuthority;
}

export interface TechnicalBlockedInput extends ControlPlaneHaltBody {
  readonly blocker: TechnicalBlocker;
}

/**
 * CONSTRUTOR ÚNICO de HUMAN_REQUIRED. Existe para que nenhum caller monte um
 * gate humano ad hoc: a autoridade entra pelo tipo, é validada em runtime pelo
 * enum fechado e nunca é derivada de texto livre.
 */
export function createHumanRequired(input: HumanRequiredInput): HumanRequiredOutput {
  return {
    status: 'HUMAN_REQUIRED',
    human_authority: HumanAuthority.parse(input.human_authority),
    incident_id: input.incident_id,
    decision_needed: input.decision_needed,
    why_automation_stopped: input.why_automation_stopped,
    options: [...input.options],
    evidence_paths: [...input.evidence_paths],
  };
}

/** Construtor único do lado técnico, pelo mesmo motivo. */
export function createTechnicalBlocked(input: TechnicalBlockedInput): TechnicalBlockedOutput {
  return {
    status: 'BLOCKED',
    blocker: TechnicalBlocker.parse(input.blocker),
    incident_id: input.incident_id,
    decision_needed: input.decision_needed,
    why_automation_stopped: input.why_automation_stopped,
    options: [...input.options],
    evidence_paths: [...input.evidence_paths],
  };
}

export function isHumanRequired(halt: ControlPlaneHalt): halt is HumanRequiredOutput {
  return halt.status === 'HUMAN_REQUIRED';
}

/**
 * PROVENIÊNCIA LEGADA, nunca autoridade inventada.
 *
 * Records históricos de HUMAN_REQUIRED foram escritos antes do contrato
 * estrutural e não têm `human_authority`. Leitores continuam compatíveis: a
 * ausência é reportada como ausência. Nada aqui adivinha uma autoridade que o
 * record nunca declarou — falsificar histórico seria pior que não saber.
 */
export function readHumanAuthority(
  record: { readonly human_authority?: unknown } | null | undefined,
): HumanAuthority | null {
  const parsed = HumanAuthority.safeParse(record?.human_authority);
  return parsed.success ? parsed.data : null;
}
