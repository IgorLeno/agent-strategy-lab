import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { apiCredentialNamesIn } from './billing.js';
import { declaredProviderAgrees } from './opencode-scaffold.js';
import { providerContractOf, UpstreamProvider } from '../../src/providers/index.js';
import {
  CommitOwner,
  ExecutionPolicy,
  OfficialValidationOwner,
  WorkerValidationPolicy,
} from './execution-policy.js';

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
const ALWAYS_FORBIDDEN_FLAGS = [
  '--dangerously-bypass-approvals-and-sandbox',
  '--approve-for-me',
] as const;

/**
 * Perfil do launcher. Declara a INTENÇÃO; o que foi de fato controlado é
 * derivado do argv final e registrado no LaunchRecord — processo novo não
 * significa contexto pequeno, e nem tudo é igual entre Claude e Codex.
 */
export const LauncherProfile = z
  .object({
    id: nonEmpty,
    /**
     * SCAFFOLD DE EXECUÇÃO — qual executável roda. Não é o provider upstream,
     * não é o pool de quota e não é quem paga: para `opencode`, o mesmo
     * executável fala com três upstreams de cobrança diferentes. A identidade
     * comercial vem de `provider` (abaixo) e de `src/providers`.
     */
    agent: z.enum(['claude', 'codex', 'opencode', 'fake']),
    /**
     * UPSTREAM com quem o scaffold fala. Obrigatório para `opencode`, onde o
     * scaffold não determina nada; ausente nos perfis legados, onde ele
     * determina — e onde a normalização deriva o valor sem reescrever o
     * arquivo. Auth, cobrança e pool NÃO são declarados aqui: eles são
     * consequência do contrato do upstream, e deixar um perfil redeclará-los
     * permitiria contradizer o contrato comercial num arquivo YAML.
     */
    provider: UpstreamProvider.optional(),
    /**
     * COBRANÇA — separada do ambiente experimental de propósito. Perfil de
     * agente real precisa declarar; ausência não é "provavelmente assinatura".
     */
    billing_mode: z.enum(['subscription_only', 'api', 'not_applicable']).default('not_applicable'),
    /** AMBIENTE — `real-world` carrega contexto do usuário; `controlled` não. */
    environment_mode: z.enum(['real-world', 'controlled']).default('real-world'),
    /** Descoberta pelo HOME é uma dimensão separada do ambiente experimental. */
    instruction_environment: z
      .enum(['real_world_user_home', 'sanitized_user_home'])
      .default('real_world_user_home'),
    commit_owner: CommitOwner.default('worker'),
    official_validation_owner: OfficialValidationOwner.default('worker'),
    worker_validation_policy: WorkerValidationPolicy.default('full'),
    /** argv base; o prompt entra conforme prompt_delivery. */
    argv: z.array(nonEmpty).min(1),
    prompt_delivery: z.enum(['argv', 'stdin']),
    /**
     * NÃO existe mais `timeout_seconds`. Ele era o deadline derivado da task —
     * 1800s em todo o catálogo — e um profile não é o lugar onde a duração de
     * uma tarefa vira limite operacional. O que encerra processo hoje é o
     * MACHINE_SAFETY_CEILING (dev/lib/machine-safety.ts), que é de
     * infraestrutura: não vem do profile, não vem do planner e não entra em
     * routing.
     *
     * Graça entre o PEDIDO de término (SIGTERM) e o SIGKILL. Worker que ignora
     * TERM ainda morre; isto nunca foi e não é duração máxima da task.
     */
    kill_after_seconds: z.number().int().positive().max(120).default(10),
    /** Recusa de lançamento se qualquer um aparecer no argv final. */
    forbidden_flags: z.array(nonEmpty),
    env_allowlist: z.array(nonEmpty),
    env_extra: z.record(z.string()).default({}),
    maximum_instruction_bytes: z.number().int().positive().default(8_192),
    /** Marcadores que provam controle real, verificados contra o argv final. */
    control_markers: z.record(nonEmpty).default({}),
    /**
     * PRIOR CONSERVADOR de capacidade, declarado pelo perfil.
     *
     * Existe para que acrescentar um modelo seja escrever um arquivo de
     * perfil, e não editar a tabela de regex do router em vários lugares. A
     * ausência preserva o comportamento histórico VERBATIM: perfis Claude e
     * Codex continuam classificados pela tabela de padrões do router.
     *
     * É PRIOR, não medição. Ele não é resultado de benchmark, não vira
     * histórico e não vence evidência: um perfil novo entra subamostrado, e é
     * a história observada que decide depois. Declarar tier alto aqui não
     * torna o modelo melhor — só o torna elegível para tasks que exigem esse
     * tier, e o resultado observado é que confirma ou desmente.
     */
    capability_prior: z
      .object({
        tier: z.enum(['economy', 'intermediate', 'advanced']),
        /** Ordem de custo estático entre modelos; menor é mais barato. */
        model_cost_rank: z.number().int().nonnegative(),
        /** Ordem de custo do effort; menor é mais barato. */
        effort_cost_rank: z.number().int().nonnegative().default(0),
        /** Por que este tier, em uma frase. Prior sem justificativa é chute. */
        rationale: nonEmpty,
      })
      .strict()
      .optional(),
    /**
     * Capability que este perfil FALSO representa nos contratos de routing.
     *
     * Existe porque `capabilityOf` (M77) e o router (M78) classificam modelos,
     * e um worker falso não tem modelo: sem isto, nenhum caminho executável do
     * lifecycle universal pode ser exercitado de ponta a ponta sem chamar um
     * provider real. O campo é DECLARATIVO e restrito a `agent: fake` — um
     * perfil real nunca pode declarar uma capability diferente da que o argv
     * versionado prova, e a cobrança continua sendo decidida pelo `agent` real
     * (`fake` nunca fala com provider nenhum).
     */
    test_double_of: z
      .object({
        agent: z.enum(['claude', 'codex']),
        model: nonEmpty,
        reasoning_effort: nonEmpty,
        sandbox: nonEmpty.default('workspace-write'),
      })
      .strict()
      .optional(),
    notes: z.array(nonEmpty).default([]),
  })
  .strict()
  .superRefine((profile, ctx) => {
    const reject = (message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${profile.id}: ${message}` });

    const executionPolicy = ExecutionPolicy.safeParse({
      commit_owner: profile.commit_owner,
      official_validation_owner: profile.official_validation_owner,
      worker_validation_policy: profile.worker_validation_policy,
    });
    if (!executionPolicy.success) {
      reject('combinação de execution policy não suportada');
    }

    if (profile.agent === 'fake') {
      if (profile.billing_mode !== 'not_applicable') {
        reject('worker falso não fala com provider nenhum; billing_mode deve ser not_applicable');
      }
    } else if (profile.test_double_of !== undefined) {
      reject('test_double_of só existe em perfil fake: perfil real declara capability pelo argv versionado');
    } else if (profile.billing_mode === 'not_applicable') {
      reject('perfil de agente real precisa declarar billing_mode (subscription_only ou api)');
    }

    if (profile.billing_mode === 'api' && !/(^|-)api(-|$)/.test(profile.id)) {
      // Nome é a única defesa que sobrevive a quem escolhe o perfil no shell.
      reject('perfil de cobrança por API precisa ter `api` no id');
    }

    // ---- upstream declarado -------------------------------------------------
    if (profile.agent === 'fake' && profile.provider !== undefined) {
      reject('worker falso não fala com upstream nenhum; provider não se aplica');
    }
    if (profile.agent === 'opencode') {
      if (profile.provider === undefined) {
        reject(
          'perfil opencode precisa declarar provider: o mesmo executável fala com upstreams ' +
            'de cobrança e pool diferentes, e o scaffold não determina qual',
        );
      } else {
        const contract = providerContractOf(profile.provider);
        // Um perfil não pode contradizer o contrato comercial do upstream num
        // arquivo YAML: assinatura não vira cobrança por uso e vice-versa.
        const expectedLegacy =
          contract.billing_mode === 'subscription'
            ? 'subscription_only'
            : contract.billing_mode === 'metered_api'
              ? 'api'
              : 'not_applicable';
        if (profile.billing_mode !== expectedLegacy) {
          reject(
            `provider ${profile.provider} cobra como ${contract.billing_mode}, ` +
              `logo billing_mode precisa ser ${expectedLegacy} (declarado: ${profile.billing_mode}) — ${contract.rationale}`,
          );
        }
        // Declaração e modelo são duas afirmações independentes sobre o mesmo
        // upstream; exigir concordância pega o perfil rotulado como assinatura
        // apontando para um modelo cobrado por uso.
        const models = profile.argv.flatMap((token, index) =>
          token === '--model' || token === '-m' ? [profile.argv[index + 1]] : [],
        );
        const model = models.length === 1 ? models[0] : undefined;
        if (model === undefined) {
          reject('perfil opencode precisa pinar exatamente um --model provider/model no argv');
        } else {
          const agreement = declaredProviderAgrees(profile.provider, model);
          if (!agreement.agrees) reject(agreement.reason);
        }
      }
      if (profile.capability_prior === undefined) {
        // Sem prior e sem `--variant`, o effort é `unpinned` e o router recusa
        // classificar o perfil — ele nunca seria roteado. Exigir a declaração
        // aqui torna a lacuna um erro de perfil, não um perfil silenciosamente
        // inelegível descoberto no meio de uma run.
        reject(
          'perfil opencode precisa declarar capability_prior: sem ele o router não classifica o modelo e o perfil nunca é elegível',
        );
      }
      // `--auto` responde automaticamente a TODO pedido de permissão que não
      // seja negado. Ele não contorna um `deny` — a CLI recusa antes de
      // perguntar —, mas transformaria em silêncio todo `ask` que o Lab usa
      // deliberadamente para não conceder ferramenta que esta versão não
      // conhece. Autorização do Lab não se delega ao default de uma flag.
      if (profile.argv.some((token) => token === '--auto' || token.startsWith('--auto='))) {
        reject('--auto é proibida: a autorização do Lab não é delegada ao auto-approve da CLI');
      }
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
    const unsafe = ALWAYS_FORBIDDEN_FLAGS.filter((flag) =>
      profile.argv.some((token) => token === flag || token.startsWith(`${flag}=`)),
    );
    if (unsafe.length > 0) {
      reject(`flag insegura proibida no harness: ${unsafe.join(', ')}`);
    }
  });
export type LauncherProfile = z.infer<typeof LauncherProfile>;

export interface LoadProfileOptions {
  /** Catálogo de profiles. Omitir reproduz o histórico: `<repoRoot>/dev/profiles`. */
  readonly catalogRoot?: string;
}

export interface ProfileProvenance {
  readonly id: string;
  readonly catalog_root: string;
  readonly source_file: string;
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function looksLikeRelativeResourcePath(token: string): boolean {
  if (path.isAbsolute(token)) return false;
  if (token.startsWith('-')) return false;
  return token.includes('/') || token.includes('\\');
}

export function profileCatalogFile(catalogRoot: string, id: string): string {
  return path.join(path.resolve(catalogRoot), 'dev', 'profiles', `${id}.yaml`);
}

export function profileProvenance(catalogRoot: string, id: string): ProfileProvenance {
  const catalog_root = path.resolve(catalogRoot);
  return { id, catalog_root, source_file: profileCatalogFile(catalog_root, id) };
}

/**
 * Recurso pertencente ao catálogo (settings, fixture, script do launcher).
 * Relativos resolvem contra o catalog root; absolutos passam intactos.
 */
export function resolveCatalogResource(catalogRoot: string, token: string): string {
  if (path.isAbsolute(token)) return token;
  const root = path.resolve(catalogRoot);
  const resolved = path.resolve(root, token);
  if (!isInsideRoot(root, resolved)) {
    throw new Error(`recurso de profile ${token} escapa o catálogo ${root}`);
  }
  return resolved;
}

/**
 * Reescreve tokens de argv que são paths relativos do catálogo. Quando o cwd
 * do worker já é o próprio catálogo (uso histórico), o argv permanece igual —
 * a CLI relativa continua válida. Quando o worker roda no repositório alvo, os
 * recursos passam a absolutos no catálogo para não serem lidos no target.
 */
export function resolveProfileArgv(
  argv: readonly string[],
  options: { readonly catalogRoot: string; readonly workerCwd: string },
): string[] {
  const catalogRoot = path.resolve(options.catalogRoot);
  const workerCwd = path.resolve(options.workerCwd);
  if (catalogRoot === workerCwd) return [...argv];
  return argv.map((token) =>
    looksLikeRelativeResourcePath(token) ? resolveCatalogResource(catalogRoot, token) : token,
  );
}

export async function loadProfileFromCatalog(
  catalogRoot: string,
  id: string,
): Promise<LauncherProfile> {
  const file = profileCatalogFile(catalogRoot, id);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    const detail =
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'arquivo inexistente'
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(
      `perfil ${id} ausente no catálogo ${path.resolve(catalogRoot)} (consultado ${file}): ${detail}`,
    );
  }
  const profile = LauncherProfile.parse(parseYaml(raw));
  if (profile.id !== id) {
    throw new Error(`perfil ${file} declara id ${profile.id}, esperado ${id}`);
  }
  return profile;
}

export async function loadProfile(
  repoRoot: string,
  id: string,
  options: LoadProfileOptions = {},
): Promise<LauncherProfile> {
  return loadProfileFromCatalog(options.catalogRoot ?? repoRoot, id);
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
  const found = [...profile.forbidden_flags, ...ALWAYS_FORBIDDEN_FLAGS].filter((flag) =>
    argv.some((token) => token === flag || token.startsWith(`${flag}=`)),
  );
  if (found.length > 0) throw new ForbiddenFlagError(found);
}

export function buildEnvironment(
  profile: LauncherProfile,
  source: NodeJS.ProcessEnv = process.env,
  options: { readonly sanitizedHome?: string } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of profile.env_allowlist) {
    if (profile.instruction_environment === 'sanitized_user_home' && name === 'HOME') continue;
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  const built = { ...env, ...profile.env_extra };
  if (profile.instruction_environment !== 'sanitized_user_home') return built;

  const sanitizedHome = options.sanitizedHome;
  if (!sanitizedHome) throw new Error(`${profile.id}: HOME sanitizado não foi fornecido`);
  const codexHome =
    source['CODEX_HOME'] ?? (source['HOME'] ? path.join(source['HOME'], '.codex') : undefined);
  if (profile.agent === 'codex' && !codexHome) {
    throw new Error(`${profile.id}: CODEX_HOME não pode ser separado sem HOME real`);
  }
  if (codexHome === sanitizedHome) {
    throw new Error(`${profile.id}: CODEX_HOME não pode ser o HOME sanitizado`);
  }
  built['HOME'] = sanitizedHome;
  if (codexHome) built['CODEX_HOME'] = codexHome;
  return built;
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
    instruction_environment: profile.instruction_environment,
    billing_mode: profile.billing_mode,
    env_vars_passed: Object.keys(env).length,
    env_allowlist_size: profile.env_allowlist.length,
  };
  for (const [capability, flag] of Object.entries(profile.control_markers)) {
    controlled[capability] = argv.includes(flag) ? `controlado por ${flag}` : 'não controlado';
  }
  if (profile.agent === 'codex') {
    const sandboxIndex = argv.indexOf('--sandbox');
    controlled['sandbox'] = sandboxIndex >= 0 ? (argv[sandboxIndex + 1] ?? 'unknown') : 'unknown';
    controlled['session_persistence'] = argv.includes('--ephemeral') ? 'ephemeral' : 'persistent';
    controlled['user_config_ignored'] = argv.includes('--ignore-user-config');
    controlled['execpolicy_rules_ignored'] = argv.includes('--ignore-rules');
  }
  return controlled;
}
