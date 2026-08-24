import { createHash } from 'node:crypto';
import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);
const gitCommitSha = z
  .string()
  .regex(/^[0-9a-f]{40}$/, 'base_sha deve ser SHA-1 de commit em hex minúsculo');
const sha256hex = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Instrução humana persistida. `raw_instruction` é o documento humano
 * original (Run Directive completa ou texto legado). Autorização estruturada
 * vive no header; o corpo (`instruction_body`) é a intenção para o planner.
 */
export const HumanInstruction = z
  .object({
    schema_version: z.literal(1),
    raw_instruction: nonEmpty,
    /** Corpo sem o header. Ausente = formato legado (raw === corpo). */
    instruction_body: nonEmpty.optional(),
    source: z.enum(['stdin', 'file']),
    source_path: z.string().min(1).nullable(),
    target: z
      .object({
        type: z.enum(['external', 'self']),
        identity: nonEmpty,
      })
      .strict(),
    base_sha: gitCommitSha,
    instruction_hash: sha256hex,
  })
  .strict();
export type HumanInstruction = z.infer<typeof HumanInstruction>;

/** Texto que o planner/intake recebem: corpo, nunca o header de autorização. */
export function humanInstructionBody(instruction: HumanInstruction): string {
  return instruction.instruction_body ?? instruction.raw_instruction;
}

/** Hash da autoridade humana: só o texto raw, em UTF-8. */
export function humanInstructionHash(rawInstruction: string): string {
  return createHash('sha256').update(rawInstruction, 'utf8').digest('hex');
}

export function createHumanInstruction(input: {
  readonly raw_instruction: string;
  readonly instruction_body?: string;
  readonly source: 'stdin' | 'file';
  readonly source_path?: string;
  readonly target_type: 'external' | 'self';
  readonly target_identity: string;
  readonly base_sha: string;
}): HumanInstruction {
  const raw = input.raw_instruction.trim();
  const body = input.instruction_body?.trim();
  return HumanInstruction.parse({
    schema_version: 1,
    raw_instruction: raw,
    ...(body === undefined || body === raw ? {} : { instruction_body: body }),
    source: input.source,
    source_path: input.source_path ?? null,
    target: {
      type: input.target_type,
      identity: input.target_identity,
    },
    base_sha: input.base_sha,
    instruction_hash: humanInstructionHash(raw),
  });
}
