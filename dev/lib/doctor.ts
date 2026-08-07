import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  UNVERIFIABLE_CREDENTIAL_MESSAGE,
  apiCredentialNamesIn,
  expectedSubscriptionSource,
  probeCredentialSource,
  type CommandRunner,
  type CredentialSource,
} from './billing.js';
import type { LoadedPlan } from './plan.js';
import { executionPolicyOf } from './execution-policy.js';
import {
  assertNoForbiddenFlags,
  buildEnvironment,
  loadProfile,
  type LauncherProfile,
} from './profile.js';

/**
 * Verificação PRÉ-EXECUÇÃO de um perfil, sem gastar um tostão.
 *
 * O perfil declara intenção; a CLI instalada é quem decide o que existe. Um
 * perfil com flag inventada só falharia no primeiro lançamento pago — e um
 * perfil sem política de permissões versionada funcionaria por acidente na
 * máquina de quem o escreveu, e travaria em qualquer outra: em `--print` não
 * há ninguém para responder a um pedido de permissão.
 */
export type CheckStatus = 'PASS' | 'FAIL' | 'WARN' | 'SKIP';

export interface Check {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface DoctorReport {
  readonly profile_id: string;
  readonly agent: string;
  readonly model: string;
  readonly reasoning_effort: string;
  /** Cobrança e ambiente são dimensões separadas, e ambas ficam no relatório. */
  readonly billing_mode: string;
  readonly credential_source: CredentialSource;
  readonly environment_mode: string;
  readonly instruction_environment: string;
  readonly commit_owner: string;
  readonly official_validation_owner: string;
  readonly worker_validation_policy: string;
  readonly sandbox: string;
  readonly session_persistence: string;
  readonly user_config_ignored: boolean;
  readonly execpolicy_rules_ignored: boolean;
  readonly ok: boolean;
  readonly checks: readonly Check[];
}

function check(name: string, status: CheckStatus, detail: string): Check {
  return { name, status, detail };
}

/** Sempre com o ambiente RECEBIDO: o doctor diagnostica o ambiente que lhe deram. */
function run(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.on('error', () => resolve({ code: null, out }));
    child.on('close', (code) => resolve({ code, out }));
  });
}

/** Flags do argv base — valores posicionais não são verificados. */
export function flagsOf(argv: readonly string[]): string[] {
  return argv
    .filter((token) => token.startsWith('--'))
    .map((token) => (token.includes('=') ? (token.split('=')[0] as string) : token));
}

/** Tokens antes da primeira flag: `codex exec` precisa do subcomando no --help. */
export function helpInvocation(argv: readonly string[]): { command: string; args: string[] } {
  const commandPath: string[] = [];
  for (const token of argv) {
    if (token.startsWith('-')) break;
    commandPath.push(token);
  }
  const [command = '', ...rest] = commandPath;
  return { command, args: [...rest, '--help'] };
}

async function checkBinary(profile: LauncherProfile, env: NodeJS.ProcessEnv): Promise<Check> {
  const binary = profile.argv[0] as string;
  const found = await run('sh', ['-c', `command -v ${JSON.stringify(binary)}`], env);
  if (found.code !== 0 || found.out.trim() === '') {
    return check('binário', 'FAIL', `${binary} não está no PATH`);
  }
  return check('binário', 'PASS', found.out.trim());
}

async function checkFlags(profile: LauncherProfile, env: NodeJS.ProcessEnv): Promise<Check[]> {
  const invocation = helpInvocation(profile.argv);
  const help = await run(invocation.command, invocation.args, env);
  if (help.code === null || help.out.trim() === '') {
    return [check('flags', 'SKIP', `${invocation.command} não respondeu a --help`)];
  }

  const flags = flagsOf(profile.argv);
  const missing = flags.filter((flag) => !help.out.includes(flag));
  const version = help.out.match(/\d+\.\d+\.\d+/)?.[0];
  const checks = [
    missing.length === 0
      ? check('flags', 'PASS', `${flags.length} flag(s) reconhecida(s) pela CLI instalada`)
      : check('flags', 'FAIL', `não existem nesta CLI: ${missing.join(', ')}`),
  ];
  if (version) checks.push(check('versão da CLI', 'PASS', `--help menciona ${version}`));
  return checks;
}

function checkForbidden(profile: LauncherProfile): Check {
  try {
    assertNoForbiddenFlags(profile, profile.argv);
    return check('flags proibidas', 'PASS', 'nenhuma flag de continuidade no argv base');
  } catch (error) {
    return check('flags proibidas', 'FAIL', error instanceof Error ? error.message : String(error));
  }
}

interface PermissionPolicy {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
}

async function readPolicy(repoRoot: string, profile: LauncherProfile): Promise<PermissionPolicy | null> {
  const index = profile.argv.indexOf('--settings');
  const file = index >= 0 ? profile.argv[index + 1] : undefined;
  if (file === undefined) return null;
  const parsed = JSON.parse(await readFile(path.resolve(repoRoot, file), 'utf8')) as {
    permissions?: { allow?: string[]; deny?: string[] };
  };
  return { allow: parsed.permissions?.allow ?? [], deny: parsed.permissions?.deny ?? [] };
}

async function checkPolicy(repoRoot: string, profile: LauncherProfile): Promise<Check> {
  if (profile.agent !== 'claude') {
    return check('política de permissões', 'SKIP', `não se aplica ao agente ${profile.agent}`);
  }
  try {
    const policy = await readPolicy(repoRoot, profile);
    if (!policy) {
      return check(
        'política de permissões',
        'FAIL',
        'perfil sem --settings: o worker dependeria das permissões pessoais da máquina',
      );
    }
    if (policy.allow.length === 0) {
      return check('política de permissões', 'FAIL', 'allow list vazia');
    }
    return check(
      'política de permissões',
      'PASS',
      `${policy.allow.length} regra(s) allow, ${policy.deny.length} deny`,
    );
  } catch (error) {
    return check(
      'política de permissões',
      'FAIL',
      `--settings ilegível: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function checkPersonalSettings(profile: LauncherProfile): Check {
  if (profile.agent !== 'claude') {
    return check('settings pessoais', 'SKIP', `não se aplica ao agente ${profile.agent}`);
  }
  const index = profile.argv.indexOf('--setting-sources');
  const value = index >= 0 ? profile.argv[index + 1] : undefined;
  if (value === undefined) {
    return check(
      'settings pessoais',
      'WARN',
      'sem --setting-sources: settings de user e local do usuário carregam junto',
    );
  }
  const sources = value.split(',').map((source) => source.trim());
  const personal = sources.filter((source) => source === 'user' || source === 'local');
  return personal.length === 0
    ? check('settings pessoais', 'PASS', `somente ${sources.join(', ')}`)
    : check('settings pessoais', 'WARN', `inclui fonte pessoal: ${personal.join(', ')}`);
}

function optionValues(argv: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === flag) {
      const value = argv[index + 1];
      if (value !== undefined && !value.startsWith('-')) values.push(value);
      continue;
    }
    if (token.startsWith(`${flag}=`)) values.push(token.slice(flag.length + 1));
  }
  return values;
}

function uniqueOptionValue(argv: readonly string[], flag: string): string {
  const values = optionValues(argv, flag);
  return values.length === 1 ? (values[0] as string) : 'unknown';
}

function isCodexBuildWorker(profile: LauncherProfile): boolean {
  return profile.agent === 'codex' && profile.id.includes('build-worker');
}

function checkSandbox(profile: LauncherProfile, sandbox: string): Check {
  if (!isCodexBuildWorker(profile)) {
    return check('sandbox', 'SKIP', `não se aplica ao perfil ${profile.id}`);
  }
  return sandbox === 'workspace-write'
    ? check('sandbox', 'PASS', 'workspace-write explícito')
    : check('sandbox', 'FAIL', `build-worker exige workspace-write; recebido ${sandbox}`);
}

function checkSessionPersistence(profile: LauncherProfile, persistence: string): Check {
  if (!isCodexBuildWorker(profile)) {
    return check('persistência da sessão', 'SKIP', `não se aplica ao perfil ${profile.id}`);
  }
  return persistence === 'ephemeral'
    ? check('persistência da sessão', 'PASS', 'ephemeral por --ephemeral')
    : check('persistência da sessão', 'FAIL', 'build-worker Codex exige --ephemeral');
}

function checkUserConfig(profile: LauncherProfile, ignored: boolean): Check {
  if (!isCodexBuildWorker(profile)) {
    return check('config do usuário', 'SKIP', `não se aplica ao perfil ${profile.id}`);
  }
  return ignored
    ? check('config do usuário', 'PASS', 'ignorada por --ignore-user-config')
    : check('config do usuário', 'FAIL', 'build-worker Codex exige --ignore-user-config');
}

function checkExecpolicyRules(profile: LauncherProfile, ignored: boolean): Check {
  if (profile.instruction_environment !== 'sanitized_user_home') {
    return check('regras de execpolicy', 'SKIP', 'perfil não declara HOME lean');
  }
  return ignored
    ? check('regras de execpolicy', 'PASS', 'execpolicy .rules ignoradas por --ignore-rules')
    : check('regras de execpolicy', 'FAIL', 'perfil lean exige --ignore-rules');
}

function checkInstructionHome(
  profile: LauncherProfile,
  workerEnv: NodeJS.ProcessEnv | null,
  environmentError: string | null,
  sanitizedHome: string,
): Check {
  if (profile.instruction_environment !== 'sanitized_user_home') {
    return check('HOME de instruções', 'WARN', 'HOME real do usuário; ~/.agents pode ser descoberto');
  }
  if (!workerEnv) return check('HOME de instruções', 'FAIL', environmentError ?? 'ambiente inválido');
  const home = workerEnv['HOME'];
  const codexHome = workerEnv['CODEX_HOME'];
  if (home !== sanitizedHome || !codexHome || codexHome === home) {
    return check('HOME de instruções', 'FAIL', 'HOME sanitizado e CODEX_HOME não estão separados');
  }
  return check(
    'HOME de instruções',
    'PASS',
    'sanitized_user_home; ~/.agents pessoal fora do HOME; CODEX_HOME preservado para auth',
  );
}

const GIT_IDENTITY_VARIABLES = [
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
] as const;

async function checkGitIdentity(
  repoRoot: string,
  profile: LauncherProfile,
  workerEnv: NodeJS.ProcessEnv | null,
): Promise<Check> {
  if (!isCodexBuildWorker(profile)) {
    return check('identidade Git', 'SKIP', `não se aplica ao perfil ${profile.id}`);
  }
  if (profile.commit_owner === 'orchestrator') {
    return check(
      'identidade Git',
      'SKIP',
      'identidade do commit pertence ao harness fora do sandbox do provider',
    );
  }
  if (!workerEnv) return check('identidade Git', 'FAIL', 'ambiente do worker inválido');
  const missing = GIT_IDENTITY_VARIABLES.filter((name) => !workerEnv[name]);
  if (missing.length > 0) {
    return check('identidade Git', 'FAIL', `variáveis ausentes: ${missing.join(', ')}`);
  }
  const author = await run('git', ['var', 'GIT_AUTHOR_IDENT'], workerEnv, repoRoot);
  const committer = await run('git', ['var', 'GIT_COMMITTER_IDENT'], workerEnv, repoRoot);
  return author.code === 0 && committer.code === 0
    ? check('identidade Git', 'PASS', 'autor e committer resolvidos no ambiente do worker')
    : check('identidade Git', 'FAIL', 'git commit não resolveria autor e committer');
}

function checkExecutionPolicy(profile: LauncherProfile): Check {
  const policy = executionPolicyOf(profile);
  return check(
    'execution policy',
    'PASS',
    `${policy.commit_owner}/${policy.official_validation_owner}/${policy.worker_validation_policy}`,
  );
}

function modelOf(profile: LauncherProfile): string {
  if (profile.agent === 'fake') return 'not_applicable';
  const values = optionValues(profile.argv, '--model');
  return values.length === 1 ? (values[0] as string) : 'unknown';
}

function unquoteTomlString(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const first = trimmed[0];
  const last = trimmed.at(-1);
  if ((first === '"' || first === "'") && last === first) return trimmed.slice(1, -1);
  if (first === '"' || first === "'" || last === '"' || last === "'") return null;
  return trimmed;
}

function configArguments(argv: readonly string[]): Array<string | null> {
  const arguments_: Array<string | null> = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === '--config') {
      const value = argv[index + 1];
      arguments_.push(value === undefined || value.startsWith('-') ? null : value);
      continue;
    }
    if (token.startsWith('--config=')) {
      const value = token.slice('--config='.length);
      arguments_.push(value === '' ? null : value);
    }
  }
  return arguments_;
}

function configOverrideValues(argv: readonly string[], key: string): Array<string | null> {
  const values: Array<string | null> = [];
  for (const override of configArguments(argv)) {
    if (override === null) return [null];
    const separator = override.indexOf('=');
    if (separator <= 0) return [null];
    if (override.slice(0, separator).trim() !== key) continue;
    values.push(unquoteTomlString(override.slice(separator + 1)));
  }
  return values;
}

export function codexReasoningEffort(argv: readonly string[]): string | null {
  const values = configOverrideValues(argv, 'model_reasoning_effort');
  const [value] = values;
  return values.length === 1 && value !== null && value !== undefined ? value : null;
}

function reasoningEffortOf(profile: LauncherProfile): string {
  if (profile.agent !== 'codex') return 'not_applicable';
  return codexReasoningEffort(profile.argv) ?? 'unknown';
}

function checkModelPinned(profile: LauncherProfile, model: string): Check {
  if (profile.agent === 'fake') return check('modelo', 'SKIP', 'worker falso não tem modelo');
  if (model === 'unknown') {
    return check('modelo', 'FAIL', 'modelo não fixado de forma única no argv');
  }
  if (profile.agent === 'codex' && model !== 'gpt-5.6-sol') {
    return check('modelo', 'FAIL', `esperado gpt-5.6-sol, recebido ${model}`);
  }
  return check('modelo', 'PASS', model);
}

function checkReasoningEffort(profile: LauncherProfile, reasoningEffort: string): Check {
  if (profile.agent !== 'codex') {
    return check('reasoning effort', 'SKIP', `não se aplica ao agente ${profile.agent}`);
  }
  if (reasoningEffort === 'unknown') {
    return check(
      'reasoning effort',
      'FAIL',
      'model_reasoning_effort não está fixado de forma explícita e única no argv',
    );
  }
  if (reasoningEffort !== 'high') {
    return check('reasoning effort', 'FAIL', `esperado high, recebido ${reasoningEffort}`);
  }
  if (!profile.argv.includes('--ignore-user-config')) {
    return check(
      'reasoning effort',
      'FAIL',
      'high explícito, mas sem --ignore-user-config o config.toml pessoal ainda seria carregado',
    );
  }
  return check(
    'reasoning effort',
    'PASS',
    'high · override explícito no argv · --ignore-user-config',
  );
}

/**
 * Cobertura da allow list contra os comandos que o worker terá de rodar. Um
 * comando de validação não coberto vira pedido de permissão — que ninguém
 * pode responder em `--print`.
 */
export function uncoveredValidationCommands(
  loaded: LoadedPlan,
  allow: readonly string[],
): string[] {
  const uncovered = new Set<string>();
  for (const task of loaded.plan.tasks) {
    for (const command of task.validation) {
      const argv = command.argv.join(' ');
      const covered = allow.some((rule) => {
        const inner = rule.match(/^Bash\((.*)\)$/)?.[1];
        if (inner === undefined) return false;
        const prefix = inner.endsWith(':*') ? inner.slice(0, -2) : inner;
        return argv === prefix || argv.startsWith(`${prefix} `);
      });
      if (!covered) uncovered.add(argv);
    }
  }
  return [...uncovered].sort();
}

async function checkValidationCoverage(
  repoRoot: string,
  profile: LauncherProfile,
  loaded: LoadedPlan | null,
): Promise<Check> {
  if (profile.agent !== 'claude' || !loaded) {
    return check('validações do plano', 'SKIP', 'sem política de Bash a conferir');
  }
  const policy = await readPolicy(repoRoot, profile).catch(() => null);
  if (!policy) return check('validações do plano', 'SKIP', 'perfil sem --settings');

  const uncovered = uncoveredValidationCommands(loaded, policy.allow);
  return uncovered.length === 0
    ? check('validações do plano', 'PASS', 'todo comando de validação está na allow list')
    : check('validações do plano', 'FAIL', `sem regra allow: ${uncovered.join('; ')}`);
}

function checkBillingMode(profile: LauncherProfile): Check {
  if (profile.agent === 'fake') {
    return check('modo de cobrança', 'SKIP', 'worker falso não fala com provider nenhum');
  }
  if (profile.billing_mode === 'subscription_only') {
    return check(
      'modo de cobrança',
      'PASS',
      `subscription_only · ambiente ${profile.environment_mode}`,
    );
  }
  return check(
    'modo de cobrança',
    'FAIL',
    `billing_mode=${profile.billing_mode}: run pago por API exige autorização manual explícita`,
  );
}

/**
 * Uma variável de API não precisa estar definida hoje para ser perigosa: se ela
 * está na allowlist, basta o usuário exportá-la no shell para o run inteiro
 * mudar de fonte de cobrança sem ninguém perceber. Só NOMES são reportados.
 */
function checkApiVariables(
  profile: LauncherProfile,
  workerEnv: NodeJS.ProcessEnv,
  env: NodeJS.ProcessEnv,
): Check {
  const declared = apiCredentialNamesIn([
    ...profile.env_allowlist,
    ...Object.keys(profile.env_extra),
  ]);
  if (declared.length > 0) {
    return check(
      'variáveis de API',
      'FAIL',
      `o perfil deixaria passar ao worker: ${declared.join(', ')}`,
    );
  }
  const leaked = apiCredentialNamesIn(Object.keys(workerEnv));
  if (leaked.length > 0) {
    return check('variáveis de API', 'FAIL', `chegariam ao worker: ${leaked.join(', ')}`);
  }
  const inShell = apiCredentialNamesIn(Object.keys(env));
  const detail =
    inShell.length > 0
      ? `nenhuma chega ao worker (${inShell.length} definida(s) no shell ficam de fora)`
      : 'nenhuma no perfil nem no ambiente';
  return check('variáveis de API', 'PASS', detail);
}

/**
 * Prova POSITIVA da fonte da credencial, com comando local e não pago da CLI
 * que o perfil vai lançar. Ausência de chave de API não é prova de assinatura:
 * sem resposta reconhecível, o veredito é FAIL.
 */
async function checkCredentialSource(
  profile: LauncherProfile,
  workerEnv: NodeJS.ProcessEnv | null,
  runner: CommandRunner | undefined,
): Promise<{ check: Check; source: CredentialSource }> {
  if (profile.agent === 'fake') {
    return {
      check: check('fonte da credencial', 'SKIP', 'worker falso não autentica'),
      source: 'not_applicable',
    };
  }
  if (!workerEnv) {
    return {
      check: check('fonte da credencial', 'FAIL', UNVERIFIABLE_CREDENTIAL_MESSAGE),
      source: 'unknown',
    };
  }
  const probe = await probeCredentialSource({
    agent: profile.agent,
    binary: profile.argv[0] as string,
    env: workerEnv,
    ...(runner ? { runner } : {}),
  });
  const expected = expectedSubscriptionSource(profile.agent);

  if (probe.source === 'api') {
    return {
      check: check(
        'fonte da credencial',
        'FAIL',
        `autenticação efetiva é API (${probe.detail}) — a política exige assinatura`,
      ),
      source: probe.source,
    };
  }
  if (probe.source !== expected || !probe.verified) {
    return {
      check: check(
        'fonte da credencial',
        'FAIL',
        `${UNVERIFIABLE_CREDENTIAL_MESSAGE} — ${probe.command}: ${probe.detail}`,
      ),
      source: probe.source,
    };
  }
  return {
    check: check('fonte da credencial', 'PASS', `${probe.source} · ${probe.detail}`),
    source: probe.source,
  };
}

export interface DoctorInput {
  readonly repoRoot: string;
  readonly profileId: string;
  readonly loaded?: LoadedPlan | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly runtimeDir?: string;
  /** Injetado pelos testes: prova a credencial sem chamar CLI de verdade. */
  readonly credentialRunner?: CommandRunner;
}

export async function diagnose(input: DoctorInput): Promise<DoctorReport> {
  const profile = await loadProfile(input.repoRoot, input.profileId);
  const env = input.env ?? process.env;
  const runtimeDir = input.runtimeDir ?? path.join(input.repoRoot, '.dev');
  const sanitizedHome = path.join(runtimeDir, 'homes', profile.id);
  let workerEnv: NodeJS.ProcessEnv | null = null;
  let environmentError: string | null = null;
  try {
    workerEnv = buildEnvironment(profile, env, { sanitizedHome });
  } catch (error) {
    environmentError = error instanceof Error ? error.message : String(error);
  }
  const model = modelOf(profile);
  const reasoningEffort = reasoningEffortOf(profile);
  const sandbox = uniqueOptionValue(profile.argv, '--sandbox');
  const sessionPersistence = profile.argv.includes('--ephemeral') ? 'ephemeral' : 'persistent';
  const userConfigIgnored = profile.argv.includes('--ignore-user-config');
  const rulesIgnored = profile.argv.includes('--ignore-rules');
  const credential = await checkCredentialSource(profile, workerEnv, input.credentialRunner);
  const checks: Check[] = [
    check('perfil', 'PASS', `${profile.id} (${profile.agent}) carregado e válido`),
    await checkBinary(profile, workerEnv ?? env),
    ...(await checkFlags(profile, workerEnv ?? env)),
    checkForbidden(profile),
    checkExecutionPolicy(profile),
    checkSandbox(profile, sandbox),
    checkSessionPersistence(profile, sessionPersistence),
    checkUserConfig(profile, userConfigIgnored),
    checkExecpolicyRules(profile, rulesIgnored),
    checkInstructionHome(profile, workerEnv, environmentError, sanitizedHome),
    await checkGitIdentity(input.repoRoot, profile, workerEnv),
    checkModelPinned(profile, model),
    checkReasoningEffort(profile, reasoningEffort),
    await checkPolicy(input.repoRoot, profile),
    checkPersonalSettings(profile),
    await checkValidationCoverage(input.repoRoot, profile, input.loaded ?? null),
    checkBillingMode(profile),
    checkApiVariables(profile, workerEnv ?? {}, env),
    credential.check,
  ];

  return {
    profile_id: profile.id,
    agent: profile.agent,
    model,
    reasoning_effort: reasoningEffort,
    billing_mode: profile.billing_mode,
    credential_source: credential.source,
    environment_mode: profile.environment_mode,
    instruction_environment: profile.instruction_environment,
    commit_owner: profile.commit_owner,
    official_validation_owner: profile.official_validation_owner,
    worker_validation_policy: profile.worker_validation_policy,
    sandbox,
    session_persistence: sessionPersistence,
    user_config_ignored: userConfigIgnored,
    execpolicy_rules_ignored: rulesIgnored,
    ok: checks.every((entry) => entry.status !== 'FAIL'),
    checks,
  };
}
