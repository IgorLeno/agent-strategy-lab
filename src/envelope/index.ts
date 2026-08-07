import { createHash } from 'node:crypto';

import type {
  AgentProfile,
  EnvironmentProfile,
  EvaluationPlan,
  StrategyDef,
  TaskBudgets,
  TaskSpec,
} from '../schemas/index.js';

export interface AdapterIdentity {
  readonly name: string;
  readonly version: string;
}

/** Tudo que pode alterar os bytes e o comportamento de uma execução. */
export interface ExecutionEnvelopeManifest {
  readonly task_spec: TaskSpec;
  readonly strategy: StrategyDef;
  readonly compiled_prompt: string;
  readonly base_sha: string;
  readonly agent_profile: AgentProfile;
  readonly environment_profile: EnvironmentProfile;
  readonly adapter: AdapterIdentity;
  readonly budgets: TaskBudgets;
  readonly timeout_ms: number;
}

/**
 * Tudo que pode alterar uma avaliação sem exigir uma nova execução do agente.
 * Os comandos são argv por grader, nunca strings destinadas a um shell.
 */
export interface EvaluationEnvelopeManifest {
  readonly execution_manifest_sha256: string;
  readonly evaluation_plan: EvaluationPlan;
  readonly grader_versions: Readonly<Record<string, string>>;
  readonly evaluator_environment: EnvironmentProfile;
  readonly evaluation_commands: Readonly<Record<string, readonly string[]>>;
}

/** Serializa JSON com chaves de objetos ordenadas recursivamente. */
export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value));
  if (serialized === undefined) {
    throw new TypeError('o valor do envelope deve ser serializável como JSON');
  }
  return serialized;
}

/** Calcula sha256 hexadecimal sobre os bytes UTF-8 da serialização canônica. */
export function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function executionEnvelopeSha256(manifest: ExecutionEnvelopeManifest): string {
  return canonicalSha256(manifest);
}

export function evaluationEnvelopeSha256(manifest: EvaluationEnvelopeManifest): string {
  return canonicalSha256(manifest);
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);

  const source = value as Record<string, unknown>;
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const entry = source[key];
    if (entry !== undefined) canonical[key] = canonicalize(entry);
  }
  return canonical;
}
