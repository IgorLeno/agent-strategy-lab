import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { apiCredentialNamesIn } from './billing.js';

const nonEmpty = z.string().min(1);

/**
 * Flags que trocam a fonte da credencial por API, anulando a assinatura. Elas
 * não são apenas "não recomendadas" num perfil `subscription_only`: com elas o
 * run passa a cobrar por chave, que é exatamente o que a política proíbe.
 *
 * `--bare` está aqui porque a própria CLI documenta: "Anthropic auth is
 * strictly ANTHROPIC_API_KEY or apiKeyHelper (OAuth and keychain are never
 * read)". Modo controlado por `--bare` é incompatível com assinatura.
 */
const API_FORCING_FLAGS = ['--bare', '--with-api-key', '--with-access-token'];

/**
 * Perfil do launcher. Declara a INTENÇÃO; o que foi de fato controlado é
 * derivado do argv final e registrado no LaunchRecord — processo novo não
 * significa contexto pequeno, e nem tudo é igual entre Claude e Codex.
 */
export const LauncherProfile = z
  .object({
    id: nonEmpty,
    agent: z.enum(['claude', 'codex', 'fake']),
    /**
     * COBRANÇA — separada do ambiente experimental de propósito. Perfil de
     * agente real precisa declarar; ausência não é "provavelmente assinatura".
     */
    billing_mode: z.enum(['subscription_only', 'api', 'not_applicable']).default('not_applicable'),
    /** AMBIENTE — `real-world` carrega contexto do usuário; `controlled` não. */
    environment_mode: z.enum(['real-world', 'controlled']).default('real-world'),
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
  .strict()
  .superRefine((profile, ctx) => {
    const reject = (message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${profile.id}: ${message}` });

    if (profile.agent === 'fake') {
      if (profile.billing_mode !== 'not_applicable') {
        reject('worker falso não fala com provider nenhum; billing_mode deve ser not_applicable');
      }
    } else if (profile.billing_mode === 'not_applicable') {
      reject('perfil de agente real precisa declarar billing_mode (subscription_only ou api)');
    }

    if (profile.billing_mode === 'api' && !/(^|-)api(-|$)/.test(profile.id)) {
      // Nome é a única defesa que sobrevive a quem escolhe o perfil no shell.
      reject('perfil de cobrança por API precisa ter `api` no id');
    }

    if (profile.billing_mode !== 'subscription_only') return;

    const inAllowlist = apiCredentialNamesIn(profile.env_allowlist);
    if (inAllowlist.length > 0) {
      reject(`env_allowlist de perfil subscription_only não pode conter ${inAllowlist.join(', ')}`);
    }
    const inExtra = apiCredentialNamesIn(Object.keys(profile.env_extra));
    if (inExtra.length > 0) {
      reject(`env_extra de perfil subscription_only não pode definir ${inExtra.join(', ')}`);
    }
    const forcing = API_FORCING_FLAGS.filter((flag) =>
      profile.argv.some((token) => token === flag || token.startsWith(`${flag}=`)),
    );
    if (forcing.length > 0) {
      reject(`flag que força autenticação por API em perfil de assinatura: ${forcing.join(', ')}`);
    }
  });
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
    // Ambiente e cobrança são dimensões DIFERENTES: um perfil de assinatura
    // pode ser real-world, e um perfil controlled não vira "de graça".
    environment_mode: profile.environment_mode,
    billing_mode: profile.billing_mode,
    env_vars_passed: Object.keys(env).length,
    env_allowlist_size: profile.env_allowlist.length,
  };
  for (const [capability, flag] of Object.entries(profile.control_markers)) {
    controlled[capability] = argv.includes(flag) ? `controlado por ${flag}` : 'não controlado';
  }
  return controlled;
}
