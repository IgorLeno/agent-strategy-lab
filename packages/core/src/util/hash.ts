import { createHash } from 'node:crypto';

/** Mesmo `sha256Hex` de `dev/lib/canonical.ts`, sem o resto da serialização canônica. */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}
