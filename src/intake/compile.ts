import { z } from 'zod';

import type { ProjectInspection } from '../inspection/index.js';
import type { HumanInstruction } from './human-instruction.js';

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
const MAX_OBJECTIVE_CHARS = 1_000;

function firstLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0]?.trim() ?? '';
  return line.length > 0 ? line : text.trim();
}

function clip(text: string, maximum: number): string {
  const trimmed = text.trim();
  return trimmed.length <= maximum ? trimmed : `${trimmed.slice(0, maximum - 1).trimEnd()}…`;
}

/**
 * Compilador determinístico. Usa a inspeção só como fato de identidade
 * (repo/SHA). Não inventa restrições nem autorização.
 */
export function compileIntakeFieldsDeterministic(instruction: HumanInstruction): CompiledIntakeFields {
  const raw = instruction.raw_instruction;
  const summary = clip(firstLine(raw), MAX_SUMMARY_CHARS);
  return CompiledIntakeFields.parse({
    objectives: [clip(raw, MAX_OBJECTIVE_CHARS)],
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
