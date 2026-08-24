import { z } from 'zod';

import type { ProjectInspection } from '../inspection/index.js';
import { humanInstructionBody, type HumanInstruction } from './human-instruction.js';

const nonEmpty = z.string().trim().min(1);

/**
 * Campos estruturais extraídos da instrução humana. Nunca substituem o
 * texto raw: `user_request` do intake continua sendo a autoridade.
 */
export const CompiledIntakeFields = z
  .object({
    objectives: z.array(nonEmpty).min(1),
    constraints: z.array(nonEmpty),
    exclusions: z.array(nonEmpty),
    requested_scope: z.object({ summary: nonEmpty }).strict(),
  })
  .strict();
export type CompiledIntakeFields = z.infer<typeof CompiledIntakeFields>;

export interface IntakeCompilerPort {
  compile(input: {
    readonly instruction: HumanInstruction;
    readonly inspection: ProjectInspection;
  }): Promise<CompiledIntakeFields>;
}

const MAX_SUMMARY_CHARS = 240;

/**
 * Primeira linha SUBSTANTIVA: marcadores de markdown (headings, fences,
 * bullets vazios) não descrevem o pedido. `# Objective` seguido do texto real
 * deve produzir o texto real.
 */
function headlineOf(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (/^(?:#{1,6}\s|```|---|\*\*\*|===)/.test(trimmed)) continue;
    const withoutBullet = trimmed.replace(/^[-*+]\s+/, '').trim();
    if (withoutBullet.length === 0) continue;
    return withoutBullet;
  }
  return text.trim();
}

function clip(text: string, maximum: number): string {
  const trimmed = text.trim();
  return trimmed.length <= maximum ? trimmed : `${trimmed.slice(0, maximum - 1).trimEnd()}…`;
}

/**
 * Compilador determinístico. Usa a inspeção só como fato de identidade
 * (repo/SHA). Não inventa restrições nem autorização.
 *
 * `objectives` é o ACCEPTANCE CONTRACT protegido: o planner precisa repetir
 * cada objetivo VERBATIM em `tasks[].acceptance`. Por isso ele é uma linha
 * citável, não o corpo inteiro recortado — pedir que um modelo reproduza
 * milhares de caracteres de markdown palavra por palavra transformaria o gate
 * de acceptance num gerador de rejeição. A intenção completa não se perde:
 * ela viaja íntegra como `human_instruction` na invocação do planner
 * (`src/planner/draft.ts`), e o corpo raw continua sendo a autoridade
 * persistida em `user_request`.
 */
export function compileIntakeFieldsDeterministic(instruction: HumanInstruction): CompiledIntakeFields {
  const raw = humanInstructionBody(instruction);
  const summary = clip(headlineOf(raw), MAX_SUMMARY_CHARS);
  return CompiledIntakeFields.parse({
    objectives: [summary],
    constraints: [],
    exclusions: [],
    requested_scope: { summary },
  });
}

export const DETERMINISTIC_INTAKE_COMPILER_PROFILE = 'deterministic-v1';

export const deterministicIntakeCompiler: IntakeCompilerPort = {
  async compile(input) {
    return compileIntakeFieldsDeterministic(input.instruction);
  },
};
