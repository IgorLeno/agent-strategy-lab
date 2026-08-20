import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);

/**
 * Natureza de uma intervenção humana registrada durante um attempt.
 * operational_cleanup cobre ações de infraestrutura/ambiente; manual_fix
 * cobre correção direta de código/estado pelo humano; design_decision cobre
 * escolhas de projeto tomadas fora do agente; other cobre o restante.
 */
export enum InterventionType {
  OPERATIONAL_CLEANUP = 'operational_cleanup',
  MANUAL_FIX = 'manual_fix',
  DESIGN_DECISION = 'design_decision',
  OTHER = 'other',
}

/**
 * Registro auditável de uma intervenção humana ocorrida durante um attempt.
 * affects_autonomy distingue intervenções que comprometem autonomous_first_pass
 * (M46/M47) de intervenções puramente operacionais que não afetam a
 * autonomia do agente.
 */
export const InterventionRecord = z
  .object({
    intervention_id: nonEmpty,
    type: z.nativeEnum(InterventionType),
    description: nonEmpty,
    occurred_at: z.string().datetime(),
    affects_autonomy: z.boolean(),
  })
  .strict();
export type InterventionRecord = z.infer<typeof InterventionRecord>;

/**
 * Artifact canônico, por run, das intervenções humanas observadas naquele
 * attempt. A existência do arquivo é a prova positiva: um writer só o publica
 * quando o lifecycle consegue provar o conjunto observado. Lista vazia
 * significa "zero intervenções PROVADAS", nunca "não encontrei registro" —
 * ausência do artifact continua sendo UNKNOWN para os leitores.
 */
export const RunInterventionsRecord = z
  .object({
    schema_version: z.literal(1),
    /** Como o lifecycle provou o conjunto; auditável junto do run selado. */
    provenance: nonEmpty,
    interventions: z.array(InterventionRecord),
  })
  .strict();
export type RunInterventionsRecord = z.infer<typeof RunInterventionsRecord>;
