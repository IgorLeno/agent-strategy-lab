import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AccessContractError,
  deriveWorkerAccessContract,
  deriveWorkerIo,
  ensureAccessContractRoots,
  readEffectiveAccess,
  translateAccessContract,
  verifyEffectiveAccess,
  type WorkerExecutionAccessContract,
} from '../../dev/lib/access-contract.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadProfileFromCatalog, type LauncherProfile } from '../../dev/lib/profile.js';
import { taskInboxDir } from '../../dev/lib/records.js';
import { REPO_ROOT } from './helpers.js';

const TASK = 'foundation_app_scaffold';
const OTHER_TASK = 'other_task';

let root: string;
let paths: HarnessPaths;
let codex: LauncherProfile;
let claude: LauncherProfile;
let fake: LauncherProfile;

/**
 * Runtime EXTERNO ao alvo — o layout do projeto real. É a separação entre
 * target, runtime do orquestrador e outbox do worker que o contrato precisa
 * refletir; resolver o incidente movendo o runtime para dentro do alvo teria
 * apagado justamente essa fronteira.
 */
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'agentlab-access-'));
  const target = path.join(root, 'project');
  await mkdir(target, { recursive: true });
  paths = resolveHarnessPaths(target, {
    devDir: path.join(root, 'control', 'runtime'),
    profileCatalogRoot: REPO_ROOT,
  });
  codex = await loadProfileFromCatalog(REPO_ROOT, 'codex-build-worker-subscription-terra-medium-v2');
  claude = await loadProfileFromCatalog(REPO_ROOT, 'claude-build-worker-subscription-opus5-high-v3');
  fake = await loadProfileFromCatalog(REPO_ROOT, 'fake-worker-v1');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function implementerContract(profile: LauncherProfile): WorkerExecutionAccessContract {
  return deriveWorkerAccessContract({
    role: 'implementer',
    profile,
    paths,
    io: deriveWorkerIo(paths, profile, TASK),
  });
}

async function verify(
  profile: LauncherProfile,
  contract: WorkerExecutionAccessContract,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
) {
  return verifyEffectiveAccess({
    paths,
    profile,
    contract,
    io: deriveWorkerIo(paths, profile, TASK),
    argv,
    env,
  });
}

describe('A. derivação do access contract', () => {
  it('declara workspace, outbox da tarefa e HOME sanitizado — e nada além disso', () => {
    const contract = implementerContract(codex);

    expect(contract.workspace).toEqual({ root: paths.repoRoot, access: 'read_write' });
    expect(contract.writable_roots).toEqual([
      { purpose: 'task_protocol_outbox', path: taskInboxDir(paths, TASK) },
      { purpose: 'sanitized_worker_home', path: path.join(paths.devDir, 'homes', codex.id) },
    ]);
    expect(contract.network.dependency_fetch).toBe(true);
  });

  it('não concede o runtime inteiro, o inbox inteiro nem o catálogo de profiles', () => {
    const roots = implementerContract(codex).writable_roots.map((entry) => entry.path);

    expect(roots).not.toContain(paths.devDir);
    expect(roots).not.toContain(paths.inboxDir);
    expect(roots).not.toContain(paths.profileCatalogRoot);
    for (const denied of [paths.devDir, paths.inboxDir, paths.profileCatalogRoot, paths.stateFile]) {
      for (const root of roots) {
        expect(path.relative(root, denied).startsWith('..') || path.isAbsolute(path.relative(root, denied))).toBe(true);
      }
    }
  });

  it('recusa root que tornaria gravável um caminho do control plane', () => {
    expect(() =>
      deriveWorkerAccessContract({
        role: 'implementer',
        profile: codex,
        paths,
        io: {
          ...deriveWorkerIo(paths, codex, TASK),
          // Outbox promovido para o inbox INTEIRO: um root só, mas que passa a
          // conter o inbox de todas as outras tarefas.
          reportPath: path.join(paths.inboxDir, 'report.json'),
          handoffDraftPath: path.join(paths.inboxDir, 'handoff-draft.json'),
        },
      }),
    ).toThrow(AccessContractError);
  });
});

describe('B. paths de protocolo pertencem ao contrato', () => {
  it('report e handoff-draft caem num root gravável; o inbox de outra tarefa não', async () => {
    const contract = implementerContract(codex);
    const io = deriveWorkerIo(paths, codex, TASK);
    await ensureAccessContractRoots(contract);
    const roots = contract.writable_roots.map((entry) => entry.path);

    const inside = (candidate: string) =>
      roots.some((root) => !path.relative(root, candidate).startsWith('..'));

    expect(inside(path.dirname(io.reportPath))).toBe(true);
    expect(inside(path.dirname(io.handoffDraftPath))).toBe(true);
    expect(inside(taskInboxDir(paths, OTHER_TASK))).toBe(false);

    // A prova estrutural: um output obrigatório NOVO que caia fora do contrato
    // reprova antes do launch, em vez de falhar dentro do sandbox do provider.
    await expect(
      verify(
        codex,
        contract,
        translateAccessContract(codex, contract, codex.argv).argv,
        { HOME: io.homeDir },
      ),
    ).resolves.toMatchObject({ verified_roots: roots });
  });
});

describe('C. HOME sanitizado', () => {
  it('é criado antes do spawn, entra no contrato e chega à tradução Codex', async () => {
    const contract = implementerContract(codex);
    const io = deriveWorkerIo(paths, codex, TASK);
    await ensureAccessContractRoots(contract);

    const translated = translateAccessContract(codex, contract, codex.argv);
    expect(translated.effective.writable_roots).toContain(io.homeDir);

    const proof = await verify(codex, contract, translated.argv, { HOME: io.homeDir });
    expect(proof.verified_roots).toContain(io.homeDir);
  });

  it('reprova quando o HOME do ambiente diverge do HOME derivado', async () => {
    const contract = implementerContract(codex);
    await ensureAccessContractRoots(contract);
    const translated = translateAccessContract(codex, contract, codex.argv);

    await expect(
      verify(codex, contract, translated.argv, { HOME: path.join(root, 'outro-home') }),
    ).rejects.toThrow(/HOME do ambiente/);
  });
});

describe('D. tradução Codex', () => {
  it('preserva workspace-write, concede só os roots do contrato e habilita a rede pedida', async () => {
    const contract = implementerContract(codex);
    await ensureAccessContractRoots(contract);
    const translated = translateAccessContract(codex, contract, codex.argv);

    const sandboxIndex = translated.argv.indexOf('--sandbox');
    expect(translated.argv[sandboxIndex + 1]).toBe('workspace-write');
    expect(translated.argv).toContain(
      `sandbox_workspace_write.writable_roots=${JSON.stringify(
        contract.writable_roots.map((entry) => entry.path),
      )}`,
    );
    expect(translated.argv).toContain('sandbox_workspace_write.network_access=true');
    expect(translated.effective.writable_roots).toEqual(
      contract.writable_roots.map((entry) => entry.path),
    );

    // O `-` final é o prompt do Codex: token de acesso caindo depois dele
    // deixaria de ser opção e viraria conteúdo.
    expect(translated.argv[translated.argv.length - 1]).toBe('-');

    for (const forbidden of ['--dangerously-bypass-approvals-and-sandbox', '--approve-for-me']) {
      expect(translated.argv).not.toContain(forbidden);
    }
  });

  it('traduz o contrato para Claude sem tocar na permission policy versionada', async () => {
    const contract = implementerContract(claude);
    await ensureAccessContractRoots(contract);
    const translated = translateAccessContract(claude, contract, claude.argv);

    // Região de opções, nunca depois do fim: o prompt do Claude é appendado
    // ao argv, e `--add-dir` é variádico — ele para no próximo token com `-`.
    expect(translated.argv.slice(0, 4)).toEqual([
      'claude',
      '--add-dir',
      taskInboxDir(paths, TASK),
      '--print',
    ]);
    const permissionIndex = translated.argv.indexOf('--permission-mode');
    expect(translated.argv[permissionIndex + 1]).toBe('acceptEdits');
    // Claude implementer usa HOME real: nada de HOME sanitizado no contrato.
    expect(contract.writable_roots.map((entry) => entry.purpose)).toEqual([
      'task_protocol_outbox',
    ]);

    await expect(verify(claude, contract, translated.argv, {})).resolves.toBeTruthy();
  });
});

describe('E. preflight fail-closed', () => {
  it('reprova quando a tradução omite um root exigido', async () => {
    const contract = implementerContract(codex);
    await ensureAccessContractRoots(contract);

    // Tradução DOENTE: só o outbox, HOME sanitizado esquecido.
    const partial = translateAccessContract(
      codex,
      { ...contract, writable_roots: contract.writable_roots.slice(0, 1) },
      codex.argv,
    );

    await expect(
      verify(codex, contract, partial.argv, { HOME: deriveWorkerIo(paths, codex, TASK).homeDir }),
    ).rejects.toThrow(/root exigido pelo contrato não foi concedido/);
  });

  it('reprova quando o provider recebe um root gravável fora do contrato', async () => {
    const contract = implementerContract(codex);
    await ensureAccessContractRoots(contract);
    const wide = translateAccessContract(
      codex,
      {
        ...contract,
        writable_roots: [
          ...contract.writable_roots,
          { purpose: 'task_protocol_outbox', path: taskInboxDir(paths, OTHER_TASK) },
        ],
      },
      codex.argv,
    );

    await expect(
      verify(codex, contract, wide.argv, { HOME: deriveWorkerIo(paths, codex, TASK).homeDir }),
    ).rejects.toThrow(/root gravável fora do contrato/);
  });

  it('reprova quando o sandbox declarado contradiz o contrato', async () => {
    const contract = implementerContract(codex);
    await ensureAccessContractRoots(contract);
    const readOnly = codex.argv.map((token, index) =>
      codex.argv[index - 1] === '--sandbox' ? 'read-only' : token,
    );
    const translated = translateAccessContract(codex, contract, readOnly);

    expect(readEffectiveAccess('codex', translated.argv).workspace_write).toBe(false);
    await expect(
      verify(codex, contract, translated.argv, { HOME: deriveWorkerIo(paths, codex, TASK).homeDir }),
    ).rejects.toThrow(/não concede escrita no workspace principal/);
  });

  it('reprova quando um root do contrato não existe em disco', async () => {
    const contract = implementerContract(codex);
    const translated = translateAccessContract(codex, contract, codex.argv);

    // Sem `ensureAccessContractRoots`: path declarado, diretório inexistente.
    await expect(
      verify(codex, contract, translated.argv, { HOME: deriveWorkerIo(paths, codex, TASK).homeDir }),
    ).rejects.toThrow(/não existe ou não é gravável/);
  });
});

describe('F. rede como capability', () => {
  it('não habilita rede que o contrato não pediu, quando o provider sabe negar', async () => {
    const contract = implementerContract(codex);
    await ensureAccessContractRoots(contract);
    const semRede: WorkerExecutionAccessContract = {
      ...contract,
      network: { dependency_fetch: false },
    };

    const translated = translateAccessContract(codex, semRede, codex.argv);
    expect(translated.argv).not.toContain('sandbox_workspace_write.network_access=true');
    expect(readEffectiveAccess('codex', translated.argv).network_access).toBe(false);

    // E o contrário reprova: rede ligada sem o contrato pedir.
    const comRede = translateAccessContract(codex, contract, codex.argv);
    await expect(
      verify(codex, semRede, comRede.argv, { HOME: deriveWorkerIo(paths, codex, TASK).homeDir }),
    ).rejects.toThrow(/rede que o contrato não pediu/);
  });
});

describe('G. isolamento de role', () => {
  it('planner e reviewer não recebem workspace de escrita nem outbox de protocolo', () => {
    for (const role of ['planner', 'reviewer'] as const) {
      const contract = deriveWorkerAccessContract({
        role,
        profile: claude,
        paths,
        io: deriveWorkerIo(paths, claude, TASK),
      });

      expect(contract.workspace.access).toBe('read_only');
      expect(contract.network.dependency_fetch).toBe(false);
      expect(contract.writable_roots.map((entry) => entry.purpose)).not.toContain(
        'task_protocol_outbox',
      );
    }
  });

  it('role read-only de profile com HOME sanitizado mantém só essa capability mínima', () => {
    const contract = deriveWorkerAccessContract({
      role: 'reviewer',
      profile: codex,
      paths,
      io: deriveWorkerIo(paths, codex, TASK),
    });

    expect(contract.writable_roots.map((entry) => entry.purpose)).toEqual([
      'sanitized_worker_home',
    ]);
  });
});

describe('J. worker falso', () => {
  it('representa um contrato válido sem sandbox real de filesystem', async () => {
    const contract = implementerContract(fake);
    await ensureAccessContractRoots(contract);
    const translated = translateAccessContract(fake, contract, fake.argv);

    expect(translated.argv).toEqual([...fake.argv]);
    expect(translated.effective.enforcement).toBe('NO_PROVIDER_FILESYSTEM_SANDBOX');
    await expect(verify(fake, contract, translated.argv, {})).resolves.toMatchObject({
      verified_roots: [taskInboxDir(paths, TASK)],
    });
  });
});

describe('I. layout default histórico', () => {
  it('continua derivando um contrato válido com runtime em <repo>/.dev', async () => {
    const legacy = resolveHarnessPaths(path.join(root, 'legacy-repo'));
    const io = deriveWorkerIo(legacy, codex, TASK);
    const contract = deriveWorkerAccessContract({ role: 'implementer', profile: codex, paths: legacy, io });
    await ensureAccessContractRoots(contract);

    expect(contract.writable_roots.map((entry) => entry.path)).toEqual([
      path.join(legacy.repoRoot, '.dev-inbox', TASK),
      path.join(legacy.repoRoot, '.dev', 'homes', codex.id),
    ]);

    await expect(
      verifyEffectiveAccess({
        paths: legacy,
        profile: codex,
        contract,
        io,
        argv: translateAccessContract(codex, contract, codex.argv).argv,
        env: { HOME: io.homeDir },
      }),
    ).resolves.toBeTruthy();
  });
});
