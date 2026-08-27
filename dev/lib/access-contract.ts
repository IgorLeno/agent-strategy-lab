/**
 * WorkerExecutionAccessContract — a representação ÚNICA do acesso que uma
 * execução de worker precisa ter para conseguir cumprir o protocolo.
 *
 * CONTROL THE BOUNDARIES, NOT THE IMPLEMENTATION. O control plane declara o
 * que o worker precisa poder fazer (escrever no workspace, escrever o outbox
 * de protocolo da própria tarefa, escrever no HOME sanitizado, buscar
 * dependências na rede). Cada provider TRADUZ esse contrato para o mecanismo
 * real do seu sandbox, e o launcher PROVA que a tradução cobre o contrato
 * ANTES de gastar token nenhum.
 *
 * A classe de falha que este módulo elimina: o Agent Lab entregava ao worker
 * caminhos de escrita (report.json, handoff-draft.json, HOME) que o sandbox
 * efetivo do provider não concedia. O worker fazia o trabalho, terminava com
 * exit 0 e não conseguia produzir o protocolo — duas execuções pagas para
 * descobrir uma incompatibilidade mecânica detectável antes do launch.
 *
 * REGRA: caminho passado ao worker NÃO implica permissão; o acesso efetivo
 * precisa ser provado. Deny by default — o que não está no contrato continua
 * não gravável.
 */

import { access as fsAccess, constants, mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { HarnessPaths } from './paths.js';
import type { LauncherProfile } from './profile.js';
import type { ProjectWorkerRole } from './project-roles.js';
import { handoffDraftPath, packetPath, reportPath } from './records.js';

/**
 * Recusa de PREFLIGHT: o contrato de acesso não pôde ser traduzido ou provado.
 * Nada foi lançado e nenhum token foi gasto — não é veredito sobre o worker,
 * nem falha de capability do modelo. É incompatibilidade mecânica.
 */
export class AccessContractError extends Error {
  constructor(readonly violations: readonly string[]) {
    super(
      `contrato de acesso do worker não pôde ser provado antes do launch — ${violations.join('; ')}`,
    );
    this.name = 'AccessContractError';
  }
}

/**
 * Propósito de cada root auxiliar. Enumerado de propósito: root sem propósito
 * declarado seria exatamente o "path arbitrário gravável" que o contrato existe
 * para impedir.
 */
export type WritableRootPurpose = 'task_protocol_outbox' | 'sanitized_worker_home';

export interface WritableRoot {
  readonly purpose: WritableRootPurpose;
  readonly path: string;
}

export interface WorkerExecutionAccessContract {
  readonly role: ProjectWorkerRole;
  readonly profile_id: string;
  /** Repositório alvo: o workspace principal, nunca um filesystem irrestrito. */
  readonly workspace: {
    readonly root: string;
    readonly access: 'read_write' | 'read_only';
  };
  /** Únicos caminhos FORA do workspace que o worker recebe com escrita. */
  readonly writable_roots: readonly WritableRoot[];
  /**
   * Conectividade necessária a operações normais de desenvolvimento (npm, pnpm,
   * pip, cargo, go...). NÃO é autorização para efeito externo: deploy, publish,
   * push, cloud, e-mail e crédito de API continuam governados pelos gates
   * próprios. NETWORK CONNECTIVITY != AUTHORIZATION TO PERFORM EXTERNAL SIDE
   * EFFECTS.
   */
  readonly network: { readonly dependency_fetch: boolean };
}

/**
 * IO derivado UMA vez por lançamento. env, prompt, sandbox do provider e
 * preflight consomem este mesmo objeto — é o que impede o drift em que o
 * prompt diz um path, o env diz outro e o sandbox configura um terceiro.
 */
export interface WorkerIo {
  readonly repoRoot: string;
  readonly packetPath: string;
  readonly reportPath: string;
  readonly handoffDraftPath: string;
  /** HOME derivado do runtime; só entra no contrato quando o profile o exige. */
  readonly homeDir: string;
  readonly sanitizedHomeRequired: boolean;
}

export function deriveWorkerIo(
  paths: HarnessPaths,
  profile: LauncherProfile,
  taskId: string,
): WorkerIo {
  return {
    repoRoot: paths.repoRoot,
    packetPath: packetPath(paths, taskId),
    reportPath: reportPath(paths, taskId),
    handoffDraftPath: handoffDraftPath(paths, taskId),
    homeDir: path.join(paths.devDir, 'homes', profile.id),
    sanitizedHomeRequired: profile.instruction_environment === 'sanitized_user_home',
  };
}

function isInsideOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sameRoot(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

/**
 * Caminhos do control plane que NENHUM root gravável pode conter. Conceder um
 * ancestral de qualquer um deles devolveria ao worker o runtime inteiro, o
 * catálogo de profiles, os inboxes das outras tarefas ou o plano — exatamente
 * o oposto de deny by default.
 */
function protectedControlPlanePaths(paths: HarnessPaths): readonly string[] {
  return [paths.devDir, paths.inboxDir, paths.profileCatalogRoot, paths.planFile, paths.stateFile];
}

function minimalityViolations(
  paths: HarnessPaths,
  roots: readonly WritableRoot[],
): readonly string[] {
  const violations: string[] = [];
  for (const root of roots) {
    if (!path.isAbsolute(root.path)) {
      violations.push(`root ${root.purpose} não é absoluto: ${root.path}`);
      continue;
    }
    for (const protectedPath of protectedControlPlanePaths(paths)) {
      if (isInsideOrEqual(root.path, protectedPath)) {
        violations.push(
          `root ${root.purpose} (${root.path}) tornaria gravável ${protectedPath} do control plane`,
        );
      }
    }
  }
  return violations;
}

/**
 * Deriva o contrato MÍNIMO do role. Implementer muta o workspace autorizado e
 * escreve o próprio outbox de protocolo; planner e reviewer são read-only e não
 * produzem protocolo, então não recebem nem workspace de escrita nem outbox.
 * Nada aqui é copiado de um role para o outro.
 */
export function deriveWorkerAccessContract(input: {
  readonly role: ProjectWorkerRole;
  readonly profile: LauncherProfile;
  readonly paths: HarnessPaths;
  readonly io: WorkerIo;
}): WorkerExecutionAccessContract {
  const { role, profile, paths, io } = input;
  const isImplementer = role === 'implementer';

  const roots: WritableRoot[] = [];
  if (isImplementer) {
    // UM diretório, não dois filenames: report e handoff-draft são artifacts do
    // mesmo outbox da tarefa corrente. Um terceiro artifact obrigatório no
    // futuro cai no mesmo root — e, se não cair, o preflight reprova.
    const outbox = path.dirname(io.reportPath);
    if (path.dirname(io.handoffDraftPath) !== outbox) {
      throw new AccessContractError([
        `report (${io.reportPath}) e handoff-draft (${io.handoffDraftPath}) não vivem no mesmo outbox de tarefa`,
      ]);
    }
    roots.push({ purpose: 'task_protocol_outbox', path: outbox });
  }
  if (io.sanitizedHomeRequired) {
    roots.push({ purpose: 'sanitized_worker_home', path: io.homeDir });
  }

  const minimality = minimalityViolations(paths, roots);
  if (minimality.length > 0) throw new AccessContractError(minimality);

  return {
    role,
    profile_id: profile.id,
    workspace: {
      root: io.repoRoot,
      access: isImplementer ? 'read_write' : 'read_only',
    },
    writable_roots: roots,
    // v0.1: implementer de desenvolvimento normal recebe dependency fetch — o
    // profile e o scope já autorizaram execução local, e `npm install` é
    // operação normal de desenvolvimento, não efeito externo. Role read-only
    // não instala nada e continua sem rede.
    network: { dependency_fetch: isImplementer },
  };
}

/** Cria os roots antes do launch: declarar path não basta, ele precisa existir. */
export async function ensureAccessContractRoots(
  contract: WorkerExecutionAccessContract,
): Promise<void> {
  for (const root of contract.writable_roots) {
    await mkdir(root.path, { recursive: true });
  }
}

/**
 * Acesso EFETIVO lido de volta do argv final — não da intenção do contrato.
 * É essa releitura que permite provar a tradução: um root que o tradutor
 * esqueceu simplesmente não aparece aqui, e o preflight reprova.
 */
export interface EffectiveAccess {
  readonly enforcement: 'PROVIDER_FILESYSTEM_SANDBOX' | 'NO_PROVIDER_FILESYSTEM_SANDBOX';
  readonly workspace_write: boolean;
  readonly writable_roots: readonly string[];
  readonly network_access: boolean;
  /** `false` quando o provider não tem como NEGAR rede: não há o que provar ali. */
  readonly network_restrictable: boolean;
  readonly mechanism: string;
}

export interface AccessTranslation {
  readonly argv: readonly string[];
  readonly effective: EffectiveAccess;
}

const CODEX_WRITABLE_ROOTS_KEY = 'sandbox_workspace_write.writable_roots';
const CODEX_NETWORK_KEY = 'sandbox_workspace_write.network_access';
const CODEX_CONFIG_FLAGS = new Set(['-c', '--config']);
const CLAUDE_ADD_DIR_FLAG = '--add-dir';

const CODEX_MECHANISM =
  `argv Codex: --sandbox workspace-write preservado; ${CODEX_WRITABLE_ROOTS_KEY} concede os roots ` +
  `auxiliares do contrato e ${CODEX_NETWORK_KEY} habilita dependency fetch`;
const CLAUDE_MECHANISM =
  `argv Claude: ${CLAUDE_ADD_DIR_FLAG} declara os roots auxiliares do contrato; a permission policy ` +
  'versionada continua governando o que pode ser executado';
const FAKE_MECHANISM =
  'worker falso: sem sandbox de filesystem do provider; o contrato é representado, não imposto pelo processo';

/**
 * A fronteira do OpenCode não está no argv: está na permissão que o Lab
 * escreve em `OPENCODE_PERMISSION`, onde `external_directory: deny` recusa
 * leitura e escrita fora do worktree. O worktree é escolhido por `--dir`, e é
 * por isso que os roots auxiliares do contrato entram como diretórios do
 * processo em vez de como flags de sandbox.
 */
const OPENCODE_ADD_DIR_FLAG = '--dir';
const OPENCODE_MECHANISM =
  `argv OpenCode: ${OPENCODE_ADD_DIR_FLAG} fixa o worktree; a fronteira é imposta por ` +
  'external_directory=deny na permissão versionada do Lab, não por flag de sandbox';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function tomlStringArray(values: readonly string[]): string {
  for (const value of values) {
    if (CONTROL_CHARACTERS.test(value)) {
      throw new AccessContractError([
        `root com caractere de controle não pode ir para o argv: ${JSON.stringify(value)}`,
      ]);
    }
  }
  return `[${values.map((value) => JSON.stringify(value)).join(',')}]`;
}

/**
 * Índice do único par `flag valor` no argv. `-1` quando a flag não existe ou
 * aparece mais de uma vez — nesse caso não há par único para ancorar.
 */
function singleFlagPairIndex(argv: readonly string[], flag: string): number {
  const indexes = argv.flatMap((token, index) => (token === flag ? [index] : []));
  if (indexes.length !== 1) return -1;
  const index = indexes[0] as number;
  return argv[index + 1] === undefined ? -1 : index;
}

/**
 * INÍCIO da região de opções: o primeiro token que começa com `-`. Tudo antes
 * dele é binário, interpretador, script ou subcomando; tudo depois é opção até
 * os posicionais finais. `-1` quando o argv não tem região de opções nenhuma.
 */
function firstOptionIndex(argv: readonly string[]): number {
  return argv.findIndex((token) => token.startsWith('-'));
}

/**
 * Onde os tokens de acesso entram no argv. Precisa ser a REGIÃO DE OPÇÕES: no
 * Codex o `-` final é o prompt lido do stdin, e no Claude o prompt é appendado
 * ao fim do argv — token de acesso caindo depois deles viraria conteúdo.
 *
 * Codex ancora no par `--sandbox <modo>`, que é a fronteira que os roots
 * qualificam; sem ele, e no Claude, ancora no início da região de opções — o
 * que também garante que o token seguinte aos roots seja uma flag, e portanto
 * que a lista variádica termine ali.
 */
function accessTokenInsertionIndex(agent: LauncherProfile['agent'], argv: readonly string[]): number {
  if (agent === 'codex') {
    const sandbox = singleFlagPairIndex(argv, '--sandbox');
    if (sandbox >= 0) return sandbox + 2;
  }
  const firstOption = firstOptionIndex(argv);
  if (firstOption < 0) {
    throw new AccessContractError([
      `argv de ${agent} não tem região de opções onde ancorar os roots do contrato: ${argv.join(' ')}`,
    ]);
  }
  return firstOption;
}

function insertAt(argv: readonly string[], index: number, tokens: readonly string[]): string[] {
  const next = [...argv];
  next.splice(index, 0, ...tokens);
  return next;
}

function configOverrides(argv: readonly string[]): Map<string, string> {
  const overrides = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    let assignment: string | undefined;
    if (CODEX_CONFIG_FLAGS.has(token)) {
      assignment = argv[index + 1];
      index += 1;
    } else if (token.startsWith('--config=')) {
      assignment = token.slice('--config='.length);
    }
    if (assignment === undefined) continue;
    const separator = assignment.indexOf('=');
    if (separator <= 0) continue;
    overrides.set(assignment.slice(0, separator), assignment.slice(separator + 1));
  }
  return overrides;
}

function parseCodexWritableRoots(raw: string | undefined): readonly string[] {
  if (raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

/** Valores de uma flag que aceita UM argumento; repetições são preservadas. */
function optionValues(argv: readonly string[], flag: string): readonly string[] {
  const values: string[] = [];
  for (const [index, token] of argv.entries()) {
    if (token === flag) {
      const value = argv[index + 1];
      if (value !== undefined && !value.startsWith('-')) values.push(value);
      continue;
    }
    if (token.startsWith(`${flag}=`)) values.push(token.slice(flag.length + 1));
  }
  return values;
}

function claudeAddedDirs(argv: readonly string[]): readonly string[] {
  const index = argv.indexOf(CLAUDE_ADD_DIR_FLAG);
  if (index < 0) return [];
  const dirs: string[] = [];
  for (let cursor = index + 1; cursor < argv.length; cursor += 1) {
    const token = argv[cursor] as string;
    if (token.startsWith('-')) break;
    dirs.push(token);
  }
  return dirs;
}

/**
 * Lê o acesso efetivo do argv FINAL de um agente. Provider-específico por
 * necessidade — é aqui, e só aqui, que o mecanismo real de cada CLI aparece.
 */
export function readEffectiveAccess(
  agent: LauncherProfile['agent'],
  argv: readonly string[],
): EffectiveAccess {
  switch (agent) {
    case 'codex': {
      const overrides = configOverrides(argv);
      const sandboxIndex = argv.indexOf('--sandbox');
      const mode = sandboxIndex >= 0 ? argv[sandboxIndex + 1] : undefined;
      // A fronteira de filesystem do Codex é o que o `--sandbox` DECLARA. Sem
      // ele o argv não afirma fronteira nenhuma, e é desonesto reportar prova
      // onde não há declaração: o mismatch que este preflight existe para pegar
      // é sandbox declarado que CONTRADIZ o contrato, ou roots que o sandbox
      // declarado não concede.
      const declared = mode !== undefined;
      return {
        enforcement: declared ? 'PROVIDER_FILESYSTEM_SANDBOX' : 'NO_PROVIDER_FILESYSTEM_SANDBOX',
        workspace_write: declared ? mode === 'workspace-write' : true,
        writable_roots: parseCodexWritableRoots(overrides.get(CODEX_WRITABLE_ROOTS_KEY)),
        network_access: overrides.get(CODEX_NETWORK_KEY) === 'true',
        network_restrictable: declared,
        mechanism: CODEX_MECHANISM,
      };
    }
    case 'claude':
      return {
        // A CLI do Claude não impõe sandbox de filesystem: o processo escreve
        // onde o usuário escreve, e o que governa a mutação é a permission
        // policy VERSIONADA (incluindo o overlay read-only de planner e
        // reviewer). O que `--add-dir` faz é declarar os roots auxiliares para
        // que a camada de tools não os recuse.
        enforcement: 'NO_PROVIDER_FILESYSTEM_SANDBOX',
        workspace_write: true,
        writable_roots: claudeAddedDirs(argv),
        // Conectividade do processo é a do orquestrador; declarar isto
        // restringível seria mentir sobre a prova.
        network_access: true,
        network_restrictable: false,
        mechanism: CLAUDE_MECHANISM,
      };
    case 'opencode': {
      const dirs = optionValues(argv, OPENCODE_ADD_DIR_FLAG);
      return {
        // A permissão do OpenCode é imposta pelo próprio processo, ANTES da
        // ferramenta rodar — `external_directory: deny` recusa caminho fora do
        // worktree. Isso é sandbox de filesystem do provider, e declará-lo como
        // ausente subestimaria a prova que o preflight consegue fazer.
        enforcement: 'PROVIDER_FILESYSTEM_SANDBOX',
        workspace_write: true,
        writable_roots: dirs,
        // A conectividade do processo é a do orquestrador; o que o Lab nega é
        // a FERRAMENTA de rede (webfetch/websearch), não o socket. Declarar
        // rede restringível aqui seria afirmar prova que o argv não dá.
        network_access: true,
        network_restrictable: false,
        mechanism: OPENCODE_MECHANISM,
      };
    }
    case 'fake':
      return {
        enforcement: 'NO_PROVIDER_FILESYSTEM_SANDBOX',
        workspace_write: true,
        writable_roots: [],
        network_access: true,
        network_restrictable: false,
        mechanism: FAKE_MECHANISM,
      };
    default:
      throw new AccessContractError([
        `agente ${String(agent)} não possui tradução de contrato de acesso`,
      ]);
  }
}

/**
 * Traduz o contrato para o mecanismo real do provider. O control plane não
 * conhece flags: ele deriva o contrato, e a tradução mora aqui.
 */
export function translateAccessContract(
  profile: LauncherProfile,
  contract: WorkerExecutionAccessContract,
  argv: readonly string[],
): AccessTranslation {
  const roots = contract.writable_roots.map((root) => root.path);

  switch (profile.agent) {
    case 'codex': {
      const tokens: string[] = [];
      if (roots.length > 0) {
        tokens.push('--config', `${CODEX_WRITABLE_ROOTS_KEY}=${tomlStringArray(roots)}`);
      }
      if (contract.network.dependency_fetch) {
        tokens.push('--config', `${CODEX_NETWORK_KEY}=true`);
      }
      const translated =
        tokens.length === 0
          ? [...argv]
          : insertAt(argv, accessTokenInsertionIndex('codex', argv), tokens);
      return { argv: translated, effective: readEffectiveAccess('codex', translated) };
    }
    case 'claude': {
      if (roots.length === 0) {
        return { argv: [...argv], effective: readEffectiveAccess('claude', argv) };
      }
      if (argv.includes(CLAUDE_ADD_DIR_FLAG)) {
        throw new AccessContractError([
          `argv Claude já declara ${CLAUDE_ADD_DIR_FLAG}; a tradução não duplica a fronteira`,
        ]);
      }
      const translated = insertAt(argv, accessTokenInsertionIndex('claude', argv), [
        CLAUDE_ADD_DIR_FLAG,
        ...roots,
      ]);
      return { argv: translated, effective: readEffectiveAccess('claude', translated) };
    }
    case 'opencode': {
      if (roots.length === 0) {
        return { argv: [...argv], effective: readEffectiveAccess('opencode', argv) };
      }
      if (argv.includes(OPENCODE_ADD_DIR_FLAG)) {
        throw new AccessContractError([
          `argv OpenCode já declara ${OPENCODE_ADD_DIR_FLAG}; a tradução não duplica a fronteira`,
        ]);
      }
      // `--dir` aceita UM diretório. Um contrato com mais de um root auxiliar
      // não é traduzível para este mecanismo, e inventar uma tradução parcial
      // concederia acesso que ninguém provou.
      if (roots.length > 1) {
        throw new AccessContractError([
          `contrato pede ${roots.length} roots auxiliares e ${OPENCODE_ADD_DIR_FLAG} declara um só: ` +
            'a fronteira não é traduzível sem conceder acesso não provado',
        ]);
      }
      const translated = insertAt(argv, accessTokenInsertionIndex('opencode', argv), [
        OPENCODE_ADD_DIR_FLAG,
        roots[0] as string,
      ]);
      return { argv: translated, effective: readEffectiveAccess('opencode', translated) };
    }
    case 'fake':
      return { argv: [...argv], effective: readEffectiveAccess('fake', argv) };
    default:
      throw new AccessContractError([
        `agente ${String(profile.agent)} não possui tradução de contrato de acesso`,
      ]);
  }
}

export interface AccessContractProof {
  readonly contract: WorkerExecutionAccessContract;
  readonly effective: EffectiveAccess;
  readonly verified_roots: readonly string[];
}

export interface VerifyEffectiveAccessInput {
  readonly paths: HarnessPaths;
  readonly profile: LauncherProfile;
  readonly contract: WorkerExecutionAccessContract;
  readonly io: WorkerIo;
  /** argv FINAL do agente, já traduzido — a fonte da prova. */
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

/**
 * PROVA determinística do contrato antes do spawn. Falha aqui é recusa de
 * preflight: o provider não é chamado e nenhum token é gasto.
 *
 * MECHANICAL ACCESS MISMATCH MUST FAIL BEFORE PROVIDER SPEND.
 */
export async function verifyEffectiveAccess(
  input: VerifyEffectiveAccessInput,
): Promise<AccessContractProof> {
  const { paths, profile, contract, io, argv, env } = input;
  const violations: string[] = [];
  const effective = readEffectiveAccess(profile.agent, argv);

  if (!sameRoot(contract.workspace.root, paths.repoRoot)) {
    violations.push(
      `workspace do contrato (${contract.workspace.root}) não é o repositório alvo (${paths.repoRoot})`,
    );
  }
  if (contract.workspace.access === 'read_write' && !effective.workspace_write) {
    violations.push('sandbox efetivo não concede escrita no workspace principal');
  }

  const required = contract.writable_roots.map((root) => root.path);
  // Sem sandbox de filesystem do provider, o que ele recebeu DECLARADO é a
  // única evidência de argv disponível; o worker falso não recebe nem isso, e
  // por contrato representa o contrato em vez de impô-lo.
  const granted = profile.agent === 'fake' ? required : effective.writable_roots;

  for (const root of required) {
    if (!granted.some((candidate) => sameRoot(candidate, root))) {
      violations.push(`root exigido pelo contrato não foi concedido pelo provider: ${root}`);
    }
  }
  for (const root of granted) {
    if (!required.some((candidate) => sameRoot(candidate, root))) {
      violations.push(`provider recebeu root gravável fora do contrato: ${root}`);
    }
  }

  violations.push(...minimalityViolations(paths, contract.writable_roots));

  // Todo path de escrita entregue ao worker precisa estar REPRESENTADO no
  // contrato. Se amanhã surgir um terceiro artifact obrigatório, é aqui que a
  // ausência aparece — antes de custar um launch.
  if (contract.workspace.access === 'read_write') {
    for (const [label, file] of [
      ['report', io.reportPath],
      ['handoff-draft', io.handoffDraftPath],
    ] as const) {
      const parent = path.dirname(file);
      if (!required.some((root) => isInsideOrEqual(root, parent))) {
        violations.push(
          `path de protocolo ${label} (${file}) não pertence a nenhum root do contrato`,
        );
      }
    }
  }

  if (io.sanitizedHomeRequired) {
    const home = env['HOME'];
    if (home === undefined) {
      violations.push('profile exige HOME sanitizado mas o ambiente do worker não define HOME');
    } else if (!sameRoot(home, io.homeDir)) {
      violations.push(`HOME do ambiente (${home}) diverge do HOME derivado (${io.homeDir})`);
    }
    if (!required.some((root) => sameRoot(root, io.homeDir))) {
      violations.push(`HOME sanitizado (${io.homeDir}) não está representado no contrato`);
    }
  } else if (contract.writable_roots.some((root) => root.purpose === 'sanitized_worker_home')) {
    violations.push('contrato declara HOME sanitizado que o profile não exige');
  }

  // Path declarado não é path gravável: só o filesystem responde isso.
  const verifiedRoots: string[] = [];
  for (const root of required) {
    try {
      await fsAccess(root, constants.W_OK);
      verifiedRoots.push(root);
    } catch {
      violations.push(`root do contrato não existe ou não é gravável pelo orquestrador: ${root}`);
    }
  }

  if (contract.network.dependency_fetch && !effective.network_access) {
    violations.push('contrato exige dependency fetch mas o sandbox efetivo não habilita rede');
  }
  if (
    !contract.network.dependency_fetch &&
    effective.network_restrictable &&
    effective.network_access
  ) {
    violations.push('sandbox efetivo habilita rede que o contrato não pediu');
  }

  if (violations.length > 0) throw new AccessContractError(violations);
  return { contract, effective, verified_roots: verifiedRoots };
}

/** Fatos do contrato para o LaunchRecord — evidência, não promessa. */
export function accessContractFacts(
  proof: AccessContractProof,
): Record<string, boolean | string | number> {
  return {
    access_contract_role: proof.contract.role,
    access_contract_workspace_access: proof.contract.workspace.access,
    access_contract_writable_roots: proof.contract.writable_roots.length,
    access_contract_dependency_fetch: proof.contract.network.dependency_fetch,
    access_contract_enforcement: proof.effective.enforcement,
    access_contract_mechanism: proof.effective.mechanism,
    access_contract_proven_before_spawn: true,
  };
}
