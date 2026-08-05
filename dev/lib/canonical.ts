import { createHash } from 'node:crypto';

/**
 * Serialização canônica: chaves ordenadas, sem espaços supérfluos.
 * Usada tanto para hashes estáveis (plan_sha256, command_sha256) quanto para
 * medir budgets em bytes — o mesmo objeto sempre produz os mesmos bytes.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const entry = source[key];
    if (entry === undefined) continue;
    out[key] = canonicalize(entry);
  }
  return out;
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

export function canonicalSha256(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
