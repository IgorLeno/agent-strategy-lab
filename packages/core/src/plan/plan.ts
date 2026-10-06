/**
 * `plan.md`: o plano que o usuário escreve e edita, e o loop executa.
 *
 *   # Plano: <título>
 *
 *   ## Fase 1 — <nome>
 *   - [ ] 1.1 [standard] <título do step>
 *     <descrição livre, indentada>
 *   - [x] 1.2 [economy] <título>      concluído
 *   - [!] 1.3 <título>                falhou depois dos retries; tier ausente = standard
 *
 * O arquivo é do usuário. O loop só troca o caractere entre colchetes do
 * checkbox; todo o resto do texto é preservado byte a byte.
 */
import { Tier } from '../catalog/catalog.js';

export type StepStatus = 'pending' | 'done' | 'failed';

export interface PlanStep {
  readonly id: string;
  readonly title: string;
  readonly tier: Tier;
  readonly status: StepStatus;
  /** Linhas indentadas logo abaixo do step, sem a indentação comum. */
  readonly body: string;
  /** Nome da fase (texto do `##`); `null` antes do primeiro `##`. */
  readonly phase: string | null;
  /** Índice 0-based da linha do checkbox no texto. */
  readonly line: number;
}

export interface Plan {
  readonly title: string | null;
  readonly steps: readonly PlanStep[];
}

export class PlanFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanFormatError';
  }
}

const STATUS_BY_MARK: Readonly<Record<string, StepStatus>> = { ' ': 'pending', x: 'done', X: 'done', '!': 'failed' };
const MARK_BY_STATUS: Readonly<Record<StepStatus, string>> = { pending: ' ', done: 'x', failed: '!' };

const STEP_LINE = /^- \[( |x|X|!)\] (\S+)(?: \[([^\]]+)\])? (.+?)\s*$/;
const PHASE_LINE = /^## (.+?)\s*$/;
const TITLE_LINE = /^# (?:Plano:\s*)?(.+?)\s*$/;

export function parsePlan(text: string): Plan {
  const lines = text.split('\n');
  const steps: PlanStep[] = [];
  const seen = new Set<string>();
  let title: string | null = null;
  let phase: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] as string).replace(/\r$/, '');
    const phaseMatch = PHASE_LINE.exec(line);
    if (phaseMatch) {
      phase = phaseMatch[1] as string;
      continue;
    }
    const titleMatch = TITLE_LINE.exec(line);
    if (titleMatch && title === null && steps.length === 0) {
      title = titleMatch[1] as string;
      continue;
    }
    const stepMatch = STEP_LINE.exec(line);
    if (!stepMatch) continue;

    const id = stepMatch[2] as string;
    if (seen.has(id)) throw new PlanFormatError(`linha ${index + 1}: step ${id} repetido`);
    seen.add(id);

    const rawTier = stepMatch[3];
    const tier = rawTier === undefined ? 'standard' : Tier.safeParse(rawTier.trim());
    if (typeof tier !== 'string' && !tier.success) {
      throw new PlanFormatError(
        `linha ${index + 1}: tier "${rawTier}" desconhecido (use economy, standard ou premium)`,
      );
    }

    const bodyLines: string[] = [];
    let next = index + 1;
    while (next < lines.length) {
      const candidate = (lines[next] as string).replace(/\r$/, '');
      if (candidate.trim() === '') {
        // Linha em branco só pertence ao corpo se o corpo continua depois dela.
        const after = lines.slice(next + 1).find((rest) => rest.trim() !== '');
        if (after === undefined || !/^\s/.test(after)) break;
        bodyLines.push('');
        next += 1;
        continue;
      }
      if (!/^\s/.test(candidate)) break;
      bodyLines.push(candidate);
      next += 1;
    }

    steps.push({
      id,
      title: stepMatch[4] as string,
      tier: typeof tier === 'string' ? tier : tier.data,
      status: STATUS_BY_MARK[stepMatch[1] as string] as StepStatus,
      body: dedent(bodyLines),
      phase,
      line: index,
    });
  }
  return { title, steps };
}

function dedent(lines: readonly string[]): string {
  const indents = lines
    .filter((line) => line.trim() !== '')
    .map((line) => (/^\s*/.exec(line) as RegExpExecArray)[0].length);
  const common = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((line) => line.slice(common)).join('\n');
}

/** Troca SÓ o marcador do checkbox do step; o resto do texto fica intacto. */
export function setStepStatus(text: string, stepId: string, status: StepStatus): string {
  const step = parsePlan(text).steps.find((candidate) => candidate.id === stepId);
  if (step === undefined) throw new PlanFormatError(`step ${stepId} não existe no plano`);
  const lines = text.split('\n');
  const line = lines[step.line] as string;
  lines[step.line] = `- [${MARK_BY_STATUS[status]}]${line.slice('- [ ]'.length)}`;
  return lines.join('\n');
}

/** Próximo step a executar: o primeiro pendente na ordem do arquivo. */
export function nextPendingStep(plan: Plan): PlanStep | null {
  return plan.steps.find((step) => step.status === 'pending') ?? null;
}
