import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  UNVERIFIABLE_CREDENTIAL_MESSAGE,
  apiCredentialNamesIn,
  expectedSubscriptionSource,
  probeCredentialSource,
  type CommandRunner,
} from './billing.js';
import type { LoadedPlan } from './plan.js';
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
  /** Cobrança e ambiente são dimensões separadas, e ambas ficam no relatório. */
  readonly billing_mode: string;
  readonly environment_mode: string;
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
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
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

function checkModelPinned(profile: LauncherProfile): Check {
  const flag = profile.agent === 'codex' ? '--model' : '--model';
  const index = profile.argv.indexOf(flag);
  const model = index >= 0 ? profile.argv[index + 1] : undefined;
  if (profile.agent === 'fake') return check('modelo', 'SKIP', 'worker falso não tem modelo');
  return model === undefined
    ? check('modelo', 'FAIL', 'modelo não fixado: o run dependeria do default da CLI')
    : check('modelo', 'PASS', model);
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
function checkApiVariables(profile: LauncherProfile, env: NodeJS.ProcessEnv): Check {
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
  const leaked = apiCredentialNamesIn(Object.keys(buildEnvironment(profile, env)));
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
  env: NodeJS.ProcessEnv,
  runner: CommandRunner | undefined,
): Promise<Check> {
  if (profile.agent === 'fake') {
    return check('fonte da credencial', 'SKIP', 'worker falso não autentica');
  }
  const probe = await probeCredentialSource({
    agent: profile.agent,
    binary: profile.argv[0] as string,
    env: buildEnvironment(profile, env),
    ...(runner ? { runner } : {}),
  });
  const expected = expectedSubscriptionSource(profile.agent);

  if (probe.source === 'api') {
    return check(
      'fonte da credencial',
      'FAIL',
      `autenticação efetiva é API (${probe.detail}) — a política exige assinatura`,
    );
  }
  if (probe.source !== expected || !probe.verified) {
    return check(
      'fonte da credencial',
      'FAIL',
      `${UNVERIFIABLE_CREDENTIAL_MESSAGE} — ${probe.command}: ${probe.detail}`,
    );
  }
  return check('fonte da credencial', 'PASS', `${probe.source} · ${probe.detail}`);
}

export interface DoctorInput {
  readonly repoRoot: string;
  readonly profileId: string;
  readonly loaded?: LoadedPlan | null;
  readonly env?: NodeJS.ProcessEnv;
  /** Injetado pelos testes: prova a credencial sem chamar CLI de verdade. */
  readonly credentialRunner?: CommandRunner;
}

export async function diagnose(input: DoctorInput): Promise<DoctorReport> {
  const profile = await loadProfile(input.repoRoot, input.profileId);
  const env = input.env ?? process.env;
  const checks: Check[] = [
    check('perfil', 'PASS', `${profile.id} (${profile.agent}) carregado e válido`),
    await checkBinary(profile, env),
    ...(await checkFlags(profile, env)),
    checkForbidden(profile),
    checkModelPinned(profile),
    await checkPolicy(input.repoRoot, profile),
    checkPersonalSettings(profile),
    await checkValidationCoverage(input.repoRoot, profile, input.loaded ?? null),
    checkBillingMode(profile),
    checkApiVariables(profile, env),
    await checkCredentialSource(profile, env, input.credentialRunner),
  ];

  return {
    profile_id: profile.id,
    agent: profile.agent,
    billing_mode: profile.billing_mode,
    environment_mode: profile.environment_mode,
    ok: checks.every((entry) => entry.status !== 'FAIL'),
    checks,
  };
}
