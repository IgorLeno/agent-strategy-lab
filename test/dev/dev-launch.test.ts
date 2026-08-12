import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  failedAttemptHandoffDraftPath,
  failedAttemptReportPath,
  handoffDraftPath,
  readHandoffDraft,
  readLaunchRecord,
  readReport,
  reportPath,
  writePacket,
  writeValidationFailedAttempt,
} from '../../dev/lib/records.js';
import {
  PROCESS_GONE_START_TICKS,
  captureProcessIdentity,
  isSameProcessAlive,
} from '../../dev/lib/process-identity.js';
import {
  buildInitialState,
  ensureRuntimeDirs,
  getTaskState,
  readState,
  writeState,
} from '../../dev/lib/state.js';
import { commitAll, makeSandboxRepo, runDevCli, runGit, type Sandbox } from './helpers.js';

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
    const claude = await loadProfile(process.cwd(), 'claude-build-worker-subscription-v1');
    const controlled = deriveControlledFacts(claude, [...claude.argv], { PATH: '/usr/bin' });

    // O perfil de assinatura NÃO PODE usar --bare (a flag força auth por
    // ANTHROPIC_API_KEY), então instruction files e plugins carregam. Isso fica
    // REGISTRADO, não omitido.
    expect(controlled['instruction_discovery']).toBe('não controlado');
    expect(controlled['plugins_and_hooks']).toBe('não controlado');
    // O que a flag garante de fato continua marcado como controlado.
    expect(controlled['mcp_servers']).toMatch(/--strict-mcp-config/);
    expect(controlled['session_persistence']).toMatch(/--no-session-persistence/);

    const comBare = deriveControlledFacts(claude, [...claude.argv, '--bare'], {});
    expect(comBare['instruction_discovery']).toMatch(/--bare/);

    // Cobrança e ambiente ficam registrados como dimensões separadas.
    expect(controlled['billing_mode']).toBe('subscription_only');
    expect(controlled['environment_mode']).toBe('real-world');
  });
});

describe('launchWorker', () => {
  it('registra no LaunchRecord a policy efetiva do profile orquestrado', async () => {
    await persistPacket();
    const packet = buildTaskPacket({
      task: loaded.byId.get('T1')!,
      baseSha: await headSha(paths.repoRoot),
      previousHandoff: null,
    });
    const orchestratedProfile: LauncherProfile = {
      ...profile,
      commit_owner: 'orchestrator',
      official_validation_owner: 'orchestrator',
      worker_validation_policy: 'targeted',
      env_extra: { ...profile.env_extra, AGENTLAB_FAKE_MODE: 'no-commit' },
    };

    const outcome = await launchWorker({ paths, profile: orchestratedProfile, packet });
    const persisted = await readLaunchRecord(paths, 'T1');
    const expected = {
      commit_owner: 'orchestrator',
      official_validation_owner: 'orchestrator',
      worker_validation_policy: 'targeted',
    };

    expect(outcome.record.execution_policy).toEqual(expected);
    expect(persisted?.execution_policy).toEqual(expected);
  });

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
    const timeoutProfile = {
      ...profile,
      env_extra: { ...profile.env_extra, AGENTLAB_FAKE_MODE: 'timeout' },
    };
    const outcome = await launchWorker({
      paths,
      profile: timeoutProfile,
      packet,
      timeoutSecondsOverride: 1,
    });
    expect(outcome.classification).toBe('TIMED_OUT');
    expect(outcome.record.timed_out).toBe(true);
    expect(await isSameProcessAlive(outcome.record.process)).toBe(false);
  }, 30_000);

  // Regressão: o processo termina no mesmo instante do spawn, então o 'close'
  // é emitido ANTES dos awaits de identidade/record/onStarted. Com o observador
  // instalado tarde, a espera nunca resolvia e o dev-launch morria com top-level
  // await pendurado (exit 13) em vez de classificar INFRA_ERROR.
  it('captura o término de processo que encerra imediatamente', async () => {
    await persistPacket();
    const packet = buildTaskPacket({
      task: loaded.byId.get('T1')!,
      baseSha: await headSha(paths.repoRoot),
      previousHandoff: null,
    });
    const missingCommandProfile: LauncherProfile = {
      ...profile,
      argv: ['agentlab-comando-que-nao-existe'],
    };

    // Repetido: a race é de ordenação de eventos, e uma passada só poderia
    // esconder o defeito atrás do escalonamento de um run específico.
    for (let repetition = 0; repetition < 3; repetition += 1) {
      const outcome = await launchWorker({
        paths,
        profile: missingCommandProfile,
        packet,
        // Um timeout curto NÃO é o que faz o teste terminar: se o close se
        // perder, a Promise nunca resolve e o caso estoura por timeout do
        // vitest, não por classificação errada.
        timeoutSecondsOverride: 30,
      });
      expect(outcome.classification).toBe('INFRA_ERROR');
      expect(outcome.record.exit_code).toBe(127);
      expect(outcome.record.timed_out).toBe(false);
      expect(outcome.record.finished_at).not.toBeNull();
      // O processo pode já ter sumido de /proc antes da captura: a identidade
      // registra a sentinela em vez de derrubar o lançamento.
      expect(outcome.record.process.pid).toBeGreaterThan(0);
      expect(await isSameProcessAlive(outcome.record.process)).toBe(false);
    }
  }, 30_000);

  it('identidade de processo já encerrado usa sentinela em vez de falhar', async () => {
    // pid de um processo que com certeza já terminou: nascido e colhido agora.
    const dead = await new Promise<number>((resolve) => {
      const child = spawn('true');
      child.once('close', () => resolve(child.pid as number));
    });

    const identity = await captureProcessIdentity(dead, dead, ['true'], new Date().toISOString());
    expect(identity.proc_start_ticks).toBe(PROCESS_GONE_START_TICKS);
    expect(await isSameProcessAlive(identity)).toBe(false);
  });
});

/**
 * O worker escreve num slot por tarefa, reusado por todo attempt. Começar um
 * lançamento sobre output de outro attempt sobrescreveria evidência sem deixar
 * rastro — e foi assim que um report de attempt reprovado passou a poder ser
 * lido como output do attempt seguinte.
 */
describe('guarda de proveniência do inbox no launch', () => {
  async function packetFor(taskId = 'T1') {
    return buildTaskPacket({
      task: loaded.byId.get(taskId)!,
      baseSha: await headSha(paths.repoRoot),
      previousHandoff: null,
    });
  }

  /** Par de artifacts sem attempt dono nenhum. */
  async function writeOrphanInbox(): Promise<void> {
    await mkdir(path.dirname(reportPath(paths, 'T1')), { recursive: true });
    await writeFile(reportPath(paths, 'T1'), '{"schema_version":1}\n', 'utf8');
    await writeFile(handoffDraftPath(paths, 'T1'), '{"schema_version":1}\n', 'utf8');
  }

  it('recusa lançar sobre artifacts sem proveniência, antes de qualquer efeito', async () => {
    await persistPacket();
    await writeOrphanInbox();

    await expect(launchWorker({ paths, profile, packet: await packetFor() })).rejects.toThrow(
      /inbox recusou o lançamento/i,
    );
    // Nada foi lançado: sem LaunchRecord, e o output continua intacto.
    expect(await readLaunchRecord(paths, 'T1')).toBeNull();
    expect(await readFile(reportPath(paths, 'T1'), 'utf8')).toBe('{"schema_version":1}\n');
  });

  it('recusa meio par no inbox', async () => {
    await persistPacket();
    await mkdir(path.dirname(reportPath(paths, 'T1')), { recursive: true });
    await writeFile(reportPath(paths, 'T1'), '{"schema_version":1}\n', 'utf8');

    await expect(launchWorker({ paths, profile, packet: await packetFor() })).rejects.toThrow(
      /meio par não prova proveniência/i,
    );
  });

  it('libera o par já preservado no archive do attempt dono e segue o lançamento', async () => {
    await persistPacket();
    const report = '{"schema_version":1,"attempt":"1"}\n';
    const handoff = '{"schema_version":1,"handoff":"1"}\n';
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');

    await mkdir(path.dirname(reportPath(paths, 'T1')), { recursive: true });
    await writeFile(reportPath(paths, 'T1'), report, 'utf8');
    await writeFile(handoffDraftPath(paths, 'T1'), handoff, 'utf8');
    // Cópia durável já publicada no attempt 1 — a evidência está segura.
    await mkdir(path.dirname(failedAttemptReportPath(paths, 'T1', 1)), { recursive: true });
    await writeFile(failedAttemptReportPath(paths, 'T1', 1), report, 'utf8');
    await writeFile(failedAttemptHandoffDraftPath(paths, 'T1', 1), handoff, 'utf8');
    await writeValidationFailedAttempt(paths, {
      schema_version: 1,
      task_id: 'T1',
      attempt: 1,
      source_base_sha: await headSha(paths.repoRoot),
      profile_id: 'fake-worker-v1',
      worker_self_reported_result: 'SUCCESS',
      report_candidate_commit: null,
      orchestrator_verdict: 'REJECTED_BY_OFFICIAL_VALIDATION',
      finalization_mode: 'normal',
      launch_record_sha256: digest('launch'),
      original_completion_sha256: digest('completion'),
      report_sha256: digest(report),
      handoff_draft_sha256: digest(handoff),
      source_binding_sha256: digest('binding'),
      patch_fingerprint: digest('patch'),
      changed_files: ['src/alvo.ts'],
      original_validation_results: [
        { argv: ['pnpm', 'test'], exit_code: 1, timed_out: false, duration_ms: 1 },
      ],
      change_bundle: {
        manifest_path: 'failed-attempts/T1/attempt-1/changes-manifest.json',
        manifest_sha256: digest('manifest'),
        patch_path: 'failed-attempts/T1/attempt-1/changes.patch',
        patch_sha256: digest('patch-bytes'),
        patch_size_bytes: 12,
      },
      reason_code: 'OFFICIAL_VALIDATION_FAILURE',
      reason: 'attempt 1 reprovado pela validation oficial',
      archived_at: '2026-08-12T18:14:28.960Z',
    });

    const outcome = await launchWorker({ paths, profile, packet: await packetFor() });
    expect(outcome.classification).toBe('FINISHED');
    // O archive do attempt 1 continua byte a byte; o inbox é do attempt novo.
    expect(await readFile(failedAttemptReportPath(paths, 'T1', 1), 'utf8')).toBe(report);
    expect(await readFile(reportPath(paths, 'T1'), 'utf8')).not.toBe(report);
  });

  it('o attempt seguinte não herda report nem handoff do anterior', async () => {
    await persistPacket();
    const first = await launchWorker({ paths, profile, packet: await packetFor() });
    expect(first.classification).toBe('FINISHED');
    const inherited = await readFile(reportPath(paths, 'T1'), 'utf8');

    // Sem archive do attempt anterior, o inbox ocupado é ambíguo e o launch
    // seguinte é recusado em vez de sobrescrever o que está lá.
    await expect(launchWorker({ paths, profile, packet: await packetFor() })).rejects.toThrow(
      /inbox recusou o lançamento/i,
    );
    expect(await readFile(reportPath(paths, 'T1'), 'utf8')).toBe(inherited);
  });
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
    expect(record?.execution_policy).toEqual({
      commit_owner: 'worker',
      official_validation_owner: 'worker',
      worker_validation_policy: 'full',
    });
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
    // O perfil é arquivo versionado: commitar antes deixa a árvore limpa, que
    // é o que a guarda de base exige para lançar.
    await commitAll(sandbox.root, 'perfil de teste');
    await persistPacket();

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
