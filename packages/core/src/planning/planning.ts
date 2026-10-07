/**
 * PLANEJAMENTO: a conversa que escreve o `plan.md` (visão §2, "Planejamento").
 *
 * Cada turno é uma sessão NOVA da CLI em modo `plan` (read-only) com perfil
 * premium — `--resume` continua proibido, então a conversa inteira vai no
 * prompt. O agente pode ler o repositório. Quando tem informação suficiente,
 * ele devolve o plano num bloco ```plan; o host mostra o rascunho, o usuário
 * edita e aprova. Nada aqui escreve no repo.
 */
import { randomUUID } from 'node:crypto';

import type { AdapterInvocation, ProviderEvent } from '../adapters/contract.js';
import { buildInvocation, type InvocationRequest } from '../adapters/invocation.js';
import { decodeStepOutput } from '../adapters/step-output.js';
import type { ObservedWorkerTokens } from '../adapters/worker-token-usage.js';
import type { ModelProfile, Tier } from '../catalog/catalog.js';
import { lineParserOf, pickProfile } from '../loop/loop.js';
import { runProcess } from '../loop/process.js';
import { parsePlan, type Plan } from '../plan/plan.js';

export interface PlanningTurn {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

/** Abaixo do teto de 128 KiB por argumento (OpenCode recebe o prompt em argv). */
export const PLANNING_PROMPT_MAX_BYTES = 100_000;
const PLANNING_TIER: Tier = 'frontier';

const INSTRUCTIONS = `Você é o planejador de um executor de planos. Converse com o usuário para entender o que ele quer construir neste repositório e escreva o plano que o executor vai seguir.

Como o executor trabalha (escreva o plano para ele):
- Cada step roda numa sessão NOVA de um agente de código, sem memória dos steps anteriores. O agente recebe o plano inteiro, o step corrente, o diff acumulado e uma nota curta do step anterior.
- Depois de cada step roda o gate do projeto (typecheck/testes/build). Gate vermelho = retry; o step só fecha com o gate verde.
- O executor commita cada step; o agente não faz commit.

Regras do plano:
- Steps pequenos e verificáveis: cada um deixa o projeto compilando e com testes passando.
- Corpo de cada step (linhas indentadas abaixo dele) com o que fazer e os critérios de aceite. Seja concreto: arquivos, comportamento, testes.
- Tier entre colchetes depois do id, do mais exigente ao mais barato: [frontier], [expert], [advanced], [balanced], [core], [fast], [economy]. [frontier] para design difícil, depuração sutil ou decisões de arquitetura.
- Agrupe em fases com "## Fase N — nome".

Este turno é só de leitura: você pode ler arquivos do repositório, mas não edite nada.

Se faltar informação essencial, faça perguntas objetivas e NÃO escreva o plano ainda. Quando tiver o suficiente, responda com um resumo curto e o plano completo num bloco cercado por \`\`\`plan e \`\`\`, exatamente neste formato:

\`\`\`plan
# Plano: <título curto>

## Fase 1 — <nome>
- [ ] 1.1 [balanced] <título do step>
  <o que fazer e critérios de aceite>
- [ ] 1.2 [economy] <título>
  <...>

## Fase 2 — <nome>
- [ ] 2.1 [frontier] <título>
  <...>
\`\`\`

Se o usuário pedir mudanças num plano já proposto, devolva o plano completo atualizado no mesmo formato.`;

const encoder = new TextEncoder();

function bytes(text: string): number {
  return encoder.encode(text).length;
}

function renderTurn(turn: PlanningTurn): string {
  return `## ${turn.role === 'user' ? 'Usuário' : 'Planejador (você)'}\n\n${turn.text.trim()}`;
}

/**
 * Prompt do turno. Conversa longa demais: mantém o primeiro pedido do usuário
 * e os turnos mais recentes, com aviso do corte.
 */
export function buildPlanningPrompt(turns: readonly PlanningTurn[]): string {
  if (turns.length === 0 || turns.at(-1)?.role !== 'user') {
    throw new Error('o turno de planejamento começa com uma mensagem do usuário');
  }
  const head = `${INSTRUCTIONS}\n\n# Conversa até aqui`;
  const rendered = turns.map(renderTurn);
  const full = [head, ...rendered].join('\n\n');
  if (bytes(full) <= PLANNING_PROMPT_MAX_BYTES) return full;

  const first = rendered[0] as string;
  const notice = '(turnos intermediários omitidos para caber no limite do prompt)';
  let budget = PLANNING_PROMPT_MAX_BYTES - bytes(head) - bytes(first) - bytes(notice) - 16;
  const tail: string[] = [];
  for (let index = rendered.length - 1; index > 0; index -= 1) {
    const turn = rendered[index] as string;
    if (bytes(turn) > budget) break;
    tail.unshift(turn);
    budget -= bytes(turn) + 2;
  }
  if (tail.length === 0) throw new Error('a última mensagem sozinha passa do limite do prompt');
  return [head, first, notice, ...tail].join('\n\n');
}

export interface PlanDraft {
  /** Texto do `plan.md`, terminado em uma quebra de linha. */
  readonly text: string;
  readonly plan: Plan;
}

/** Último bloco ```plan da resposta que parseia como plano com ao menos um step pendente. */
export function extractPlanDraft(reply: string): PlanDraft | null {
  const blocks = [...reply.matchAll(/```plan[ \t]*\r?\n([\s\S]*?)\r?\n```/g)].map((match) => match[1] as string);
  for (const block of blocks.reverse()) {
    const text = `${block.trimEnd()}\n`;
    try {
      const plan = parsePlan(text);
      if (plan.steps.length > 0 && plan.steps.every((step) => step.status === 'pending')) return { text, plan };
    } catch {
      // Bloco malformado: tenta o anterior.
    }
  }
  return null;
}

export interface PlanningTurnOptions {
  readonly repo: string;
  readonly turns: readonly PlanningTurn[];
  readonly catalog: readonly ModelProfile[];
  readonly sourceEnv: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onAttempt?: (profile: ModelProfile) => void;
  readonly onEvent?: (event: ProviderEvent | null) => void;
  /** Injetável nos testes; padrão: `buildInvocation`. */
  readonly invoke?: (request: InvocationRequest) => AdapterInvocation;
}

export type PlanningTurnResult =
  | {
      readonly status: 'ok';
      readonly reply: string;
      readonly draft: PlanDraft | null;
      readonly profileId: string;
      readonly model: string;
      readonly tokens: ObservedWorkerTokens | null;
      readonly durationMs: number;
    }
  | { readonly status: 'failed'; readonly error: string }
  | { readonly status: 'aborted' };

/**
 * Um turno: perfil premium mais barato; falha de provider ou de spawn passa
 * para o próximo perfil premium. Falha do agente (exit ≠ 0, sem resposta)
 * volta como erro para o usuário reenviar — sem retry automático.
 */
export async function runPlanningTurn(options: PlanningTurnOptions): Promise<PlanningTurnResult> {
  const prompt = buildPlanningPrompt(options.turns);
  const excluded = new Set<string>();
  const failures: string[] = [];
  for (;;) {
    const profile = pickProfile(options.catalog, PLANNING_TIER, excluded);
    if (profile === null) {
      return {
        status: 'failed',
        error: `nenhum perfil ${PLANNING_TIER} disponível${failures.length === 0 ? '' : `: ${failures.join('; ')}`}`,
      };
    }
    options.onAttempt?.(profile);
    const invocation = (options.invoke ?? buildInvocation)({
      profile,
      mode: 'plan',
      prompt,
      allowedCommands: [],
      sourceEnv: options.sourceEnv,
      extraEnv: { ASL_STEP_TAG: `planning:${randomUUID()}` },
    });
    const parseLine = lineParserOf(profile);
    const run = await runProcess({
      argv: invocation.argv,
      cwd: options.repo,
      env: invocation.env ?? {},
      ...(invocation.stdin === undefined ? {} : { stdin: invocation.stdin }),
      timeoutMs: options.timeoutMs ?? 30 * 60_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onStdoutLine: (line) => options.onEvent?.(parseLine(line)),
    });
    if (run.aborted) return { status: 'aborted' };
    if (run.spawnError !== null) {
      failures.push(`${profile.id}: ${run.spawnError}`);
      excluded.add(profile.id);
      continue;
    }
    const output = decodeStepOutput(profile.scaffold, run.stdout);
    if (output.providerFailure !== null) {
      failures.push(`${profile.id}: ${output.providerFailure}`);
      excluded.add(profile.id);
      continue;
    }
    if (run.timedOut) return { status: 'failed', error: `o planejador passou do teto de ${options.timeoutMs ?? 1_800_000} ms` };
    if (run.exitCode !== 0 || output.finalText === null || output.finalText.trim() === '') {
      const detail = (run.stderr || run.stdout).trim().split('\n').slice(-5).join('\n');
      return { status: 'failed', error: `o planejador (${profile.id}) saiu com código ${run.exitCode} sem resposta\n${detail}` };
    }
    return {
      status: 'ok',
      reply: output.finalText,
      draft: extractPlanDraft(output.finalText),
      profileId: profile.id,
      model: profile.model,
      tokens: output.tokens,
      durationMs: run.durationMs,
    };
  }
}
