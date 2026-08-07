import { z } from 'zod';

const identifier = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'id deve ser alfanumérico com - ou _');
const nonEmpty = z.string().trim().min(1);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'fingerprint deve ser sha256 hexadecimal');
const environmentVariable = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'nome de variável de ambiente inválido');

const uniqueStrings = <Schema extends z.ZodType<string>>(item: Schema) =>
  z.array(item).superRefine((values, context) => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (seen.has(value)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'valor duplicado',
          path: [index],
        });
      }
      seen.add(value);
    }
  });

export const AgentProfile = z
  .object({
    id: identifier,
    cli: nonEmpty,
    cli_version: nonEmpty,
    model: nonEmpty,
    flags: z.array(nonEmpty),
  })
  .strict();
export type AgentProfile = z.infer<typeof AgentProfile>;

export const InstructionFileFingerprint = z
  .object({
    path: nonEmpty,
    sha256,
  })
  .strict();
export type InstructionFileFingerprint = z.infer<typeof InstructionFileFingerprint>;

const instructionFiles = z
  .array(InstructionFileFingerprint)
  .superRefine((files, context) => {
    const seen = new Set<string>();
    for (const [index, file] of files.entries()) {
      if (seen.has(file.path)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'instruction file duplicado',
          path: [index, 'path'],
        });
      }
      seen.add(file.path);
    }
  });

const environmentInventory = {
  id: identifier,
  env_allowlist: uniqueStrings(environmentVariable),
  instruction_files: instructionFiles,
  plugins: uniqueStrings(nonEmpty),
  skills: uniqueStrings(nonEmpty),
  mcp_servers: uniqueStrings(nonEmpty),
};

const ControlledEnvironmentProfile = z
  .object({
    ...environmentInventory,
    mode: z.literal('controlled'),
    home: z.literal('sanitized'),
  })
  .strict();

const RealWorldEnvironmentProfile = z
  .object({
    ...environmentInventory,
    mode: z.literal('real-world'),
    home: z.enum(['sanitized', 'user']),
    uncontrolled: uniqueStrings(nonEmpty).refine(
      (values) => values.length > 0,
      'real-world deve registrar ao menos um aspecto não controlado',
    ),
  })
  .strict();

/**
 * `mode` é um discriminante obrigatório: consumidores nunca precisam inferir
 * se um resultado veio de ambiente controlled ou real-world. Inventários
 * vazios continuam explícitos; omitir um deles torna o perfil inválido.
 */
export const EnvironmentProfile = z.discriminatedUnion('mode', [
  ControlledEnvironmentProfile,
  RealWorldEnvironmentProfile,
]);
export type EnvironmentProfile = z.infer<typeof EnvironmentProfile>;
