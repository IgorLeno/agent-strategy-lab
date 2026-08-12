import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { headSha } from '../../dev/lib/git.js';
import { acquireLock } from '../../dev/lib/lock.js';
import type { MaintenanceValidationRunner } from '../../dev/lib/maintenance.js';
import {
  AUTO_MAINTENANCE_MAX_COMMITS,
  AUTO_MAINTENANCE_REASON,
  runOrchestrationPreflight,
  type PreflightInput,
} from '../../dev/lib/orchestrate-preflight.js';
import {
  detailPreflight,
  summarizePreflight,
} from '../../dev/lib/orchestrate-report.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import { readLaunchRecord, readMaintenanceRecord } from '../../dev/lib/records.js';
import type { ValidationCommand } from '../../dev/lib/schemas.js';
import {
  buildInitialState,
  ensureRuntimeDirs,
  readState,
  withTaskState,
  writeState,
} from '../../dev/lib/state.js';
import { commitAll, makeSandboxRepo, runDevCli, runGit, type Sandbox } from './helpers.js';

/**
 * PRE-FLIGHT automático do `dev-orchestrate`.
 *
 * A regra que estes testes protegem é uma só: situação inesperada não lança
 * provider. Nenhum caso aqui chama provider de verdade — os cenários de adoção
 * rodam contra um `validationRunner` injetado, porque disparar `pnpm test`
 * dentro do sandbox seria a suíte chamando a si mesma; os gates oficiais
 * continuam sendo os de `adoptMaintenance`, que este módulo não reimplementa.
 */

let sandbox: Sandbox;
let paths: HarnessPaths;
let loaded: LoadedPlan;
let baseline: string;
let validationCalls: ValidationCommand[];

const passingValidation: MaintenanceValidationRunner = async (command) => {
  validationCalls.push(command);
  return { argv: [...command.argv], exit_code: 0, timed_out: false, duration_ms: 1 };
};

beforeEach(async () => {
  sandbox = await makeSandboxRepo();
  paths = resolveHarnessPaths(sandbox.root);
  loaded = await loadPlan(paths.planFile);
  baseline = await headSha(sandbox.root);
  validationCalls = [];
  await ensureRuntimeDirs(paths);
  await writeState(
    paths,
    buildInitialState(loaded.plan, loaded.planSha256, { baselineSha: baseline }),
  );
});

afterEach(async () => {
  await rm(sandbox.root, { recursive: true, force: true });
});

function preflightInput(overrides: Partial<PreflightInput> = {}): PreflightInput {
  return {
    paths,
    loaded,
    validationRunner: passingValidation,
    now: () => '2026-08-12T15:00:00.000Z',
    ...overrides,
  };
}

async function createCommit(file: string, contents: string, message: string): Promise<string> {
  const absolute = path.join(sandbox.root, file);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, contents, 'utf8');
  return commitAll(sandbox.root, message);
}

async function maintenanceRecordCount(): Promise<number> {
  return (await readdir(paths.maintenanceDir)).filter((file) => file.endsWith('.json')).length;
}

async function packetCount(): Promise<number> {
  return (await readdir(paths.packetsDir)).length;
}

function orchestrate(mode: string, extra: readonly string[] = []) {
  return runDevCli(
    'dev-orchestrate.ts',
    ['--repo', sandbox.root, '--profile', 'fake-worker-v1', ...extra],
    { AGENTLAB_DEV_DIR: sandbox.devDir, AGENTLAB_FAKE_MODE: mode },
  );
}

// ---------------------------------------------------------------------------
// Estágio 1 — maintenance automática
// ---------------------------------------------------------------------------

describe('pre-flight: maintenance automática', () => {
  it('HEAD já autorizado é NOOP: nenhum record, nenhuma validação, nenhuma escrita', async () => {
    const result = await runOrchestrationPreflight(preflightInput());

    expect(result.status).toBe('READY');
    expect(result.maintenance.status).toBe('NOOP');
    expect(result.maintenance.commit_count).toBe(0);
    expect(validationCalls).toEqual([]);
    expect(await maintenanceRecordCount()).toBe(0);
    expect((await readState(paths)).authorized_head_sha).toBe(baseline);
  });

  it('um commit elegível é adotado pela adoção normal, com reason auditável', async () => {
    const adopted = await createCommit('docs/nota.md', 'manutenção\n', 'manutenção permitida');

    const result = await runOrchestrationPreflight(preflightInput());

    expect(result.status).toBe('READY');
    expect(result.maintenance.status).toBe('ADOPTED');
    expect(result.maintenance.adoption_kind).toBe('maintenance');
    expect(result.maintenance.commit_count).toBe(1);
    expect(result.maintenance.previous_authorized_head_sha).toBe(baseline);
    expect(result.maintenance.authorized_head_sha).toBe(adopted);
    expect((await readState(paths)).authorized_head_sha).toBe(adopted);

    const record = await readMaintenanceRecord(paths, adopted);
    expect(record?.reason).toBe(AUTO_MAINTENANCE_REASON);
    expect(record?.bootstrap_range).toBe(false);
    // Os quatro gates oficiais, não uma versão relaxada da adoção.
    expect(validationCalls.map((call) => call.argv.slice(0, 2))).toEqual([
      ['pnpm', 'typecheck'],
      ['pnpm', 'build'],
      ['pnpm', 'test'],
      ['git', 'diff'],
    ]);
  });

  it('dois commits elegíveis são adotados como faixa', async () => {
    await createCommit('docs/um.md', 'um\n', 'manutenção 1');
    const adopted = await createCommit('test/dois.md', 'dois\n', 'manutenção 2');

    const result = await runOrchestrationPreflight(preflightInput());

    expect(result.status).toBe('READY');
    expect(result.maintenance.status).toBe('ADOPTED');
    expect(result.maintenance.adoption_kind).toBe('maintenance_range');
    expect(result.maintenance.commit_count).toBe(2);
    expect((await readState(paths)).authorized_head_sha).toBe(adopted);
    expect((await readMaintenanceRecord(paths, adopted))?.reason).toBe(AUTO_MAINTENANCE_REASON);
  });

  it('faixa acima do limite bloqueia sem adotar nada', async () => {
    for (let index = 0; index <= AUTO_MAINTENANCE_MAX_COMMITS; index += 1) {
      await createCommit(`docs/nota-${index}.md`, `${index}\n`, `manutenção ${index}`);
    }

    const result = await runOrchestrationPreflight(preflightInput());

    expect(result.status).toBe('BLOCKED');
    expect(result.blocker).toBe('MAINTENANCE_BLOCKED');
    expect(result.maintenance.status).toBe('BLOCKED');
    expect(result.reason).toMatch(
      new RegExp(`excedem o limite automático de ${AUTO_MAINTENANCE_MAX_COMMITS}`),
    );
    expect(result.recover).toBeNull();
    expect(result.next).toBeNull();
    expect(validationCalls).toEqual([]);
    expect(await maintenanceRecordCount()).toBe(0);
    expect((await readState(paths)).authorized_head_sha).toBe(baseline);
  });

  it('commit que toca dev/plan.yaml bloqueia: extensão de plano nunca é automática', async () => {
    await createCommit(
      'dev/plan.yaml',
      [
        'schema_version: 1',
        'tasks:',
        '  - id: T1',
        '    title: primeira tarefa',
        '    objective: criar src/one.txt',
        "    acceptance: ['arquivo criado']",
        '    validation:',
        "      - argv: ['true']",
        '        timeout_seconds: 30',
        '  - id: T2',
        '    title: segunda tarefa',
        '    blocked_by: [T1]',
        '    objective: criar src/two.txt',
        "    acceptance: ['arquivo criado']",
        '    validation:',
        "      - argv: ['true']",
        '        timeout_seconds: 30',
        '  - id: T3',
        '    title: tarefa nova',
        '    blocked_by: [T2]',
        '    objective: estender o plano',
        "    acceptance: ['arquivo criado']",
        '    validation:',
        "      - argv: ['true']",
        '        timeout_seconds: 30',
        '',
      ].join('\n'),
      'extensão de plano',
    );

    const result = await runOrchestrationPreflight(preflightInput());

    expect(result.status).toBe('BLOCKED');
    expect(result.blocker).toBe('MAINTENANCE_BLOCKED');
    expect(result.reason).toMatch(/dev\/plan\.yaml/);
    expect(await maintenanceRecordCount()).toBe(0);
    expect((await readState(paths)).authorized_head_sha).toBe(baseline);
  });

  it('commit fora da allowlist bloqueia', async () => {
    await createCommit('src/produto.ts', 'export const x = 1;\n', 'código de produto');

    const result = await runOrchestrationPreflight(preflightInput());

    expect(result.status).toBe('BLOCKED');
    expect(result.blocker).toBe('MAINTENANCE_BLOCKED');
    expect(result.reason).toMatch(/fora do escopo de manutenção: src\/produto\.ts/);
    expect(await maintenanceRecordCount()).toBe(0);
  });

  it('working tree suja com manutenção pendente bloqueia antes de validar', async () => {
    await createCommit('docs/nota.md', 'manutenção\n', 'manutenção permitida');
    await writeFile(path.join(sandbox.root, 'residuo.txt'), 'solto\n', 'utf8');

    const result = await runOrchestrationPreflight(preflightInput());

    expect(result.status).toBe('BLOCKED');
    expect(result.blocker).toBe('MAINTENANCE_BLOCKED');
    expect(result.reason).toMatch(/working tree suja/);
    expect(validationCalls).toEqual([]);
    expect(await maintenanceRecordCount()).toBe(0);
  });

  it('tarefa RUNNING bloqueia a adoção automática', async () => {
    await createCommit('docs/nota.md', 'manutenção\n', 'manutenção permitida');
    await writeState(
      paths,
      withTaskState(await readState(paths), 'T1', { status: 'RUNNING', phase: 'EXECUTING' }),
    );

    const result = await runOrchestrationPreflight(preflightInput());

    expect(result.status).toBe('BLOCKED');
    expect(result.reason).toMatch(/RUNNING: T1/);
    expect(await maintenanceRecordCount()).toBe(0);
  });

  it('base autorizada ausente bloqueia em vez de inventar uma', async () => {
    const state = await readState(paths);
    await writeState(paths, { ...state, authorized_head_sha: null });

    const result = await runOrchestrationPreflight(preflightInput());

    expect(result.status).toBe('BLOCKED');
    expect(result.blocker).toBe('MAINTENANCE_BLOCKED');
    expect(result.reason).toMatch(/authorized_head_sha ausente/);
  });

  it('HEAD que não descende da base autorizada bloqueia', async () => {
    // Base autorizada num ramo abandonado da história: não existe cadeia
    // linear entre ela e o HEAD, então não há manutenção a adotar.
    const abandoned = await createCommit('docs/abandonada.md', 'ramo A\n', 'ramo abandonado');
    await runGit(sandbox.root, ['reset', '--hard', baseline]);
    await createCommit('docs/atual.md', 'ramo B\n', 'ramo atual');
    await writeState(paths, { ...(await readState(paths)), authorized_head_sha: abandoned });

    const result = await runOrchestrationPreflight(preflightInput());

    expect(result.status).toBe('BLOCKED');
    expect(result.blocker).toBe('MAINTENANCE_BLOCKED');
    expect(result.reason).toMatch(/não descende do authorized_head_sha/);
  });
});

// ---------------------------------------------------------------------------
// Estágio 2 — recover dry-run
// ---------------------------------------------------------------------------

describe('pre-flight: recover automático em dry-run', () => {
  it('CLEAN segue para o estágio de seleção', async () => {
    const result = await runOrchestrationPreflight(preflightInput());

    expect(result.recover?.status).toBe('CLEAN');
    expect(result.recover?.reconciliation_count).toBe(0);
    expect(result.next?.status).toBe('SELECTED');
  });

  it('reconciliação pendente bloqueia sem escrever o state', async () => {
    // RUNNING/EXECUTING com processo morto: o recover reconciliaria para
    // INFRA_ERROR — e é exatamente por isso que um humano precisa entrar.
    await writeState(
      paths,
      withTaskState(await readState(paths), 'T1', {
        status: 'RUNNING',
        phase: 'EXECUTING',
        process: {
          pid: 999_999,
          pgid: 999_999,
          started_at: '2026-08-12T12:00:00.000Z',
          proc_start_ticks: 1,
          command_sha256: 'a'.repeat(64),
        },
      }),
    );

    const result = await runOrchestrationPreflight(preflightInput());

    expect(result.status).toBe('BLOCKED');
    expect(result.blocker).toBe('RECOVERY_ATTENTION');
    expect(result.recover?.status).toBe('ATTENTION');
    expect(result.recover?.reconciliation_count).toBeGreaterThan(0);
    expect(result.next).toBeNull();
    // Dry-run de verdade: o state continua como estava.
    expect((await readState(paths)).tasks[0]?.status).toBe('RUNNING');
  });

  it('plano alterado bloqueia', async () => {
    await writeFile(
      paths.planFile,
      [
        'schema_version: 1',
        'tasks:',
        '  - id: T1',
        '    title: primeira tarefa',
        '    objective: objetivo diferente do que o state registrou',
        "    acceptance: ['arquivo criado']",
        '    validation:',
        "      - argv: ['true']",
        '        timeout_seconds: 30',
        '',
      ].join('\n'),
      'utf8',
    );
    const changed = await loadPlan(paths.planFile);

    const result = await runOrchestrationPreflight(preflightInput({ loaded: changed }));

    expect(result.status).toBe('BLOCKED');
    expect(result.blocker).toBe('RECOVERY_ATTENTION');
    expect(result.recover?.plan_changed).toBe(true);
    expect(result.reason).toMatch(/dev\/plan\.yaml mudou/);
    expect(result.next).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Estágio 3 — readiness (somente leitura)
// ---------------------------------------------------------------------------

describe('pre-flight: readiness', () => {
  it('SELECTED e pronta libera a orquestração, sem persistir packet', async () => {
    const result = await runOrchestrationPreflight(preflightInput());

    expect(result.status).toBe('READY');
    expect(result.next).toMatchObject({
      status: 'SELECTED',
      task_id: 'T1',
      attempt: 1,
      attempt_kind: 'FIRST_PASS',
      ready_to_launch: true,
    });
    expect(result.next?.base_sha).toBe(baseline);
    // Inspeção, não preparação: quem persiste packet é o loop.
    expect(await packetCount()).toBe(0);
  });

  it('ALL_DONE encerra sem provider e sem bloqueio', async () => {
    let state = await readState(paths);
    for (const id of ['T1', 'T2']) {
      state = withTaskState(state, id, {
        status: 'PASS',
        accepted_commit: baseline,
        candidate_commit: baseline,
        finished_at: '2026-08-12T12:00:00.000Z',
      });
    }
    await writeState(paths, { ...state, authorized_head_sha: baseline });

    const result = await runOrchestrationPreflight(preflightInput());

    expect(result.status).toBe('ALL_DONE');
    expect(result.blocker).toBeNull();
    expect(result.next?.status).toBe('ALL_DONE');
    expect(result.next?.ready_to_launch).toBe(false);
  });

  it('tarefa em status bloqueante para o fluxo antes de qualquer launch', async () => {
    await writeState(
      paths,
      withTaskState(await readState(paths), 'T1', {
        status: 'FAIL',
        diagnostics: 'validação oficial recusou',
      }),
    );

    const result = await runOrchestrationPreflight(preflightInput());

    expect(result.status).toBe('BLOCKED');
    expect(result.blocker).toBe('SELECTION_BLOCKED');
    expect(result.next?.status).toBe('HALTED');
    expect(result.next?.ready_to_launch).toBe(false);
    expect(await packetCount()).toBe(0);
  });

  it('árvore suja sem manutenção pendente bloqueia no readiness', async () => {
    await writeFile(path.join(sandbox.root, 'residuo.txt'), 'não commitado\n', 'utf8');

    const result = await runOrchestrationPreflight(preflightInput());

    expect(result.status).toBe('BLOCKED');
    expect(result.blocker).toBe('DIRTY_WORKTREE');
    expect(result.maintenance.status).toBe('NOOP');
    expect(result.recover?.status).toBe('CLEAN');
    expect(result.next?.ready_to_launch).toBe(false);
    expect(result.reason).toMatch(/working tree suja/);
  });

  it('base divergente nunca chega a ready_to_launch', async () => {
    // Commit externo: a divergência é recusada já na maintenance, e o estágio
    // de readiness — que é quem reporta BASE_DIVERGED — nem roda.
    await createCommit('externo.txt', 'trabalho externo\n', 'commit manual');

    const result = await runOrchestrationPreflight(preflightInput());

    expect(result.status).toBe('BLOCKED');
    expect(result.next).toBeNull();
    expect(await packetCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integração com o dev-orchestrate
// ---------------------------------------------------------------------------

describe('dev-orchestrate com pre-flight', () => {
  it('pre-flight bloqueado: exit 9, zero iteração, zero attempt, nenhum provider', async () => {
    await createCommit('src/produto.ts', 'export const x = 1;\n', 'código de produto');

    const result = await orchestrate('success');
    expect(result.exitCode).toBe(9);

    const output = JSON.parse(result.stdout) as {
      stopped_by: string;
      iteration_count: number;
      iterations: unknown[];
      total_api_equivalent_usd: number | null;
      preflight: { status: string; blocker: string };
    };
    expect(output.stopped_by).toBe('PREFLIGHT_BLOCKED');
    expect(output.preflight.status).toBe('BLOCKED');
    expect(output.preflight.blocker).toBe('MAINTENANCE_BLOCKED');
    expect(output.iteration_count).toBe(0);
    expect(output.iterations).toEqual([]);
    expect(output.total_api_equivalent_usd).toBeNull();

    // Nenhum provider lançado, nenhum attempt consumido, nenhum status mexido.
    expect(await readLaunchRecord(paths, 'T1')).toBeNull();
    const state = await readState(paths);
    expect(state.tasks.map((task) => task.status)).toEqual(['READY', 'READY']);
    expect(state.tasks.every((task) => task.attempts === 0)).toBe(true);
    expect(await packetCount()).toBe(0);
  }, 60_000);

  it('saída padrão traz o bloco preflight compacto', async () => {
    const result = await orchestrate('success', ['--max-iterations', '1']);

    const preflight = (JSON.parse(result.stdout) as { preflight: Record<string, unknown> })
      .preflight;
    expect(Object.keys(preflight).sort()).toEqual(['maintenance', 'next', 'recover', 'status']);
    expect(preflight['status']).toBe('READY');
    expect(preflight['maintenance']).toEqual({ status: 'NOOP', commit_count: 0 });
    expect(preflight['recover']).toEqual({ status: 'CLEAN', reconciliation_count: 0 });
    expect(preflight['next']).toEqual({
      status: 'SELECTED',
      task_id: 'T1',
      attempt: 1,
      attempt_kind: 'FIRST_PASS',
      ready_to_launch: true,
    });
    // O compacto não despeja o detalhe que só interessa em diagnóstico.
    for (const noise of ['validation_summary', 'reconciliations', 'selection_reason']) {
      expect(result.stdout, noise).not.toContain(noise);
    }
  }, 60_000);

  it('--verbose acrescenta o diagnóstico dos três estágios', async () => {
    const result = await orchestrate('success', ['--max-iterations', '1', '--verbose']);

    const preflight = (JSON.parse(result.stdout) as { preflight: Record<string, unknown> })
      .preflight;
    const maintenance = preflight['maintenance'] as Record<string, unknown>;
    const recovery = preflight['recover'] as Record<string, unknown>;
    const next = preflight['next'] as Record<string, unknown>;

    expect(maintenance).toHaveProperty('commits');
    expect(maintenance).toHaveProperty('validation_summary');
    expect(recovery).toHaveProperty('reconciliations');
    expect(recovery).toHaveProperty('head_matches_authorized');
    expect(next).toHaveProperty('selection_reason');
    expect(next).toHaveProperty('progression_base_reason');
    expect(next).toHaveProperty('base_sha');
    expect(next['title']).toBe('primeira tarefa');
    // Verbose ACRESCENTA: o resumo continua com o mesmo significado.
    expect(preflight['status']).toBe('READY');
    expect(next['ready_to_launch']).toBe(true);
  }, 60_000);

  it('fluxo PASS continua funcionando depois do pre-flight', async () => {
    const result = await orchestrate('success');
    expect(result.exitCode, result.stderr).toBe(0);

    const output = JSON.parse(result.stdout) as {
      stopped_by: string;
      preflight: { status: string };
      iterations: { task_id: string; result: string }[];
    };
    expect(output.preflight.status).toBe('READY');
    expect(output.stopped_by).toBe('ALL_DONE');
    expect(output.iterations.map((entry) => entry.result)).toEqual(['PASS', 'PASS']);
  }, 60_000);

  it('pre-flight e loop dividem o mesmo lock: ocupado não inspeciona nem lança', async () => {
    const held = await acquireLock(paths, 'dev-orchestrate');
    try {
      const result = await orchestrate('success');
      expect(result.exitCode).toBe(10);
      expect(result.stderr).toMatch(/harness ocupado/);
      // Nada foi conferido nem preparado fora do lock.
      expect(result.stdout).toBe('');
      expect(await packetCount()).toBe(0);
      expect(await readLaunchRecord(paths, 'T1')).toBeNull();
    } finally {
      await held.release();
    }
  }, 60_000);

  it('--skip-preflight é diagnóstico: omite o bloco e não confere nada', async () => {
    const result = await orchestrate('success', ['--max-iterations', '1', '--skip-preflight']);

    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(output).not.toHaveProperty('preflight');
    expect(output['iteration_count']).toBe(1);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Projeções de saída
// ---------------------------------------------------------------------------

describe('projeção do bloco preflight', () => {
  it('bloqueio mostra código, motivo e estágio que não rodou', async () => {
    await createCommit('src/produto.ts', 'export const x = 1;\n', 'código de produto');
    const result = await runOrchestrationPreflight(preflightInput());

    const summary = summarizePreflight(result);
    expect(summary['status']).toBe('BLOCKED');
    expect(summary['blocker']).toBe('MAINTENANCE_BLOCKED');
    expect(summary['reason']).toMatch(/fora do escopo/);
    expect(summary['recover']).toBeNull();
    expect(summary['next']).toBeNull();
    expect(summary['maintenance']).toMatchObject({ status: 'BLOCKED' });
  });

  it('adoção mostra as duas bases e a contagem de commits', async () => {
    const adopted = await createCommit('docs/nota.md', 'manutenção\n', 'manutenção permitida');
    const result = await runOrchestrationPreflight(preflightInput());

    expect(summarizePreflight(result)['maintenance']).toEqual({
      status: 'ADOPTED',
      previous_authorized_head_sha: baseline,
      authorized_head_sha: adopted,
      commit_count: 1,
    });
    const detail = detailPreflight(result)['maintenance'] as Record<string, unknown>;
    expect(detail['adoption_kind']).toBe('maintenance');
    expect(detail['commits']).toHaveLength(1);
    expect(detail['validation_summary']).toHaveLength(4);
  });
});
