import type { RecoveryDecision, RecoveryIncident } from './incident-recovery.js';

export interface RecoveryPromptAdapter {
  readonly write: (chunk: string) => void;
  readonly select: (
    message: string,
    choices: readonly { readonly name: string; readonly value: RecoveryDecision }[],
  ) => Promise<RecoveryDecision>;
}

export type RecoveryDecide = (incident: RecoveryIncident) => Promise<RecoveryDecision>;

function isPromptCancellation(error: unknown): boolean {
  return error instanceof Error && (error.name === 'ExitPromptError' || error.name === 'AbortPromptError');
}

/** One product prompt shared by every interactive Lab entry point. */
export function createRecoveryDecisionPrompt(adapter: RecoveryPromptAdapter): RecoveryDecide {
  return async (incident) => {
    adapter.write(
      '\nEncontrei um problema técnico que os mecanismos automáticos atuais não conseguiram resolver.\n'
      + `\nResumo curto:\n${incident.reason}\n`,
    );
    try {
      return await adapter.select('Como deseja continuar?', [
        { name: 'Investigar e tentar corrigir automaticamente', value: 'investigate' },
        { name: 'Parar e mostrar diagnóstico', value: 'stop' },
      ]);
    } catch (error) {
      if (isPromptCancellation(error)) return 'stop';
      throw error;
    }
  };
}
