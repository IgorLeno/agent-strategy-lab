import { z } from 'zod';

import { ProviderIdentity } from '../providers/index.js';

/**
 * Visão estruturada das capacidades de um profile, para o control plane
 * IMPOR políticas (routing, diversidade, review) sem reimplementar nada que
 * `dev/lib/doctor.ts` já deriva. Este módulo NUNCA reparseia argv: consome
 * `experimentFactsOf`, `claudeReasoningEffort`, `codexReasoningEffort` e os
 * campos já presentes em `DoctorReport` como entrada (`ProfileCapabilityInput`),
 * e nunca lê a prosa de `notes` como fonte de capacidade.
 *
 * `src` não importa `dev`: os tipos abaixo espelham estruturalmente os de
 * `dev/lib/doctor.ts` e `dev/lib/profile.ts` de propósito — o teste é quem
 * alimenta os facts, carregando os profiles reais de `dev/profiles`.
 */

const nonEmpty = z.string().trim().min(1);
const provenanceText = z.string().trim().min(1, 'provenance é obrigatória');

/** `{value, provenance}`: valor não determinável vira `null`, nunca chute — e o motivo fica registrado, sempre. */
function withProvenance<T extends z.ZodTypeAny>(valueSchema: T) {
  return z.object({ value: valueSchema, provenance: provenanceText }).strict();
}

const Determinable = withProvenance(z.boolean().nullable());
export type Determinable = z.infer<typeof Determinable>;

/**
 * PRIOR de capacidade declarado pelo perfil versionado.
 *
 * Ele responde "para qual classe de task este modelo é suficiente?" sem que o
 * router precise conhecer o nome do modelo. É a diferença entre acrescentar um
 * provider escrevendo um arquivo de perfil e editar uma tabela de regex no
 * código do router toda vez.
 *
 * Prior NÃO é história. Ele decide ELEGIBILIDADE (o modelo é suficiente para
 * esta task?), nunca preferência entre elegíveis: essa continua sendo decidida
 * por amostragem observada, e um perfil novo entra subamostrado.
 */
export const CapabilityPrior = z
  .object({
    tier: z.enum(['economy', 'intermediate', 'advanced']),
    model_cost_rank: z.number().int().nonnegative(),
    effort_cost_rank: z.number().int().nonnegative(),
    rationale: nonEmpty,
  })
  .strict();
export type CapabilityPrior = z.infer<typeof CapabilityPrior>;

const SessionIsolation = z
  .object({
    fresh_process: z.literal(true),
    resume_forbidden: z.literal(true),
    mechanism: nonEmpty,
  })
  .strict();

/**
 * Ownership de lifecycle stage. Espelha estruturalmente as enums de
 * `dev/lib/execution-policy.ts` (`src` não importa `dev`) porque o control
 * plane precisa DECIDIR sobre esses valores — em particular, qual stage
 * consome qual budget de tempo. Uma string livre aqui deixaria o router
 * adivinhar; a enum faz um valor desconhecido virar erro de parse.
 */
const Ownership = z
  .object({
    commit_owner: z.enum(['worker', 'orchestrator']),
    official_validation_owner: z.enum(['worker', 'orchestrator']),
    worker_validation_policy: z.enum(['full', 'targeted']),
  })
  .strict();

const RoleCompatibility = z
  .object({
    planner: Determinable,
    implementer: Determinable,
    reviewer: Determinable,
  })
  .strict();

/**
 * SCAFFOLD de execução. O nome do tipo é histórico; a dimensão que ele
 * representa é qual executável roda, e NÃO com quem ele fala — ver
 * `ProfileCapability.provider_identity` para a identidade upstream.
 */
export type Agent = 'claude' | 'codex' | 'opencode' | 'fake';

/** Espelha `ReasoningEffortSource` de `dev/lib/doctor.ts`. */
export type ReasoningEffortSource =
  | 'codex_config_override'
  | 'claude_effort_flag'
  | 'opencode_variant_flag'
  | 'unpinned'
  | 'unknown'
  | 'not_applicable';

/**
 * Entrada: as derivações que já existem, nunca argv cru. `profile_id`,
 * `agent`, `model`, `reasoning_effort` e `reasoning_effort_source` vêm de
 * `experimentFactsOf`; o restante são campos já presentes em `DoctorReport`.
 */
export interface ProfileCapabilityInput {
  readonly profile_id: string;
  readonly agent: Agent;
  /**
   * Identidade upstream normalizada. `null` num perfil legado cuja combinação
   * não tem contrato declarado — ali a semântica antiga continua governando, e
   * as dimensões de provider degradam para UNKNOWN em vez de serem inventadas.
   */
  readonly provider_identity?: ProviderIdentity | null | undefined;
  /**
   * Prior declarado. Ausente preserva a classificação histórica por padrões de
   * modelo, bit a bit — nenhum perfil já existente muda de tier por causa deste
   * campo.
   */
  readonly capability_prior?: CapabilityPrior | null | undefined;
  readonly model: string;
  readonly reasoning_effort: string;
  readonly reasoning_effort_source: ReasoningEffortSource;
  readonly billing_mode: string;
  readonly credential_source: string;
  readonly environment_mode: string;
  readonly instruction_environment: string;
  readonly commit_owner: string;
  readonly official_validation_owner: string;
  readonly worker_validation_policy: string;
  readonly sandbox: string;
  readonly session_persistence: string;
}

/** Contrato estrito e versionado — mudar o formato exige `schema_version` novo. */
export const ProfileCapability = z
  .object({
    schema_version: z.literal(1),
    profile_id: nonEmpty,
    /**
     * SCAFFOLD de execução. NÃO é a dimensão de diversidade de provider: dois
     * scaffolds diferentes contra o mesmo upstream não são duas opiniões
     * independentes. Quem responde por diversidade e por pool é
     * `provider_identity`.
     */
    agent: z.enum(['claude', 'codex', 'opencode', 'fake']),
    /**
     * Upstream, cobrança e pool — as dimensões que `agent` confundia. `null`
     * em perfil legado sem contrato mapeável: ausência permanece ausência.
     */
    provider_identity: ProviderIdentity.nullable().default(null),
    /** Prior declarado; `null` mantém a classificação por padrões de modelo. */
    capability_prior: CapabilityPrior.nullable().default(null),
    model: nonEmpty,
    reasoning_effort: nonEmpty,
    reasoning_effort_source: z.enum([
      'codex_config_override',
      'claude_effort_flag',
      'opencode_variant_flag',
      'unpinned',
      'unknown',
      'not_applicable',
    ]),
    environment_mode: nonEmpty,
    instruction_environment: nonEmpty,
    billing_mode: nonEmpty,
    credential_source: nonEmpty,
    ownership: Ownership,
    session_isolation: SessionIsolation,
    /** Pode este profile escrever no workspace? */
    mutation_capability: Determinable,
    /**
     * Pode este profile ser forçado a operar somente-leitura por um mecanismo
     * DETERMINÍSTICO (não por instrução em prompt)? `read_only_mechanism`
     * descreve o mecanismo quando `value` é `true`.
     */
    read_only_operability: Determinable,
    read_only_mechanism: nonEmpty.nullable(),
    role_compatibility: RoleCompatibility,
  })
  .strict();
export type ProfileCapability = z.infer<typeof ProfileCapability>;

/**
 * Único mecanismo estrutural hoje: `buildRoutineAgentArgv`
 * (dev/lib/routine-autonomy-runtime.ts) converte o `--sandbox workspace-write`
 * único do argv Codex para `read-only` antes do spawn. Ele recusa qualquer
 * outro caso — inclusive Claude, que por isso fica declarado indisponível até
 * M84 fornecer um mecanismo equivalente.
 */
/**
 * Mecanismo estrutural do OpenCode: `openCodePermissionEnv` escreve o objeto
 * COMPLETO de permissão em `OPENCODE_PERMISSION`, que a CLI mescla por último
 * sobre a configuração global e a de projeto. `Permission.ask` levanta
 * `DeniedError` antes de publicar o evento `permission.asked` — o único que
 * `--auto` responderia —, e `Permission.disabled` remove do toolset visível a
 * ferramenta cuja regra resolvida é `*` + `deny`.
 */
const OPENCODE_READ_ONLY_MECHANISM =
  'openCodePermissionEnv(role) nega edit/write/patch/apply_patch/bash em OPENCODE_PERMISSION; a CLI recusa antes de perguntar e a ferramenta some do toolset (dev/lib/opencode-scaffold.ts)';

const OPENCODE_IMPLEMENTER_MECHANISM =
  'mutação concedida pela permissão do Lab e LIMITADA ao workspace autorizado por external_directory=deny; git commit/push permanecem negados porque o commit é do orquestrador';

const CODEX_READ_ONLY_MECHANISM =
  'buildRoutineAgentArgv converte o único --sandbox workspace-write do argv para read-only antes do spawn (dev/lib/routine-autonomy-runtime.ts)';

function sessionIsolationOf(): z.infer<typeof SessionIsolation> {
  return {
    fresh_process: true,
    resume_forbidden: true,
    mechanism:
      'forbidden_flags + assertNoForbiddenFlags recusam --resume/-r/--continue/-c/--fork-session/--session-id antes do spawn: cada lançamento é um processo novo, nunca sessão retomada',
  };
}

function mutationCapabilityOf(input: ProfileCapabilityInput): Determinable {
  if (input.agent === 'fake') {
    return {
      value: null,
      provenance: 'not_applicable: worker falso não modela mutação de workspace real',
    };
  }
  if (input.agent === 'codex') {
    if (input.sandbox === 'workspace-write') {
      return { value: true, provenance: 'sandbox=workspace-write' };
    }
    if (input.sandbox === 'read-only') {
      return { value: false, provenance: 'sandbox=read-only' };
    }
    return {
      value: null,
      provenance: `sandbox não fixado de forma única e explícita no argv (${input.sandbox})`,
    };
  }
  if (input.agent === 'opencode') {
    return {
      value: true,
      provenance: OPENCODE_IMPLEMENTER_MECHANISM,
    };
  }
  return {
    value: true,
    provenance: 'Claude opera com mutação por padrão; nenhum mecanismo estrutural desativa isso neste profile',
  };
}

interface ReadOnlyOperability {
  readonly value: boolean | null;
  readonly provenance: string;
  readonly mechanism: string | null;
}

function readOnlyOperabilityOf(input: ProfileCapabilityInput): ReadOnlyOperability {
  if (input.agent === 'fake') {
    return {
      value: null,
      provenance: 'not_applicable: worker falso não participa do overlay read-only',
      mechanism: null,
    };
  }
  if (input.agent === 'codex') {
    if (input.sandbox === 'workspace-write') {
      return {
        value: true,
        provenance: 'sandbox=workspace-write é o estado de partida exigido pelo mecanismo',
        mechanism: CODEX_READ_ONLY_MECHANISM,
      };
    }
    return {
      value: null,
      provenance: `mecanismo de overlay exige --sandbox workspace-write único como estado de partida; sandbox atual é ${input.sandbox}`,
      mechanism: null,
    };
  }
  if (input.agent === 'opencode') {
    return {
      value: true,
      provenance:
        'a permissão do Lab nega as ferramentas de mutação ANTES de qualquer pedido; a CLI recusa sem publicar o evento que --auto responderia',
      mechanism: OPENCODE_READ_ONLY_MECHANISM,
    };
  }
  return {
    value: false,
    provenance:
      'nenhum mecanismo estrutural converte um profile Claude para read-only; capacidade indisponível até M84 fornecer o mecanismo correspondente',
    mechanism: null,
  };
}

function roleCompatibilityOf(
  input: ProfileCapabilityInput,
  mutation: Determinable,
  readOnly: ReadOnlyOperability,
): z.infer<typeof RoleCompatibility> {
  const planner: Determinable =
    input.agent === 'fake'
      ? { value: null, provenance: 'not_applicable: worker falso não participa do planejamento' }
      : { value: true, provenance: 'planejamento não exige mutação nem ownership de commit' };
  const implementer: Determinable =
    mutation.value === null
      ? { value: null, provenance: mutation.provenance }
      : {
          value: mutation.value,
          provenance: mutation.value
            ? 'mutation_capability disponível'
            : 'sandbox sem mutação: profile não pode implementar',
        };
  const reviewer: Determinable = { value: readOnly.value, provenance: readOnly.provenance };
  return { planner, implementer, reviewer };
}

/**
 * Deriva `ProfileCapability` a partir dos facts já existentes de um profile.
 * Não recebe `LauncherProfile` nem argv: recebe exatamente as dimensões que
 * `experimentFactsOf` e `DoctorReport` já expõem, para nunca duplicar
 * derivação de model/effort e nunca reabrir a prosa de `notes`.
 */
export function capabilityOf(input: ProfileCapabilityInput): ProfileCapability {
  const mutation = mutationCapabilityOf(input);
  const readOnly = readOnlyOperabilityOf(input);
  return ProfileCapability.parse({
    schema_version: 1,
    profile_id: input.profile_id,
    agent: input.agent,
    provider_identity: input.provider_identity ?? null,
    capability_prior: input.capability_prior ?? null,
    model: input.model,
    reasoning_effort: input.reasoning_effort,
    reasoning_effort_source: input.reasoning_effort_source,
    environment_mode: input.environment_mode,
    instruction_environment: input.instruction_environment,
    billing_mode: input.billing_mode,
    credential_source: input.credential_source,
    ownership: {
      commit_owner: input.commit_owner,
      official_validation_owner: input.official_validation_owner,
      worker_validation_policy: input.worker_validation_policy,
    },
    session_isolation: sessionIsolationOf(),
    mutation_capability: mutation,
    read_only_operability: { value: readOnly.value, provenance: readOnly.provenance },
    read_only_mechanism: readOnly.mechanism,
    role_compatibility: roleCompatibilityOf(input, mutation, readOnly),
  });
}

/**
 * Facts mínimos que uma policy de diversidade precisa: nada de decisão aqui.
 *
 * `provider` é o UPSTREAM, não o executável. Dois scaffolds diferentes
 * autenticados na mesma conta do mesmo provider não são duas opiniões
 * independentes, e contá-los como tal é o erro que diversidade existe para
 * evitar. `quota_pool` é a chave de capacidade — perfis que a compartilham
 * nunca somam franquia.
 */
export interface DiversityFacts {
  readonly provider: string;
  readonly quota_pool: string;
  /** O executável, preservado: ele continua sendo um fato do experimento. */
  readonly execution_scaffold: Agent;
  readonly model: string;
  readonly reasoning_effort: string;
  readonly environment_mode: string;
  /** Como provider/pool foram determinados — declarados ou degradados. */
  readonly provenance: string;
}

/**
 * Provider e pool de uma capability.
 *
 * Sem identidade normalizada (perfil legado sem contrato), a resposta degrada
 * para o nome do scaffold COM MOTIVO, em vez de inventar um upstream. Degradar
 * assim é conservador: um scaffold desconhecido nunca é agrupado com outro.
 */
export function providerFactsOf(capability: ProfileCapability): {
  readonly provider: string;
  readonly quota_pool: string;
  readonly provenance: string;
} {
  const identity = capability.provider_identity;
  if (identity === null) {
    return {
      provider: `scaffold:${capability.agent}`,
      quota_pool: `scaffold:${capability.agent}`,
      provenance:
        'perfil sem identidade upstream normalizada: provider e pool degradam para o scaffold, ' +
        'que nunca agrupa perfis distintos por engano',
    };
  }
  return {
    provider: identity.provider,
    quota_pool: identity.quota_pool,
    provenance: `ProviderIdentity: ${identity.provenance}`,
  };
}

export class DuplicateCapabilityError extends Error {
  constructor(readonly profileId: string) {
    super(`capability registry: profile_id duplicado: ${profileId}`);
    this.name = 'DuplicateCapabilityError';
  }
}

/**
 * Índice de `ProfileCapability` por `profile_id`. Expõe os facts que uma
 * policy de diversidade precisa (provider/model/effort/environment) sem
 * IMPOR nenhuma decisão de diversidade nem de routing — isso é
 * responsabilidade de quem consome o registry, nunca dele.
 */
export class CapabilityRegistry {
  private readonly byId = new Map<string, ProfileCapability>();

  constructor(capabilities: readonly ProfileCapability[] = []) {
    for (const capability of capabilities) this.add(capability);
  }

  add(capability: ProfileCapability): void {
    if (this.byId.has(capability.profile_id)) {
      throw new DuplicateCapabilityError(capability.profile_id);
    }
    this.byId.set(capability.profile_id, capability);
  }

  get(profileId: string): ProfileCapability | undefined {
    return this.byId.get(profileId);
  }

  list(): readonly ProfileCapability[] {
    return [...this.byId.values()];
  }

  diversityFacts(profileId: string): DiversityFacts | undefined {
    const capability = this.byId.get(profileId);
    if (!capability) return undefined;
    const facts = providerFactsOf(capability);
    return {
      provider: facts.provider,
      quota_pool: facts.quota_pool,
      execution_scaffold: capability.agent,
      model: capability.model,
      reasoning_effort: capability.reasoning_effort,
      environment_mode: capability.environment_mode,
      provenance: facts.provenance,
    };
  }
}
