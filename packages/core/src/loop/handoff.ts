/**
 * HANDOFF: o prompt de um step, numa sessão nova da CLI.
 *
 * Automatiza o "continuar em outro chat": o agente não tem conversa anterior,
 * então recebe o plano inteiro, o step corrente, a nota do step anterior, o
 * erro da tentativa anterior (em retry) e o diff desde o início do plano.
 *
 * Teto de tamanho: o OpenCode recebe o prompt como UM argumento de argv, e o
 * Linux limita um argumento a 128 KiB (MAX_ARG_STRLEN). Esse é o limite real;
 * o teto fica abaixo dele, e só o diff é cortado — com aviso — para caber.
 */
import type { PlanStep } from '../plan/plan.js';

export const HANDOFF_MAX_BYTES = 100_000;
const ERROR_TAIL_BYTES = 8_000;
const NOTE_MAX_BYTES = 4_000;

export interface HandoffInput {
  readonly planText: string;
  readonly step: PlanStep;
  readonly previousNote: string | null;
  /** Erro da tentativa anterior deste step; `null` na primeira tentativa. */
  readonly retryError: string | null;
  readonly gateCommand: string | null;
  readonly diffStat: string;
  readonly diffPatch: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytes(text: string): number {
  return encoder.encode(text).length;
}

/** Corta em fronteira de byte sem quebrar caractere multibyte. */
function headBytes(text: string, max: number): string {
  const encoded = encoder.encode(text);
  if (encoded.length <= max) return text;
  return decoder.decode(encoded.slice(0, max)).replace(/�$/, '');
}

/** Últimos `max` bytes: num erro, o fim é o que explica a falha. */
export function tailBytes(text: string, max: number): string {
  const encoded = encoder.encode(text);
  if (encoded.length <= max) return text;
  return decoder.decode(encoded.slice(encoded.length - max)).replace(/^�/, '');
}

export function buildHandoff(input: HandoffInput): string {
  const { step } = input;
  const sections: string[] = [
    'Você está executando UM step de um plano, numa sessão nova. Não existe conversa anterior: tudo de que você precisa está abaixo.',
    `# Step ${step.id} — ${step.title}${step.body === '' ? '' : `\n\n${step.body}`}`,
    [
      '# Regras',
      '- Faça só este step. Não comece o próximo.',
      '- Não faça commit nem push: o orquestrador commita depois que o gate passar.',
      input.gateCommand === null
        ? '- Este projeto não tem gate automático: deixe o código compilando e os testes passando.'
        : `- Gate do projeto: \`${input.gateCommand}\` precisa terminar com código 0.`,
      '- Termine com uma nota curta (até 5 linhas) para quem fizer o próximo step: o que mudou, o que ficou pendente, armadilhas.',
    ].join('\n'),
  ];
  if (input.previousNote !== null) {
    sections.push(`# Nota do step anterior\n\n${headBytes(input.previousNote, NOTE_MAX_BYTES)}`);
  }
  if (input.retryError !== null) {
    sections.push(
      `# A tentativa anterior deste step falhou\n\nCorrija a causa. Saída do erro (final):\n\n\`\`\`\n${tailBytes(input.retryError, ERROR_TAIL_BYTES)}\n\`\`\``,
    );
  }
  sections.push(`# Plano completo (plan.md)\n\n${input.planText}`);
  sections.push(`# Mudanças desde o início do plano\n\n\`\`\`\n${input.diffStat.trim() === '' ? '(nenhuma)' : input.diffStat.trimEnd()}\n\`\`\``);

  const fixed = sections.join('\n\n');
  const remaining = HANDOFF_MAX_BYTES - bytes(fixed) - 200;
  if (input.diffPatch.trim() === '' || remaining <= 0) return fixed;
  if (bytes(input.diffPatch) <= remaining) {
    return `${fixed}\n\n\`\`\`diff\n${input.diffPatch.trimEnd()}\n\`\`\``;
  }
  return `${fixed}\n\n\`\`\`diff\n${headBytes(input.diffPatch, remaining)}\n\`\`\`\n\n(diff cortado para caber no limite do handoff; use \`git diff\` para ver o resto)`;
}
