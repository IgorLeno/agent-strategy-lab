/**
 * O que o loop precisa saber do stdout de um step, por scaffold:
 *
 *   finalText        — última mensagem do agente: vira a nota do handoff;
 *   tokens           — contagem que o PRÓPRIO provider reportou (ledger);
 *   providerFailure  — o provider declarou falha terminal (limite, erro de
 *                      API, turno falho). Troca de provider, não retry.
 *
 * Só lê o que os decoders portados já provam. Nada é inferido de texto livre.
 */
import type { ExecutionScaffold } from '../providers/identity.js';
import { providerTerminalFailure, readClaudeStream } from './claude-stream.js';
import { codexProviderTerminalFailure, decodeCodexEventStream } from './codex-transport.js';
import { decodeOpenCodeRunStream } from './opencode-scaffold.js';
import { observedWorkerTokens, type ObservedWorkerTokens } from './worker-token-usage.js';

export interface StepOutput {
  readonly finalText: string | null;
  readonly tokens: ObservedWorkerTokens | null;
  readonly providerFailure: string | null;
}

export function decodeStepOutput(scaffold: ExecutionScaffold, stdout: string): StepOutput {
  switch (scaffold) {
    case 'claude_code': {
      const reading = readClaudeStream(stdout);
      const result = reading.result;
      const failure = providerTerminalFailure(result);
      const text = result !== null && typeof result['result'] === 'string' ? (result['result'] as string) : null;
      return {
        finalText: failure === null ? text : null,
        tokens: observedWorkerTokens({ agent: 'claude', stdout, streamResult: result }),
        providerFailure:
          failure === null ? null : `${failure.signals.join(', ')}${failure.message === null ? '' : `: ${failure.message}`}`,
      };
    }
    case 'codex_cli': {
      const decoded = decodeCodexEventStream(stdout);
      const failure = codexProviderTerminalFailure(stdout);
      return {
        finalText: decoded.outcome === 'AGENT_MESSAGE' ? decoded.text : null,
        tokens: observedWorkerTokens({ agent: 'codex', stdout }),
        providerFailure: failure === null ? null : (failure.message ?? failure.signals.join(', ')),
      };
    }
    case 'opencode': {
      const decoded = decodeOpenCodeRunStream(stdout);
      return {
        finalText: decoded.outcome === 'MODEL_TEXT' ? decoded.text : null,
        tokens: observedWorkerTokens({ agent: 'opencode', stdout }),
        // O stream do OpenCode não tem evento terminal de falha decodificado
        // pelo core antigo; falha dele aparece como exit != 0 (retry).
        providerFailure: null,
      };
    }
    case 'fake':
      return decodeFakeOutput(stdout);
  }
}

/**
 * Adapter de teste: JSONL com `{"type":"final","text":...}`,
 * `{"type":"tokens","total":N}` e `{"type":"provider_failure","message":...}`.
 */
function decodeFakeOutput(stdout: string): StepOutput {
  let finalText: string | null = null;
  let tokens: ObservedWorkerTokens | null = null;
  let providerFailure: string | null = null;
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof event !== 'object' || event === null) continue;
    const record = event as Record<string, unknown>;
    if (record['type'] === 'final' && typeof record['text'] === 'string') finalText = record['text'];
    if (record['type'] === 'tokens' && typeof record['total'] === 'number') {
      tokens = { total: record['total'], input: null, cached_input: null, output: null, reasoning: null, provenance: 'fake' };
    }
    if (record['type'] === 'provider_failure' && typeof record['message'] === 'string') {
      providerFailure = record['message'];
    }
  }
  return { finalText, tokens, providerFailure };
}
