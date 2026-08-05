import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const nonEmpty = z.string().min(1);

/**
 * Perfil do launcher. Declara a INTENÇÃO; o que foi de fato controlado é
 * derivado do argv final e registrado no LaunchRecord — processo novo não
 * significa contexto pequeno, e nem tudo é igual entre Claude e Codex.
 */
export const LauncherProfile = z
  .object({
    id: nonEmpty,
    agent: z.enum(['claude', 'codex', 'fake']),
    /** argv base; o prompt entra conforme prompt_delivery. */
    argv: z.array(nonEmpty).min(1),
    prompt_delivery: z.enum(['argv', 'stdin']),
    timeout_seconds: z.number().int().positive().max(7_200),
    /** Graça entre SIGTERM e SIGKILL — worker que ignora TERM ainda morre. */
    kill_after_seconds: z.number().int().positive().max(120).default(10),
    /** Recusa de lançamento se qualquer um aparecer no argv final. */
    forbidden_flags: z.array(nonEmpty),
    env_allowlist: z.array(nonEmpty),
    env_extra: z.record(z.string()).default({}),
    maximum_instruction_bytes: z.number().int().positive().default(8_192),
    /** Marcadores que provam controle real, verificados contra o argv final. */
    control_markers: z.record(nonEmpty).default({}),
    notes: z.array(nonEmpty).default([]),
  })
  .strict();
export type LauncherProfile = z.infer<typeof LauncherProfile>;

export async function loadProfile(repoRoot: string, id: string): Promise<LauncherProfile> {
  const file = path.join(repoRoot, 'dev', 'profiles', `${id}.yaml`);
  const profile = LauncherProfile.parse(parseYaml(await readFile(file, 'utf8')));
  if (profile.id !== id) {
    throw new Error(`perfil ${file} declara id ${profile.id}, esperado ${id}`);
  }
  return profile;
}

export class ForbiddenFlagError extends Error {
  constructor(readonly flags: readonly string[]) {
    super(`launcher recusado — flags proibidas no argv: ${flags.join(', ')}`);
    this.name = 'ForbiddenFlagError';
  }
}

/**
 * A limpeza de contexto é garantida por encerramento real do processo, não por
 * instrução no prompt. Retomar sessão anterior quebraria essa garantia, então
 * o argv é verificado antes do spawn.
 */
export function assertNoForbiddenFlags(profile: LauncherProfile, argv: readonly string[]): void {
  const found = profile.forbidden_flags.filter((flag) =>
    argv.some((token) => token === flag || token.startsWith(`${flag}=`)),
  );
  if (found.length > 0) throw new ForbiddenFlagError(found);
}

export function buildEnvironment(
  profile: LauncherProfile,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of profile.env_allowlist) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...profile.env_extra };
}

/**
 * Fatos, não promessas: cada marcador só vira `true` se o argv final realmente
 * contiver a flag que o garante. Sem a flag, fica registrado como não
 * controlado — omitir seria mentir sobre o ambiente do experimento.
 */
export function deriveControlledFacts(
  profile: LauncherProfile,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Record<string, boolean | string | number> {
  const controlled: Record<string, boolean | string | number> = {
    fresh_process: true,
    resume: false,
    inherited_transcript: false,
    profile_id: profile.id,
    agent: profile.agent,
    env_vars_passed: Object.keys(env).length,
    env_allowlist_size: profile.env_allowlist.length,
  };
  for (const [capability, flag] of Object.entries(profile.control_markers)) {
    controlled[capability] = argv.includes(flag) ? `controlado por ${flag}` : 'não controlado';
  }
  return controlled;
}
