import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTaskPacket } from '../../dev/lib/packet.js';
import { headSha } from '../../dev/lib/git.js';
import { launchWorker } from '../../dev/lib/launch.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import {
  ForbiddenFlagError,
  assertNoForbiddenFlags,
  buildEnvironment,
  deriveControlledFacts,
  loadProfile,
  type LauncherProfile,
} from '../../dev/lib/profile.js';
import {
  handoffDraftPath,
  readHandoffDraft,
  readLaunchRecord,
  readReport,
  reportPath,
  writePacket,
} from '../../dev/lib/records.js';
import { isSameProcessAlive } from '../../dev/lib/process-identity.js';
import {
  buildInitialState,
  ensureRuntimeDirs,
  getTaskState,
  readState,
  writeState,
} from '../../dev/lib/state.js';
import { makeSandboxRepo, runDevCli, runGit, type Sandbox } from './helpers.js';

let sandbox: Sandbox;
let paths: HarnessPaths;
let loaded: LoadedPlan;
let profile: LauncherProfile;

beforeEach(async () => {
  sandbox = await makeSandboxRepo();
  paths = resolveHarnessPaths(sandbox.root);
  loaded = await loadPlan(paths.planFile);
  profile = await loadProfile(sandbox.root, 'fake-worker-v1');
  await ensureRuntimeDirs(paths);
  await writeState(paths, buildInitialState(loaded.plan, loaded.planSha256));
});

afterEach(async () => {
  await rm(sandbox.root, { recursive: true, force: true });
});

async function persistPacket(taskId = 'T1'): Promise<void> {
  const packet = buildTaskPacket({
    task: loaded.byId.get(taskId)!,
    baseSha: await headSha(paths.repoRoot),
    previousHandoff: null,
  });
  await writePacket(paths, packet);
}

function launchCli(args: readonly string[], mode: string) {
  return runDevCli('dev-launch.ts', ['--repo', sandbox.root, '--profile', 'fake-worker-v1', ...args], {
    AGENTLAB_DEV_DIR: sandbox.devDir,
    AGENTLAB_FAKE_MODE: mode,
  });
}

describe('perfil do launcher', () => {
  it('recusa lançamento com flag proibida no argv', () => {
    expect(() => assertNoForbiddenFlags(profile, ['node', 'x.mjs', '--resume'])).toThrow(
      ForbiddenFlagError,
    );
    expect(() => assertNoForbiddenFlags(profile, ['node', 'x.mjs', '--session-id=abc'])).toThrow(
      ForbiddenFlagError,
    );
    expect(() => assertNoForbiddenFlags(profile, ['node', 'x.mjs'])).not.toThrow();
  });

  it('passa somente as variáveis da allowlist', () => {
    const env = buildEnvironment(profile, {
      PATH: '/usr/bin',
      HOME: '/home/x',
      ANTHROPIC_API_KEY: 'segredo-não-listado',
      QUALQUER_OUTRA: 'vazamento',
    });
    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH']);
  });

  it('registra o que foi de fato controlado, não o que se pretendia', async () => {
    const claude = await loadProfile(process.cwd(), 'claude-build-worker-v1');
    const controlled = deriveControlledFacts(claude, [...claude.argv], { PATH: '/usr/bin' });

    // O perfil atual não usa --bare (decisão do usuário: sessão OAuth), então
    // instruction files e plugins carregam. Isso fica REGISTRADO, não omitido.
    expect(controlled['instruction_discovery']).toBe('não controlado');
    expect(controlled['plugins_and_hooks']).toBe('não controlado');
    // O que a flag garante de fato continua marcado como controlado.
    expect(controlled['mcp_servers']).toMatch(/--strict-mcp-config/);
    expect(controlled['session_persistence']).toMatch(/--no-session-persistence/);

    const comBare = deriveControlledFacts(claude, [...claude.argv, '--bare'], {});
    expect(comBare['instruction_discovery']).toMatch(/--bare/);
  });
});

describe('launchWorker', () => {
  it('lança processo novo, registra identidade e o worker faz o trabalho', async () => {
    await persistPacket();
    const packet = buildTaskPacket({
      task: loaded.byId.get('T1')!,
      baseSha: await headSha(paths.repoRoot),
      previousHandoff: null,
    });

    let identityDuringRun = null;
    const outcome = await launchWorker({
      paths,
      profile,
      packet,
      onStarted: async (identity) => {
        identityDuringRun = identity;
      },
    });

    expect(outcome.classification).toBe('FINISHED');
    expect(outcome.record.exit_code).toBe(0);
    expect(identityDuringRun).not.toBeNull();
    expect(outcome.record.process.pid).toBeGreaterThan(0);
    expect(outcome.record.process.pgid).toBe(outcome.record.process.pid);
    expect(outcome.record.process.proc_start_ticks).toBeGreaterThan(0);
    expect(outcome.record.process.command_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.record.argv[0]).toBe('timeout');
    // O processo do worker não existe mais depois do término.
    expect(await isSameProcessAlive(outcome.record.process)).toBe(false);

    const status = await runGit(sandbox.root, ['log', '--oneline', '-1']);
    expect(status.stdout).toMatch(/T1/);
  });

  it('o worker escreve no inbox, não no runtime do orquestrador', async () => {
    await persistPacket();
    const packet = buildTaskPacket({
      task: loaded.byId.get('T1')!,
      baseSha: await headSha(paths.repoRoot),
      previousHandoff: null,
    });
    await launchWorker({ paths, profile, packet });

    // Inbox e runtime são diretórios diferentes, e é o inbox que recebe o
    // que o worker produziu.
    expect(paths.inboxDir.startsWith(paths.devDir + path.sep)).toBe(false);
    expect(reportPath(paths, 'T1').startsWith(paths.inboxDir + path.sep)).toBe(true);
    expect(handoffDraftPath(paths, 'T1').startsWith(paths.inboxDir + path.sep)).toBe(true);
    expect(await readReport(paths, 'T1')).not.toBeNull();
    expect(await readHandoffDraft(paths, 'T1')).not.toBeNull();

    const runtimeFiles = await readdir(paths.devDir, { recursive: true });
    expect(runtimeFiles.filter((file) => /report|draft/.test(String(file)))).toEqual([]);
  });

  it('timeout externo mata worker que ignora SIGTERM', async () => {
    await persistPacket();
    const packet = buildTaskPacket({
      task: loaded.byId.get('T1')!,
      baseSha: await headSha(paths.repoRoot),
      previousHandoff: null,
    });
    process.env['AGENTLAB_FAKE_MODE'] = 'timeout';
    try {
      const outcome = await launchWorker({ paths, profile, packet, timeoutSecondsOverride: 1 });
      expect(outcome.classification).toBe('TIMED_OUT');
      expect(outcome.record.timed_out).toBe(true);
      expect(await isSameProcessAlive(outcome.record.process)).toBe(false);
    } finally {
      delete process.env['AGENTLAB_FAKE_MODE'];
    }
  }, 30_000);
});

describe('dev-launch CLI', () => {
  it('exit 0 e RUNNING/FINALIZING quando o worker termina', async () => {
    await persistPacket();
    const result = await launchCli(['--task', 'T1'], 'success');
    expect(result.exitCode, result.stderr).toBe(0);

    const output = JSON.parse(result.stdout) as { classification: string; controlled: object };
    expect(output.classification).toBe('FINISHED');
    expect(output.controlled).toMatchObject({ fresh_process: true, resume: false });

    const task = getTaskState(await readState(paths), 'T1');
    expect(task.status).toBe('RUNNING');
    expect(task.phase).toBe('FINALIZING');
    expect(task.attempts).toBe(1);
    expect(task.process?.pid).toBeGreaterThan(0);

    const record = await readLaunchRecord(paths, 'T1');
    expect(record?.profile_id).toBe('fake-worker-v1');
    expect(record?.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('exit 7 e TIMED_OUT quando estoura o limite', async () => {
    await persistPacket();
    const result = await launchCli(['--task', 'T1', '--timeout-seconds', '1'], 'timeout');
    expect(result.exitCode).toBe(7);

    const task = getTaskState(await readState(paths), 'T1');
    expect(task.status).toBe('TIMED_OUT');
    expect(task.phase).toBeNull();
  }, 30_000);

  it('exit 8 e INFRA_ERROR quando o comando do perfil não existe', async () => {
    await persistPacket();
    await writeFile(
      `${sandbox.root}/dev/profiles/inexistente-v1.yaml`,
      [
        'id: inexistente-v1',
        'agent: fake',
        'argv: [agentlab-comando-que-nao-existe]',
        'prompt_delivery: argv',
        'timeout_seconds: 30',
        'forbidden_flags: []',
        'env_allowlist: [PATH]',
      ].join('\n'),
      'utf8',
    );

    const result = await runDevCli(
      'dev-launch.ts',
      ['--repo', sandbox.root, '--profile', 'inexistente-v1', '--task', 'T1'],
      { AGENTLAB_DEV_DIR: sandbox.devDir },
    );
    expect(result.exitCode, `${result.stderr}|${result.stdout}`).toBe(8);
    expect(JSON.parse(result.stdout).classification).toBe('INFRA_ERROR');
    expect(getTaskState(await readState(paths), 'T1').status).toBe('INFRA_ERROR');
  });

  it('recusa lançar tarefa que não está READY', async () => {
    await persistPacket();
    await launchCli(['--task', 'T1'], 'success');
    const second = await launchCli(['--task', 'T1'], 'success');
    expect(second.exitCode).not.toBe(0);
    expect(second.stderr).toMatch(/só READY pode ser lançada/);
  });

  it('o prompt entregue contém o packet e as regras de encerramento', async () => {
    await persistPacket();
    await launchCli(['--task', 'T1'], 'success');
    const record = await readLaunchRecord(paths, 'T1');
    const prompt = record?.argv.at(-1) ?? '';
    expect(prompt).toMatch(/EXATAMENTE UM commit/);
    expect(prompt).toMatch(/Não inicie a próxima tarefa/);
    expect(prompt).toMatch(/"task_id":"T1"/);
    expect(prompt).not.toMatch(/resume|transcript anterior/i);
  });

  it('não deixa o processo do worker vivo depois do término', async () => {
    await persistPacket();
    await launchCli(['--task', 'T1'], 'success');
    const record = await readLaunchRecord(paths, 'T1');
    expect(await isSameProcessAlive(record!.process)).toBe(false);
  });
});

describe('logs do launcher', () => {
  it('grava stdout e stderr do worker no runtime', async () => {
    await persistPacket();
    await launchCli(['--task', 'T1'], 'success');
    const stdout = await readFile(`${sandbox.devDir}/logs/T1.stdout.log`, 'utf8');
    expect(stdout).toBeTypeOf('string');
  });
});
