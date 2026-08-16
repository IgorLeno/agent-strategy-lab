/**
 * M67: E2E fake ponta a ponta da infraestrutura experimental —
 * `ExperimentSpec` (congelado) → `runExperimentSchedule` → adapter FAKE →
 * `executeRun` → evidence selada → `evaluateRun` → `scoreRun`
 * (qualification) → `readTrialHistory`/`derivePerformance` (M46) →
 * `compareTaskPerformance` (M66). Tudo com fixtures e o adapter fake — nenhum
 * provider real, nenhum dos 12 slots reais do piloto (M68) e nenhuma
 * conclusão comparativa real: os dois arms só diferem porque o grader do
 * teste foi programado para isso, não porque um modelo real desempenhou
 * melhor que o outro.
 *
 * Mesma fronteira operacional dos outros slices de `test/e2e/`: nada de
 * atalho em memória entre etapas que na vida real leem só do disco.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { FAKE_ADAPTER_IDENTITY } from '../../src/adapters/index.js';
import { decideExecutionAuthorization } from '../../src/billing/index.js';
import { evaluateRun } from '../../src/cli/evaluate.js';
import { executeRun } from '../../src/cli/run-execute.js';
import { prepareRun } from '../../src/cli/run-prepare.js';
import { scoreRun } from '../../src/cli/score.js';
import { runTaskCreate } from '../../src/cli/task-create.js';
import { ExecutionStatus, QualificationStatus } from '../../src/core/enums.js';
import type { GraderSpec } from '../../src/evaluator/index.js';
import {
  freezeExperimentSpec,
  materializeSlotOrder,
  runExperimentSchedule,
  type PlannedSlot,
} from '../../src/experiment/index.js';
import {
  derivePerformance,
  readTrialHistory,
  type EvaluationSelection,
  type EvaluationSelectionEntry,
} from '../../src/performance/index.js';
import { compareTaskPerformance, type TaskPerformanceObservation } from '../../src/reporting/index.js';
import { EvaluationPlan, TaskSpec, type EnvironmentProfile, type Trial } from '../../src/schemas/index.js';
import { verifyRunIntegrity } from '../../src/storage/index.js';

const execFileAsync = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_SYSTEM: os.devNull,
  GIT_TERMINAL_PROMPT: '0',
};

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-e2e-experiment-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd, env: GIT_ENV });
  return stdout;
}

interface FixtureRepo {
  readonly repoPath: string;
  readonly baseSha: string;
}

/** Mesmo repo-alvo mínimo que os outros slices de `test/e2e/` usam. */
async function fixtureRepo(): Promise<FixtureRepo> {
  const repoPath = path.join(await temporaryRoot(), 'target');
  await mkdir(repoPath, { recursive: true });
  await execFileAsync('git', ['init', '--quiet', '--initial-branch=main', repoPath], { env: GIT_ENV });
  await git(repoPath, ['config', 'user.email', 'lab@example.com']);
  await git(repoPath, ['config', 'user.name', 'Lab']);
  await writeFile(path.join(repoPath, 'README.md'), 'base\n', 'utf8');
  await git(repoPath, ['add', '--', 'README.md']);
  await git(repoPath, ['commit', '--quiet', '-m', 'base']);

  return { repoPath, baseSha: (await git(repoPath, ['rev-parse', 'HEAD'])).trim() };
}

function fixtureTaskInput(): Record<string, unknown> {
  return {
    id: 'm67-fixture-task',
    description: 'Tarefa fixture do E2E experimental (M67) — nunca roda contra um provider real.',
    visible_criteria: ['Critério único, satisfeito pelo fake agent.'],
    task_class: 'feature',
    difficulty: 'medium',
    stack: ['typescript'],
    public_graders: ['typecheck'],
    budgets: {
      duration_ms: { expected: 120_000, maximum: 300_000 },
      tokens: { expected: 128, maximum: 1_000 },
      changed_files: { expected: 1, maximum: 4 },
    },
    hidden_graders: ['patch-scope'],
    rubric: { 'patch-scope': 'o patch fica dentro do escopo esperado' },
    weights: { 'patch-scope': 1 },
  };
}

const environmentProfile: EnvironmentProfile = {
  id: 'm67-controlled-clean-room',
  mode: 'controlled',
  env_allowlist: ['PATH', 'LANG'],
  home: 'sanitized',
  instruction_files: [],
  plugins: [],
  skills: [],
  mcp_servers: [],
};

function nodeArgv(source: string): string[] {
  return [process.execPath, '-e', source];
}

const PASS: GraderSpec = { argv: nodeArgv('process.exit(0)'), required: true, version: 'v1' };
const FAIL: GraderSpec = { argv: nodeArgv('process.exit(1)'), required: true, version: 'v1' };

const ARM_CONTROL_ID = 'fake-arm-control';
const ARM_VARIANT_ID = 'fake-arm-variant';

/**
 * `Trial.id` exige `identifier` (alfanumérico + `-`/`_`), mas `slot_id`
 * (runner/M65) usa `:` como separador — sanitiza para o trial/run subjacente,
 * preservando unicidade determinística por task×arm×repetition.
 */
function trialIdForSlot(slot: PlannedSlot): string {
  return (slot.retry_of ?? slot.slot_id).replace(/:/g, '-');
}

describe('E2E fake — ExperimentSpec → adapter fake → executeRun → evidence → evaluation → qualification → performance → compare', () => {
  it('ponta a ponta com fixtures determinísticas: zero slot real, zero conclusão comparativa real', async () => {
    const source = await fixtureRepo();
    const labRoot = await temporaryRoot();
    const dataDir = path.join(labRoot, 'data');
    const runsDir = path.join(dataDir, 'runs');

    // 1. task pública + EvaluationPlan privado, mesmo par que qualquer outro slice.
    const inputPath = path.join(labRoot, 'task-input.json');
    await writeFile(inputPath, JSON.stringify(fixtureTaskInput()), 'utf8');
    const taskCreateResult = await runTaskCreate({ input: inputPath, labRoot });
    const taskSpec = TaskSpec.parse(JSON.parse(await readFile(taskCreateResult.taskSpecPath, 'utf8')));
    const evaluationPlan = EvaluationPlan.parse(
      JSON.parse(await readFile(taskCreateResult.evaluationPlanPath, 'utf8')),
    );

    // 2. ExperimentSpec congelado: 2 arms × 1 task × 2 repetitions = 4 slots —
    // nem perto dos 12 slots reais do piloto (M68). Os dois arms usam o
    // adapter fake (FAKE-ONLY): nenhuma cli real entra em jogo.
    const frozen = freezeExperimentSpec({
      schema_version: 1,
      id: 'm67-fake-e2e',
      arms: [
        {
          id: ARM_CONTROL_ID,
          agent_profile: {
            id: ARM_CONTROL_ID,
            cli: 'fake',
            cli_version: '1.0.0',
            model: 'fake-model',
            flags: ['--variant', 'control'],
          },
        },
        {
          id: ARM_VARIANT_ID,
          agent_profile: {
            id: ARM_VARIANT_ID,
            cli: 'fake',
            cli_version: '1.0.0',
            model: 'fake-model',
            flags: ['--variant', 'variant'],
          },
        },
      ],
      tasks: [taskSpec],
      repetitions_per_arm_task: 2,
      ordering: { scheme: 'seeded_interleaved_counterbalanced' as const, seed: 'm67-fake-e2e-seed' },
      strategy: {
        name: 'direct',
        version: 1,
        prompt: 'Implemente diretamente a tarefa fornecida e verifique o resultado.',
      },
      environment_profile: environmentProfile,
      billing_policy: {
        billing_mode: 'NO_CHARGE' as const,
        max_incremental_charge_usd: null,
        quota_stop_threshold_pct: 80,
      },
      planned_slot_count: 4,
    });
    expect(frozen.spec.planned_slot_count).toBe(4);

    // 3. grader determinístico por slot: só a segunda repetição do arm variant
    // falha — decidido pelo TESTE (fixture controlada), não por nenhuma
    // capacidade real de modelo.
    function graderFor(slot: PlannedSlot): GraderSpec {
      return slot.arm_id === ARM_VARIANT_ID && slot.repetition_index === 1 ? FAIL : PASS;
    }

    // 4. executa um slot inteiro: prepara, roda o adapter fake, avalia, pontua.
    const trialRuns = new Map<string, { runId: string; evaluationId: string; scoreId: string }[]>();

    async function executeSlot(slot: PlannedSlot): Promise<ExecutionStatus> {
      const arm = frozen.spec.arms.find((candidate) => candidate.id === slot.arm_id);
      if (arm === undefined) throw new Error(`arm desconhecido: ${slot.arm_id}`);
      const task = frozen.spec.tasks.find((candidate) => candidate.id === slot.task_id);
      if (task === undefined) throw new Error(`task desconhecida: ${slot.task_id}`);

      const trialId = trialIdForSlot(slot);
      const trial: Trial = {
        id: trialId,
        task,
        agent: arm.agent_profile,
        strategy: frozen.spec.strategy,
        environment: frozen.spec.environment_profile,
        status: 'PLANNED',
      };

      const prepared = await prepareRun({
        trial,
        baseSha: source.baseSha,
        budgets: task.budgets,
        timeoutMs: 60_000,
        sourceRepo: source.repoPath,
        adapter: FAKE_ADAPTER_IDENTITY,
        labRoot,
        parentDir: await temporaryRoot(),
      });

      // o fake agent "trabalha": muda um arquivo já rastreado no clone.
      await writeFile(path.join(prepared.clone.clonePath, 'README.md'), `base\n${slot.slot_id}\n`, 'utf8');

      const executed = await executeRun({ prepared });

      const evaluationId = `ev-${prepared.runId}`;
      const scoreId = `sc-${prepared.runId}`;
      await evaluateRun({
        runDir: prepared.runDir,
        evaluationId,
        sourceRepo: source.repoPath,
        evaluationPlan,
        graders: { 'patch-scope': graderFor(slot) },
        evaluatorEnvironment: environmentProfile,
        parentDir: await temporaryRoot(),
      });
      await scoreRun({ runDir: prepared.runDir, evaluationId, scoreId });

      const entries = trialRuns.get(trialId) ?? [];
      entries.push({ runId: prepared.runId, evaluationId, scoreId });
      trialRuns.set(trialId, entries);

      return executed.record.status;
    }

    // 5. billing guard consultada antes de cada launch (M54/M62): FIXTURE
    // sempre ALLOW — nenhuma reimplementação da guard aqui.
    const result = await runExperimentSchedule({
      frozen,
      executeSlot,
      authorizeSlot: () => decideExecutionAuthorization('FIXTURE'),
    });

    // acceptance: E2E fake ponta a ponta PASS.
    expect(result.stoppedByBillingGuard).toBe(false);
    expect(result.remainingSlots).toHaveLength(0);
    expect(result.launches).toHaveLength(4);
    expect(result.launches.every((launch) => launch.status === ExecutionStatus.COMPLETED)).toBe(true);

    // acceptance: evidence válida — todo run selado passa a verificação de integridade.
    for (const entries of trialRuns.values()) {
      for (const entry of entries) {
        const integrity = await verifyRunIntegrity(path.join(runsDir, entry.runId));
        expect(integrity.ok).toBe(true);
        expect(integrity.violations).toEqual([]);
      }
    }

    // 6. performance por trial (M46), lendo só o que está selado em disco —
    // conecta evaluation/qualification já produzidas ao TaskPerformanceRecord.
    const observations: TaskPerformanceObservation[] = [];
    for (const slot of materializeSlotOrder(frozen)) {
      const trialId = trialIdForSlot(slot);
      const entries = trialRuns.get(trialId);
      expect(entries).toBeDefined();

      const selectionEntries: Record<string, EvaluationSelectionEntry> = {};
      for (const entry of entries!) {
        selectionEntries[entry.runId] = { evaluation_id: entry.evaluationId, score_id: entry.scoreId };
      }
      const selection: EvaluationSelection = selectionEntries;

      const { history: attemptHistory, runs, excludedRuns } = await readTrialHistory(
        runsDir,
        trialId,
        selection,
      );
      expect(excludedRuns).toEqual([]);
      expect(runs).toHaveLength(1);

      observations.push({
        arm_id: slot.arm_id,
        qualification_status: runs[0]!.performance.quality.qualification_status,
        performance: derivePerformance(attemptHistory),
      });
    }

    // acceptance: evaluation/qualification/performance/compare conectados —
    // todo trial chegou QUALIFIED (métricas obrigatórias presentes), com
    // final_pass refletindo o outcome real do grader daquele slot.
    expect(
      observations.every((observation) => observation.qualification_status === QualificationStatus.QUALIFIED),
    ).toBe(true);

    const passByArm = new Map<string, boolean[]>();
    for (const observation of observations) {
      const passes = passByArm.get(observation.arm_id) ?? [];
      passes.push(observation.performance.success.final_pass === true);
      passByArm.set(observation.arm_id, passes);
    }
    expect(passByArm.get(ARM_CONTROL_ID)).toEqual([true, true]);
    expect(passByArm.get(ARM_VARIANT_ID)?.slice().sort()).toEqual([false, true]);

    // 7. compare (M66) — só QUALIFIED entra, nada além do que já está selado em disco.
    const compareResult = compareTaskPerformance(observations);

    expect(compareResult.per_task).toHaveLength(1);
    const taskResult = compareResult.per_task[0]!;
    expect(taskResult.task_id).toBe(taskSpec.id);
    expect(taskResult.arms.map((arm) => arm.arm_id).sort()).toEqual(
      [ARM_CONTROL_ID, ARM_VARIANT_ID].sort(),
    );

    const controlArm = taskResult.arms.find((arm) => arm.arm_id === ARM_CONTROL_ID)!;
    const variantArm = taskResult.arms.find((arm) => arm.arm_id === ARM_VARIANT_ID)!;
    expect(controlArm.qualified_n).toBe(2);
    expect(controlArm.excluded_non_qualified).toBe(0);
    expect(controlArm.pass_rate).toBe(1);
    expect(controlArm.insufficient_n).toBe(false);
    expect(variantArm.qualified_n).toBe(2);
    expect(variantArm.pass_rate).toBe(0.5);
    expect(variantArm.insufficient_n).toBe(false);

    // acceptance: nenhuma conclusão comparativa real — o resultado é
    // matéria-prima (contagem bruta QUALIFIED), nunca inferência, vencedor ou
    // capability matrix; a diferença observada aqui vem do grader fixo do
    // teste, não de nenhuma medição de capacidade real de modelo.
    for (const arm of compareResult.aggregate) {
      expect(arm).not.toHaveProperty('winner');
      expect(arm).not.toHaveProperty('confidence_interval');
    }
    expect(compareResult).not.toHaveProperty('winner');
    expect(compareResult).not.toHaveProperty('capability_matrix');

    // acceptance: zero necessidade de 12 slots reais.
    expect(frozen.spec.planned_slot_count).toBeLessThan(12);
    expect(result.launches.length).toBeLessThan(12);
  });

  // acceptance: real smoke opcional e bloqueado por default — um arm
  // REAL_INFERENCE sem autorização explícita bloqueia o launch imediatamente,
  // sem rodar nenhum slot. A guard em si já é provada em
  // test/billing/guard.test.ts e test/cli/run.test.ts; este teste só confirma
  // que o scheduling do experimento (M65) respeita o bloqueio antes de
  // lançar qualquer slot real, sem autorização humana explícita presente
  // nesta tarefa.
  it('bloqueia por default um arm REAL_INFERENCE sem autorização explícita, sem lançar nenhum slot', async () => {
    const frozen = freezeExperimentSpec({
      schema_version: 1,
      id: 'm67-real-blocked-by-default',
      arms: [
        {
          id: 'claude-would-be-real',
          agent_profile: {
            id: 'claude-would-be-real',
            cli: 'claude',
            cli_version: '2.1.223',
            model: 'claude-sonnet-5',
            flags: [],
          },
        },
        {
          id: ARM_CONTROL_ID,
          agent_profile: { id: ARM_CONTROL_ID, cli: 'fake', cli_version: '1.0.0', model: 'fake-model', flags: [] },
        },
      ],
      tasks: [
        {
          id: 'm67-blocked-task',
          description: 'Tarefa fixture só para provar o bloqueio de billing por default.',
          visible_criteria: ['Critério único.'],
          task_class: 'feature',
          difficulty: 'medium',
          stack: ['typescript'],
          public_graders: ['typecheck'],
          budgets: {
            duration_ms: { expected: 1_000, maximum: 2_000 },
            tokens: { expected: 100, maximum: 200 },
            changed_files: { expected: 1, maximum: 2 },
          },
        },
      ],
      repetitions_per_arm_task: 1,
      ordering: { scheme: 'seeded_interleaved_counterbalanced' as const, seed: 'm67-block-seed' },
      strategy: { name: 'direct', version: 1, prompt: 'Implemente diretamente.' },
      environment_profile: environmentProfile,
      billing_policy: {
        billing_mode: 'API' as const,
        max_incremental_charge_usd: null,
        quota_stop_threshold_pct: 80,
      },
      planned_slot_count: 2,
    });

    const executed: string[] = [];
    const result = await runExperimentSchedule({
      frozen,
      executeSlot: (slot) => {
        executed.push(slot.slot_id);
        return ExecutionStatus.COMPLETED;
      },
      authorizeSlot: (slot) => {
        const arm = frozen.spec.arms.find((candidate) => candidate.id === slot.arm_id)!;
        const executionKind = arm.agent_profile.cli === 'fake' ? 'FIXTURE' : 'REAL_INFERENCE';
        // Sem `evidence`: nenhuma autorização humana explícita foi fornecida
        // a esta tarefa — `decideExecutionAuthorization` bloqueia por default.
        return decideExecutionAuthorization(executionKind);
      },
    });

    expect(result.stoppedByBillingGuard).toBe(true);
    expect(result.blockedDecision?.decision).toBe('BLOCK');
    expect(executed).toHaveLength(0);
  });
});
