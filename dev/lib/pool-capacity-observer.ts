import {
  anthropicCapacityOf,
  CapacityStatus,
  loadCodexChatGptCredential,
  loadOpenCodeGoCredential,
  loadOpenCodeOpenAiCredential,
  loadOpenRouterCredential,
  probeOpenAiSubscriptionQuota,
  probeOpenCodeGoQuota,
  probeOpenRouterBalance,
  sameChatGptAccount,
  unknownCapacity,
  type CredentialPaths,
  type PoolCapacityObservation,
  type ProbeFetch,
} from '../../src/quota/index.js';
import { resolveProfileIdentity } from '../../src/providers/index.js';
import { probeClaudeUsage, type UsageCommandRunner } from './claude-usage.js';
import { experimentFactsOf } from './doctor.js';
import type { HarnessPaths } from './paths.js';
import { buildEnvironment, type LauncherProfile } from './profile.js';

export type PoolCapacityProbe = (
  profile: LauncherProfile,
) => Promise<PoolCapacityObservation | null>;

/** Snapshot de routing e porta para a única leitura pós-execução. */
export interface PoolCapacityLaunchContext {
  readonly before: PoolCapacityObservation | null;
  readonly probe: PoolCapacityProbe;
}

export interface ProductionPoolCapacityProbeOptions {
  readonly paths: HarnessPaths;
  readonly credentialPaths?: CredentialPaths;
  readonly fetch?: ProbeFetch;
  readonly now?: () => Date;
  /** Injetável nos testes: o probe Claude real continua sendo `/usage`. */
  readonly claudeUsageRunner?: UsageCommandRunner;
}

export function createProductionPoolCapacityProbe(
  options: ProductionPoolCapacityProbeOptions,
): PoolCapacityProbe {
  const now = options.now ?? (() => new Date());
  const common = {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    now,
  };

  return async (profile) => {
    const identity = profileIdentityOf(profile);
    if (identity === null || identity.quota_pool === 'none') return null;

    switch (identity.provider) {
      case 'openai': {
        const codex = await loadCodexChatGptCredential(options.credentialPaths);
        const primary = await probeOpenAiSubscriptionQuota({ credential: codex, ...common });
        if (primary.status !== CapacityStatus.UNKNOWN) return primary;

        // O OAuth do OpenCode só pode substituir o observer preferido quando a
        // igualdade de conta foi provada. Ausência de uma das identidades não
        // autoriza fundir duas franquias possivelmente diferentes.
        const opencode = await loadOpenCodeOpenAiCredential(options.credentialPaths);
        if (!sameChatGptAccount(codex, opencode).same) return primary;
        return probeOpenAiSubscriptionQuota({ credential: opencode, ...common });
      }
      case 'opencode_go':
        return probeOpenCodeGoQuota({
          credential: await loadOpenCodeGoCredential(options.credentialPaths),
          ...common,
        });
      case 'openrouter':
        return probeOpenRouterBalance({
          credential: await loadOpenRouterCredential(options.credentialPaths),
          ...common,
        });
      case 'anthropic': {
        const home = pathForProbeHome(options.paths, profile);
        const outcome = await probeClaudeUsage({
          binary: profile.argv[0] as string,
          env: buildEnvironment(profile, process.env, { sanitizedHome: home }),
          cwd: options.paths.repoRoot,
          ...(options.claudeUsageRunner === undefined
            ? {}
            : { runner: options.claudeUsageRunner }),
        });
        return anthropicCapacityOf({
          readings:
            outcome.reading === null
              ? null
              : [
                  {
                    window_id: 'five_hour',
                    used_percent: outcome.reading.five_hour.used_pct,
                    reset_label: outcome.reading.five_hour.reset_label,
                  },
                  {
                    window_id: 'seven_day_all_models',
                    used_percent: outcome.reading.seven_day_all_models.used_pct,
                    reset_label: outcome.reading.seven_day_all_models.reset_label,
                  },
                ],
          reason:
            outcome.probe.reason ??
            'Claude /usage reportou capacidade e provou zero inferência',
          source: 'claude_print_usage_v1',
          observed_at: now().toISOString(),
        });
      }
      case 'none':
        return null;
    }
  };
}

export async function observeEligiblePoolCapacities(
  profiles: readonly LauncherProfile[],
  probe: PoolCapacityProbe,
  poolOf: (profile: LauncherProfile) => string | null = quotaPoolOfProfile,
): Promise<ReadonlyMap<string, PoolCapacityObservation>> {
  const observed = new Map<string, PoolCapacityObservation>();
  for (const profile of profiles) {
    const pool = poolOf(profile);
    if (pool === null || pool === 'none' || observed.has(pool)) continue;
    const capacity = await probe(profile).catch(() =>
      unknownCapacity({
        quota_pool: pool,
        reason: 'observer de produção falhou antes de produzir observação; causa sensível omitida',
        source: 'agentlab:production-pool-capacity-observer',
        observed_at: new Date().toISOString(),
      }),
    );
    if (capacity === null) continue;
    observed.set(
      pool,
      capacity.quota_pool === pool
        ? capacity
        : unknownCapacity({
            quota_pool: pool,
            reason:
              `probe do profile ${profile.id} devolveu pool ${capacity.quota_pool}; ` +
              `o contrato normalizado exige ${pool}`,
            source: 'agentlab:production-pool-capacity-observer',
            observed_at: capacity.observed_at,
          }),
    );
  }
  return observed;
}

/** Identidade de pool única, derivada do mesmo contrato usado pelo router. */
export function quotaPoolOfProfile(profile: LauncherProfile): string | null {
  return profileIdentityOf(profile)?.quota_pool ?? null;
}

function profileIdentityOf(profile: LauncherProfile) {
  // Test doubles não representam credencial ou franquia real. O routing pode
  // usá-los como capability, mas o observer nunca fabrica pool para eles.
  if (profile.test_double_of !== undefined) return null;
  const facts = experimentFactsOf(profile);
  const resolved = resolveProfileIdentity({
    profile_id: profile.id,
    agent: profile.agent,
    billing_mode: profile.billing_mode,
    model: facts.model,
    declared_provider: profile.provider,
  });
  return resolved.outcome === 'IDENTIFIED' ? resolved.identity : null;
}

function pathForProbeHome(paths: HarnessPaths, profile: LauncherProfile): string {
  return `${paths.devDir}/project/homes/${profile.id}`;
}
