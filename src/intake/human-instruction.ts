import { createHash } from 'node:crypto';
import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);
const gitCommitSha = z
  .string()
  .regex(/^[0-9a-f]{40}$/, 'base_sha deve ser SHA-1 de commit em hex minúsculo');
const sha256hex = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Instrução humana persistida. O texto RAW é a autoridade humana — não
 * contém raciocínio de planner, premissas derivadas nem autorização.
 */
export const HumanInstruction = z
  .object({
    schema_version: z.literal(1),
    raw_instruction: nonEmpty,
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

/** Hash da autoridade humana: só o texto raw, em UTF-8. */
export function humanInstructionHash(rawInstruction: string): string {
  return createHash('sha256').update(rawInstruction, 'utf8').digest('hex');
}

export function createHumanInstruction(input: {
  readonly raw_instruction: string;
  readonly source: 'stdin' | 'file';
  readonly source_path?: string;
  readonly target_type: 'external' | 'self';
  readonly target_identity: string;
  readonly base_sha: string;
}): HumanInstruction {
  const raw = input.raw_instruction.trim();
  return HumanInstruction.parse({
    schema_version: 1,
    raw_instruction: raw,
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
