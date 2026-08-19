const SUCCESSFUL_ORCHESTRATION_TERMINATIONS = new Set(['ALL_DONE', 'LIMIT_REACHED']);

/**
 * Traduz o término do orquestrador para sucesso da invocação CLI sem apagar
 * a distinção de progresso preservada em `stopped_by`.
 */
export function exitCodeForOrchestrationStop(stop: { readonly status: string }): 0 | 9 {
  return SUCCESSFUL_ORCHESTRATION_TERMINATIONS.has(stop.status) ? 0 : 9;
}
