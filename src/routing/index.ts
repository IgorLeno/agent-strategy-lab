/**
 * Registro estruturado das capacidades de profile (session isolation,
 * mutation/read-only, ownership, compatibilidade de role) para o control
 * plane impor políticas de diversidade e routing sem reimplementar as
 * derivações de `dev/lib/doctor.ts`. Nenhuma decisão de routing mora aqui.
 */
export {
  CapabilityRegistry,
  DuplicateCapabilityError,
  ProfileCapability,
  capabilityOf,
  type Agent,
  type Determinable,
  type DiversityFacts,
  type ProfileCapabilityInput,
  type ReasoningEffortSource,
} from './capability.js';
