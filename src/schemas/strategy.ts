import { z } from 'zod';

const strategyName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'nome deve ser alfanumérico com - ou _');
const strategyPrompt = z
  .string()
  .refine((value) => value.trim().length > 0, 'prompt não pode ser vazio');

/**
 * Receita declarativa de uma estratégia. Nome e versão fazem parte do próprio
 * contrato para que sejam materializados junto da receita no envelope de
 * execução, em vez de existirem apenas no caminho do arquivo.
 */
export const StrategyDef = z
  .object({
    name: strategyName,
    version: z.number().int().positive(),
    prompt: strategyPrompt,
  })
  .strict();
export type StrategyDef = z.infer<typeof StrategyDef>;
