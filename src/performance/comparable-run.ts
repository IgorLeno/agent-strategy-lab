import { z } from 'zod';

import { canonicalSha256 } from '../envelope/index.js';
import { AttemptRole } from './attempt-facts.js';

const nonEmpty = z.string().trim().min(1);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'fingerprint deve ser sha256 hexadecimal');
const provenance = z.string().trim().min(1, 'provenance é obrigatória');

/** Sentinel explícito: ausência de evidência nunca é convertida em um valor presumido. */
export const COMPARABLE_FACT_UNKNOWN = 'UNKNOWN' as const;
export const COMPARABLE_RUN_FACTS_FILE_NAME = 'comparable-run-facts.json';

function comparableFact<T extends z.ZodTypeAny>(value: T) {
  return z
    .object({
      value: z.union([value, z.literal(COMPARABLE_FACT_UNKNOWN)]),
      provenance,
    })
    .strict();
}

const StringFact = comparableFact(nonEmpty.refine((value) => value !== COMPARABLE_FACT_UNKNOWN));
const FingerprintFact = comparableFact(sha256);
const AttemptRoleFact = comparableFact(z.nativeEnum(AttemptRole));
const ContextPressureFact = comparableFact(z.enum(['low', 'medium', 'high']));
const EnvironmentReadinessFact = comparableFact(z.enum(['READY', 'NOT_READY']));

/**
 * Contrato provider-neutral escrito apenas pelo evidence recording path de runs
 * novos. Todos os campos exigem provenance; quem não tem evidência grava
 * UNKNOWN, nunca um default. Este módulo é puro e não lê nem escreve disco.
 */
export const ComparableRunFacts = z
  .object({
    schema_version: z.literal(1),
    profile_id: StringFact,
    profile_fingerprint_sha256: FingerprintFact,
    provider: StringFact,
    transport: StringFact,
    worker_role: StringFact,
    attempt_role: AttemptRoleFact,
    context_pressure: ContextPressureFact,
    environment_readiness: EnvironmentReadinessFact,
  })
  .strict();
export type ComparableRunFacts = z.infer<typeof ComparableRunFacts>;

export type ComparableStringFact = z.infer<typeof StringFact>;

export interface AuthoritativeProfileIdentity {
  readonly id: string;
}

export interface ComparableRunFactsEvidence {
  readonly authoritative_profile?: AuthoritativeProfileIdentity;
  readonly profile_provenance?: string;
  readonly provider?: ComparableStringFact;
  readonly transport?: ComparableStringFact;
  readonly worker_role?: ComparableStringFact;
  readonly attempt_role?: z.infer<typeof AttemptRoleFact>;
  readonly context_pressure?: z.infer<typeof ContextPressureFact>;
  readonly environment_readiness?: z.infer<typeof EnvironmentReadinessFact>;
}

function unknown(provenanceText: string) {
  return { value: COMPARABLE_FACT_UNKNOWN, provenance: provenanceText } as const;
}

/**
 * Constrói o contrato persistível a partir de evidência já autoritativa. O
 * fingerprint cobre o objeto de profile completo, com chaves canônicas; mudar
 * qualquer campo do mesmo YAML muda a identidade sem inventar `version`.
 */
export function comparableRunFactsFromEvidence(
  evidence: ComparableRunFactsEvidence,
): ComparableRunFacts {
  const profile = evidence.authoritative_profile;
  const profileProvenance = evidence.profile_provenance ?? 'authoritative_launcher_profile';
  return ComparableRunFacts.parse({
    schema_version: 1,
    profile_id:
      profile === undefined
        ? unknown('authoritative_profile_not_recorded')
        : { value: profile.id, provenance: `${profileProvenance}.id` },
    profile_fingerprint_sha256:
      profile === undefined
        ? unknown('authoritative_profile_not_recorded')
        : {
            value: canonicalSha256(profile),
            provenance: `sha256(canonical_json(${profileProvenance}))`,
          },
    provider: evidence.provider ?? unknown('provider_not_recorded'),
    transport: evidence.transport ?? unknown('transport_not_recorded'),
    worker_role: evidence.worker_role ?? unknown('worker_role_not_recorded'),
    attempt_role: evidence.attempt_role ?? unknown('attempt_role_not_recorded'),
    context_pressure: evidence.context_pressure ?? unknown('context_pressure_not_recorded'),
    environment_readiness:
      evidence.environment_readiness ?? unknown('environment_readiness_not_recorded'),
  });
}

/** Produz os facts de uma era histórica sem criar evidência retroativa. */
export function unknownComparableRunFacts(reason = 'comparable_run_facts_artifact_not_present'):
  ComparableRunFacts {
  return ComparableRunFacts.parse({
    schema_version: 1,
    profile_id: unknown(reason),
    profile_fingerprint_sha256: unknown(reason),
    provider: unknown(reason),
    transport: unknown(reason),
    worker_role: unknown(reason),
    attempt_role: unknown(reason),
    context_pressure: unknown(reason),
    environment_readiness: unknown(reason),
  });
}

const IdentityStringFact = StringFact;
const IdentityStackFact = comparableFact(z.array(nonEmpty).min(1));
const IdentityNumberFact = comparableFact(z.number().int().positive());

/**
 * Identidade derivada usada para fusão de séries. `series_key=null` significa
 * deliberadamente "não fundir"; `blocking_unknown_dimensions` explica por quê.
 */
export const ComparableRunIdentity = z
  .object({
    schema_version: z.literal(1),
    task: z
      .object({
        task_class: IdentityStringFact,
        difficulty: IdentityStringFact,
        stack: IdentityStackFact,
      })
      .strict(),
    profile: z
      .object({
        profile_id: StringFact,
        profile_fingerprint_sha256: FingerprintFact,
      })
      .strict(),
    execution: z
      .object({
        provider: IdentityStringFact,
        agent_cli: IdentityStringFact,
        model: IdentityStringFact,
        reasoning_effort: IdentityStringFact,
        transport: IdentityStringFact,
        worker_role: IdentityStringFact,
        strategy_name: IdentityStringFact,
        strategy_version: IdentityNumberFact,
        environment_profile_id: IdentityStringFact,
        environment_mode: IdentityStringFact,
      })
      .strict(),
    context: z
      .object({
        context_pressure: ContextPressureFact,
        environment_readiness: EnvironmentReadinessFact,
      })
      .strict(),
    comparable: z.boolean(),
    blocking_unknown_dimensions: z.array(nonEmpty),
    series_key: sha256.nullable(),
  })
  .strict();
export type ComparableRunIdentity = z.infer<typeof ComparableRunIdentity>;
