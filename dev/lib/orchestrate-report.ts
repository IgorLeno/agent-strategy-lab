import type { PreflightResult } from './orchestrate-preflight.js';
import type {
  LaunchRecord,
  ProviderTerminalFailure,
  SubscriptionUsage,
  SubscriptionUsageWindow,
  SubscriptionUsageWindowReasonCode,
} from './schemas.js';

/**
 * Projeção do resultado de uma iteração do `dev-orchestrate` para stdout.
 *
 * Apresentação apenas: nada aqui é gravado, e nenhum record perde informação
 * por causa desta escolha. O LaunchRecord continua com probe, hashes, rótulos
 * de janela, evento bruto de rate limit e a falha completa do provider — o que
 * este módulo decide é o que cabe na tela de quem acompanha a implementação.
 */

/** Onde a janela está agora e quanto ela andou. Rótulo e hash ficam no record. */
export interface UsageWindowSummary {
  readonly current_used_pct: number | null;
  readonly consumed_pp: number | null;
  /**
   * Só aparece quando a medição NÃO saiu OK. Ausência aqui significa medido;
   * inventar número quando a janela virou seria pior do que não mostrar nada.
   */
  readonly reason_code?: SubscriptionUsageWindowReasonCode;
}

export interface SubscriptionUsageSummary {
  readonly five_hour: UsageWindowSummary;
  readonly seven_day_all_models: UsageWindowSummary;
}

/** O bastante para agir sem reler log: o que terminou a sessão e por quê. */
export interface ProviderFailureSummary {
  readonly terminal_reason: string | null;
  readonly api_error_status: string | number | null;
  readonly message: string | null;
}

export interface IterationSummary {
  readonly task_id: string;
  readonly attempt: number;
  /** Veredito da tarefa: o fechamento quando houve, senão a classificação do launch. */
  readonly result: string;
  readonly reason: string;
  /**
   * Tempo do worker/provider (`LaunchRecord.duration_ms`). NÃO inclui o probe
   * final, a validação oficial nem o fechamento — somar isso contaminaria a
   * série de tempos de implementação com o custo da observação.
   */
  readonly implementation_duration_ms: number | null;
  readonly implementation_duration_seconds: number | null;
  /** Equivalência estimada em preço de API. NÃO é valor cobrado. */
  readonly api_equivalent_usd: number | null;
  /** `null` fora de Claude de assinatura: ausência de probe, não medição zerada. */
  readonly subscription_usage: SubscriptionUsageSummary | null;
  readonly provider_failure?: ProviderFailureSummary;
}

export function summarizeUsageWindow(window: SubscriptionUsageWindow): UsageWindowSummary {
  return {
    current_used_pct: window.after_used_pct,
    consumed_pp: window.consumed_pp,
    ...(window.reason_code === 'OK' ? {} : { reason_code: window.reason_code }),
  };
}

export function summarizeSubscriptionUsage(
  usage: SubscriptionUsage | null,
): SubscriptionUsageSummary | null {
  if (usage === null) return null;
  return {
    five_hour: summarizeUsageWindow(usage.five_hour),
    seven_day_all_models: summarizeUsageWindow(usage.seven_day_all_models),
  };
}

export function summarizeProviderFailure(
  failure: ProviderTerminalFailure | null,
): ProviderFailureSummary | null {
  if (failure === null) return null;
  return {
    terminal_reason: failure.terminal_reason,
    api_error_status: failure.api_error_status,
    message: failure.message,
  };
}

/** Segundos com uma casa — a duração em ms continua no campo ao lado e no record. */
function seconds(durationMs: number | null): number | null {
  return durationMs === null ? null : Math.round(durationMs / 100) / 10;
}

export interface IterationInput {
  readonly taskId: string;
  readonly attempt: number;
  readonly launch: string;
  readonly close: string | null;
  readonly reason: string;
  readonly record: LaunchRecord | null;
}

export function summarizeIteration(input: IterationInput): IterationSummary {
  const durationMs = input.record?.duration_ms ?? null;
  const failure = summarizeProviderFailure(input.record?.provider_failure ?? null);
  return {
    task_id: input.taskId,
    attempt: input.attempt,
    result: input.close ?? input.launch,
    reason: input.reason,
    implementation_duration_ms: durationMs,
    implementation_duration_seconds: seconds(durationMs),
    api_equivalent_usd: input.record?.billing?.provider_estimated_api_equivalent_usd ?? null,
    subscription_usage: summarizeSubscriptionUsage(input.record?.subscription_usage ?? null),
    // Falha do provider entra sem `--verbose`: descobrir por que a sessão morreu
    // não pode custar uma segunda execução paga.
    ...(failure === null ? {} : { provider_failure: failure }),
  };
}

/**
 * Bloco `preflight` da saída padrão: três linhas de estágio e, quando o fluxo
 * parou, o código e o motivo. Detalhe (commits, validações, reconciliações,
 * razão da seleção) fica para `--verbose` e para os records.
 */
export function summarizePreflight(result: PreflightResult): Record<string, unknown> {
  const maintenance = result.maintenance;
  const recovery = result.recover;
  const next = result.next;
  return {
    status: result.status,
    maintenance: {
      status: maintenance.status,
      // NOOP não moveu base nenhuma: repetir os dois SHAs iguais seria ruído.
      ...(maintenance.status === 'NOOP'
        ? {}
        : {
            previous_authorized_head_sha: maintenance.previous_authorized_head_sha,
            authorized_head_sha: maintenance.authorized_head_sha,
          }),
      commit_count: maintenance.commit_count,
      // Descobrir POR QUE a adoção foi recusada não pode exigir --verbose.
      ...(maintenance.reason === null ? {} : { reason: maintenance.reason }),
    },
    recover:
      recovery === null
        ? null
        : {
            status: recovery.status,
            reconciliation_count: recovery.reconciliation_count,
            ...(recovery.reason === null ? {} : { reason: recovery.reason }),
          },
    next:
      next === null
        ? null
        : {
            status: next.status,
            task_id: next.task_id,
            attempt: next.attempt,
            attempt_kind: next.attempt_kind,
            ready_to_launch: next.ready_to_launch,
            ...(next.blocker === null ? {} : { blocker: next.blocker }),
          },
    ...(result.blocker === null ? {} : { blocker: result.blocker, reason: result.reason }),
  };
}

/** `--verbose` ACRESCENTA: mesmos campos do resumo, mais a evidência por trás. */
export function detailPreflight(result: PreflightResult): Record<string, unknown> {
  const summary = summarizePreflight(result);
  const maintenance = summary['maintenance'] as Record<string, unknown>;
  const recovery = summary['recover'] as Record<string, unknown> | null;
  const next = summary['next'] as Record<string, unknown> | null;
  return {
    ...summary,
    maintenance: {
      ...maintenance,
      adoption_kind: result.maintenance.adoption_kind,
      commits: result.maintenance.commits,
      validation_summary: result.maintenance.validation_results.map((entry) => ({
        argv: entry.argv,
        exit_code: entry.exit_code,
        timed_out: entry.timed_out,
      })),
    },
    recover:
      recovery === null || result.recover === null
        ? null
        : {
            ...recovery,
            plan_changed: result.recover.plan_changed,
            state_was_missing: result.recover.state_was_missing,
            head_matches_authorized: result.recover.head_matches_authorized,
            authorized_head_sha: result.recover.authorized_head_sha,
            reconciliations: result.recover.reconciliations,
          },
    next:
      next === null || result.next === null
        ? null
        : {
            ...next,
            title: result.next.title,
            base_sha: result.next.base_sha,
            authorized_head_sha: result.next.authorized_head_sha,
            selection_reason: result.next.reason,
            progression_base_reason: result.next.blocker_reason,
          },
  };
}

/**
 * `--verbose` ACRESCENTA. Os campos do resumo mantêm nome e significado, e o
 * detalhe entra em chaves próprias — assim nenhum consumidor precisa saber em
 * qual modo o comando rodou para interpretar um campo.
 */
export function detailIteration(input: IterationInput): Record<string, unknown> {
  const record = input.record;
  return {
    ...summarizeIteration(input),
    launch: input.launch,
    close: input.close,
    provider_estimated_api_equivalent_usd:
      record?.billing?.provider_estimated_api_equivalent_usd ?? null,
    billing: record?.billing ?? null,
    subscription_usage_record: record?.subscription_usage ?? null,
    rate_limit_observations: record?.rate_limit_observations ?? null,
    provider_failure_record: record?.provider_failure ?? null,
    process: record?.process ?? null,
    exit_code: record?.exit_code ?? null,
    timed_out: record?.timed_out ?? null,
    survivors_remaining: record?.survivors_remaining ?? [],
  };
}
