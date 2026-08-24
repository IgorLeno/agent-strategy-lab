import { z } from 'zod';

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

export type Agent = 'claude' | 'codex' | 'fake';

/** Espelha `ReasoningEffortSource` de `dev/lib/doctor.ts`. */
export type ReasoningEffortSource =
  | 'codex_config_override'
  | 'claude_effort_flag'
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
    /** Dimensão "provider" para uma policy de diversidade: claude | codex | fake. */
    agent: z.enum(['claude', 'codex', 'fake']),
    model: nonEmpty,
    reasoning_effort: nonEmpty,
    reasoning_effort_source: z.enum([
      'codex_config_override',
      'claude_effort_flag',
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

/** Facts mínimos que uma policy de diversidade precisa: nada de decisão aqui. */
export interface DiversityFacts {
  readonly provider: Agent;
  readonly model: string;
  readonly reasoning_effort: string;
  readonly environment_mode: string;
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
    return {
      provider: capability.agent,
      model: capability.model,
      reasoning_effort: capability.reasoning_effort,
      environment_mode: capability.environment_mode,
    };
  }
}
