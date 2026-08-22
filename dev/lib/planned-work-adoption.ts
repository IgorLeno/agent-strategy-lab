import { canonicalSha256 } from './canonical.js';
import { runValidation, toValidationResult } from './exec.js';
import {
  changedFiles,
  gitOrThrow,
  headSha,
  isAncestor,
  isWorkingTreeClean,
  parentShas,
} from './git.js';
import {
  adoptionValidationCommands,
  type MaintenanceValidationRunner,
} from './maintenance.js';
import type { HarnessPaths } from './paths.js';
import { loadPlan, parsePlan, type LoadedPlan } from './plan.js';
import {
  assertAppendOnlyPlanExtension,
  planSourceAtCommit,
  PlanExtensionContractError,
} from './plan-extension-contract.js';
import {
  plannedWorkAdoptionEvidenceDir,
  plannedWorkAdoptionPath,
  readPlannedWorkAdoption,
  writePlannedWorkAdoption,
} from './records.js';
import {
  PlannedWorkAdoptionError,
  verifyPlannedWorkAdoptionRecord,
} from './planned-work-adoption-contract.js';
import { recover, verifyCloseBundle } from './recover.js';
import {
  DEV_SCHEMA_VERSION,
  PlannedWorkAdoptionRecord,
  type DevelopmentState,
  type PlanTask,
  type PlannedWorkAdoptionTask,
  type PlannedWorkRangeCommit,
  type ValidationResult,
} from './schemas.js';
import { readState, writeState } from './state.js';
import { runValidationWithEvidence } from './validation-evidence.js';
import { withCommitValidationCwd, withDetachedWorktree } from './worktree.js';

export {
  PlannedWorkAdoptionError,
  loadAdoptedTaskEvidence,
  readAllPlannedWorkAdoptions,
  reconcilePlannedWorkAdoptions,
  verifyPlannedWorkAdoptionRecord,
  type AdoptedTaskEvidence,
} from './planned-work-adoption-contract.js';

/**
 * Teto da caminhada pela faixa. Não é política: é proteção contra percorrer o
 * histórico inteiro quando o target não descende da base autorizada por um
 * caminho curto. A política de verdade é o accounting — todo commit da faixa
 * precisa de um papel explícito.
 */
const MAXIMUM_RANGE_COMMITS = 200;

export interface PlannedWorkAdoptionInput {
  readonly paths: HarnessPaths;
  readonly target: string;
  /**
   * Mapping EXPLÍCITO tarefa → commit. Mensagem de commit pode sugerir, mas
   * nunca decide: uma adoção que inferisse o mapping sozinha estaria afirmando
   * autoria sem prova.
   */
  readonly taskCommits: ReadonlyMap<string, string>;
  /**
   * Commits da faixa que NÃO implementam tarefa planejada e não são a extensão
   * de plano — tipicamente a manutenção de reconciliação que trouxe o runtime
   * de volta. Precisam ser nomeados: nada entra na faixa implicitamente.
   */
  readonly maintenanceCommits: readonly string[];
  readonly reason: string;
  readonly dryRun?: boolean;
  /** Injetável nos testes; o default roda os gates reais sobre o target. */
  readonly rangeValidationRunner?: MaintenanceValidationRunner;
  readonly now?: () => string;
}

export interface PlannedWorkAdoptionPreview {
  readonly previousAuthorizedHeadSha: string;
  readonly targetSha: string;
  readonly planExtensionCommitSha: string;
  readonly previousPlanSha256: string;
  readonly adoptedPlanSha256: string;
  readonly planAddedTaskIds: readonly string[];
  readonly commits: readonly PlannedWorkRangeCommit[];
  readonly tasks: readonly {
    readonly taskId: string;
    readonly acceptedCommit: string;
    readonly planTaskFingerprintSha256: string;
    readonly committedAt: string;
    readonly validationArgv: readonly (readonly string[])[];
  }[];
  readonly rangeValidationArgv: readonly (readonly string[])[];
  readonly stateTransitions: readonly {
    readonly taskId: string;
    readonly from: string;
    readonly to: 'PASS';
  }[];
  readonly authorizedHeadTransition: { readonly from: string; readonly to: string };
}

export type PlannedWorkAdoptionResult =
  | {
      readonly status: 'DRY_RUN';
      readonly preview: PlannedWorkAdoptionPreview;
    }
  | {
      readonly status: 'ADOPTED' | 'ALREADY_ADOPTED';
      readonly record: PlannedWorkAdoptionRecord;
      readonly recordPath: string;
      readonly authorizedHeadSha: string;
    };

const defaultRangeValidationRunner: MaintenanceValidationRunner = async (command, cwd) =>
  toValidationResult(await runValidation(command, { cwd }));

async function resolveCommitSha(
  repoRoot: string,
  raw: string,
  label: string,
): Promise<string> {
  const trimmed = raw.trim();
  if (trimmed === '') throw new PlannedWorkAdoptionError(`${label} não pode ser vazio`);
  try {
    return (await gitOrThrow(repoRoot, ['rev-parse', '--verify', `${trimmed}^{commit}`])).trim();
  } catch {
    throw new PlannedWorkAdoptionError(`${label} não existe: ${trimmed}`);
  }
}

/** Committer timestamp do commit, normalizado em UTC — fato do Git, não relógio da adoção. */
async function committerTimestamp(repoRoot: string, sha: string): Promise<string> {
  const raw = (await gitOrThrow(repoRoot, ['show', '-s', '--format=%cI', sha])).trim();
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new PlannedWorkAdoptionError(`committer timestamp ilegível em ${sha}: ${raw}`);
  }
  return parsed.toISOString();
}

interface RangeCommit {
  readonly sha: string;
  readonly parentSha: string;
  readonly changedFiles: readonly string[];
}

/** Cadeia linear da base autorizada até o target, na ordem cronológica. */
async function collectRange(
  repoRoot: string,
  previous: string,
  target: string,
): Promise<RangeCommit[]> {
  const reversed: RangeCommit[] = [];
  let current = target;
  while (current !== previous) {
    if (reversed.length >= MAXIMUM_RANGE_COMMITS) {
      throw new PlannedWorkAdoptionError(
        `faixa excede ${MAXIMUM_RANGE_COMMITS} commits a partir de ${previous}`,
      );
    }
    const parents = await parentShas(repoRoot, current);
    if (parents.length !== 1) {
      throw new PlannedWorkAdoptionError(
        parents.length > 1
          ? `merge commit não permitido na faixa: ${current}`
          : `commit ${current} não alcança a base autorizada`,
      );
    }
    reversed.push({
      sha: current,
      parentSha: parents[0] as string,
      changedFiles: await changedFiles(repoRoot, current),
    });
    current = parents[0] as string;
  }
  if (reversed.length === 0) {
    throw new PlannedWorkAdoptionError('target já é a base autorizada; nada a adotar');
  }
  return reversed.reverse();
}

/**
 * Atribui um papel a CADA commit da faixa a partir do mapping do operador.
 * Qualquer commit sem papel é recusa: um commit não explicado é exatamente o
 * que esta primitive existe para impedir que entre escondido.
 */
function classifyRange(
  range: readonly RangeCommit[],
  planExtensionSha: string,
  taskByCommit: ReadonlyMap<string, string>,
  maintenanceShas: ReadonlySet<string>,
): PlannedWorkRangeCommit[] {
  const unaccounted: string[] = [];
  const classified = range.map((commit) => {
    const base = {
      sha: commit.sha,
      parent_sha: commit.parentSha,
      changed_files: [...commit.changedFiles],
    };
    if (commit.sha === planExtensionSha) {
      return { ...base, role: 'plan_extension' as const };
    }
    const taskId = taskByCommit.get(commit.sha);
    if (taskId !== undefined) {
      return { ...base, role: 'planned_task' as const, task_id: taskId };
    }
    if (maintenanceShas.has(commit.sha)) {
      return { ...base, role: 'unplanned_maintenance' as const };
    }
    unaccounted.push(commit.sha);
    return { ...base, role: 'unplanned_maintenance' as const };
  });
  if (unaccounted.length > 0) {
    throw new PlannedWorkAdoptionError(
      `commits da faixa sem papel declarado: ${unaccounted.join(', ')}`,
    );
  }
  return classified;
}

interface PlanBinding {
  readonly planExtensionCommitSha: string;
  readonly previousPlanSha256: string;
  readonly adoptedPlanSha256: string;
  readonly addedTaskIds: readonly string[];
}

/**
 * Prova, direto do Git, que a faixa contém UMA extensão de plano append-only —
 * e nada mais mexeu em `dev/plan.yaml`. Os arquivos extras que o commit de
 * plano trouxe junto continuam registrados como parte da faixa: eles não são
 * ignorados, só não são o que autoriza as tarefas.
 */
async function bindPlan(
  repoRoot: string,
  previous: string,
  target: string,
  range: readonly RangeCommit[],
): Promise<PlanBinding> {
  const planCommits = range.filter((commit) => commit.changedFiles.includes('dev/plan.yaml'));
  if (planCommits.length === 0) {
    throw new PlannedWorkAdoptionError('a faixa não contém extensão de plano');
  }
  if (planCommits.length > 1) {
    throw new PlannedWorkAdoptionError(
      `a faixa reescreve dev/plan.yaml mais de uma vez: ${planCommits
        .map((commit) => commit.sha)
        .join(', ')}`,
    );
  }
  const previousPlan = parsePlan(await planSourceAtCommit(repoRoot, previous));
  const adoptedPlan = parsePlan(await planSourceAtCommit(repoRoot, target));
  let addedTaskIds: readonly string[];
  try {
    addedTaskIds = assertAppendOnlyPlanExtension(previousPlan.plan, adoptedPlan.plan);
  } catch (error) {
    if (error instanceof PlanExtensionContractError) {
      throw new PlannedWorkAdoptionError(error.message);
    }
    throw error;
  }
  return {
    planExtensionCommitSha: (planCommits[0] as RangeCommit).sha,
    previousPlanSha256: previousPlan.planSha256,
    adoptedPlanSha256: adoptedPlan.planSha256,
    addedTaskIds,
  };
}

/**
 * Elegibilidade de cada tarefa pedida. Nenhuma dessas checagens é sobre a
 * qualidade do trabalho — isso é a revalidação. Estas garantem que a adoção não
 * está reescrevendo história que já tem dono, nem antecipando dependência.
 */
async function assertTasksAdoptable(input: {
  readonly paths: HarnessPaths;
  readonly loaded: LoadedPlan;
  readonly state: DevelopmentState;
  readonly addedTaskIds: readonly string[];
  readonly orderedTaskIds: readonly string[];
  readonly commitIndexByTask: ReadonlyMap<string, number>;
  readonly planExtensionIndex: number;
}): Promise<void> {
  const added = new Set(input.addedTaskIds);
  const adopting = new Set(input.orderedTaskIds);
  for (const taskId of input.orderedTaskIds) {
    const planTask = input.loaded.byId.get(taskId);
    if (!planTask) {
      throw new PlannedWorkAdoptionError(`tarefa ausente no plano atual: ${taskId}`);
    }
    if (!added.has(taskId)) {
      throw new PlannedWorkAdoptionError(
        `${taskId} não foi acrescentada pela extensão de plano desta faixa`,
      );
    }
    const before = input.state.tasks.find((task) => task.id === taskId);
    if (before?.status === 'PASS') {
      throw new PlannedWorkAdoptionError(`${taskId} já estava concluída no state anterior`);
    }
    const bundle = await verifyCloseBundle(input.paths, taskId);
    if (bundle.status === 'VALID') {
      throw new PlannedWorkAdoptionError(
        `${taskId} possui fechamento normal aceito; adoção out-of-band recusada`,
      );
    }
    const index = input.commitIndexByTask.get(taskId) as number;
    if (index < input.planExtensionIndex) {
      throw new PlannedWorkAdoptionError(
        `${taskId}: commit anterior à extensão de plano que declarou a tarefa`,
      );
    }
    for (const dependency of planTask.blocked_by) {
      if (adopting.has(dependency)) {
        const dependencyIndex = input.commitIndexByTask.get(dependency) as number;
        if (dependencyIndex >= index) {
          throw new PlannedWorkAdoptionError(
            `${taskId}: commit não vem depois da dependência adotada ${dependency}`,
          );
        }
        continue;
      }
      const dependencyState = input.state.tasks.find((task) => task.id === dependency);
      if (dependencyState?.status !== 'PASS') {
        throw new PlannedWorkAdoptionError(
          `${taskId}: dependência ${dependency} não está PASS nem entra nesta adoção`,
        );
      }
    }
  }
}

/**
 * Revalidação independente: os comandos que a PRÓPRIA tarefa declara, rodados
 * sobre os bytes do commit mapeado, em worktree detachado. O relatório do
 * operador não conta como evidência — este passo é a evidência.
 */
async function revalidateTask(input: {
  readonly paths: HarnessPaths;
  readonly targetSha: string;
  readonly planTask: PlanTask;
  readonly commitSha: string;
}): Promise<{
  readonly results: ValidationResult[];
  readonly evidence: PlannedWorkAdoptionTask['validation_evidence'];
}> {
  const directory = plannedWorkAdoptionEvidenceDir(
    input.paths,
    input.targetSha,
    input.planTask.id,
  );
  return withDetachedWorktree(input.paths.repoRoot, input.commitSha, async (cwd) => {
    const results: ValidationResult[] = [];
    const evidence: PlannedWorkAdoptionTask['validation_evidence'][number][] = [];
    for (const command of input.planTask.validation) {
      const execution = await runValidationWithEvidence({
        paths: input.paths,
        directory,
        command,
        cwd,
      });
      results.push(execution.result);
      evidence.push(execution.evidence);
      if (execution.result.exit_code !== 0 || execution.result.timed_out) {
        throw new PlannedWorkAdoptionError(
          `${input.planTask.id}: revalidação falhou em ${command.argv.join(' ')}`,
        );
      }
    }
    return { results, evidence };
  });
}

async function applyAdoptedState(paths: HarnessPaths, target: string): Promise<void> {
  const loaded = await loadPlan(paths.planFile);
  const recovery = await recover(paths, loaded);
  await writeState(paths, recovery.state);
  const after = await readState(paths);
  if (after.authorized_head_sha !== target) {
    throw new PlannedWorkAdoptionError(
      `authorized_head_sha não avançou para o target (${after.authorized_head_sha} ≠ ${target})`,
    );
  }
  if (after.plan_sha256 !== loaded.planSha256) {
    throw new PlannedWorkAdoptionError('plan_sha256 não corresponde ao plano adotado');
  }
}

export async function adoptPlannedWorkRange(
  input: PlannedWorkAdoptionInput,
): Promise<PlannedWorkAdoptionResult> {
  const { paths } = input;
  const reason = input.reason.trim();
  if (reason === '') throw new PlannedWorkAdoptionError('--reason é obrigatório');
  if (input.taskCommits.size === 0) {
    throw new PlannedWorkAdoptionError('--tasks é obrigatório: adoção vazia não existe');
  }
  if (!(await isWorkingTreeClean(paths.repoRoot))) {
    throw new PlannedWorkAdoptionError('working tree suja; adoção recusada');
  }

  const state = await readState(paths);
  const running = state.tasks.find((task) => task.status === 'RUNNING');
  if (running) throw new PlannedWorkAdoptionError(`tarefa RUNNING: ${running.id}`);
  const previous = state.authorized_head_sha;
  if (previous === null) throw new PlannedWorkAdoptionError('authorized_head_sha ausente');

  const target = await resolveCommitSha(paths.repoRoot, input.target, '--target');
  const head = await headSha(paths.repoRoot);
  if (!(await isAncestor(paths.repoRoot, target, head))) {
    throw new PlannedWorkAdoptionError('target não é ancestral do HEAD');
  }

  const existing = await readPlannedWorkAdoption(paths, target);
  if (existing) {
    // Crash entre o record e o state: a evidência imutável vence. Nada é
    // revalidado nem reescrito; só a atualização pendente é concluída.
    await verifyPlannedWorkAdoptionRecord(paths, existing);
    if (existing.previous_authorized_head_sha !== previous && previous !== target) {
      throw new PlannedWorkAdoptionError('adoção existente não começa no authorized_head_sha');
    }
    await applyAdoptedState(paths, target);
    return {
      status: 'ALREADY_ADOPTED',
      record: existing,
      recordPath: plannedWorkAdoptionPath(paths, target),
      authorizedHeadSha: target,
    };
  }

  if (previous === target) {
    throw new PlannedWorkAdoptionError('target já é a base autorizada; nada a adotar');
  }
  if (!(await isAncestor(paths.repoRoot, previous, target))) {
    throw new PlannedWorkAdoptionError('target não descende do authorized_head_sha');
  }

  const loaded = await loadPlan(paths.planFile);
  const range = await collectRange(paths.repoRoot, previous, target);
  const planBinding = await bindPlan(paths.repoRoot, previous, target, range);
  if (loaded.planSha256 !== planBinding.adoptedPlanSha256) {
    throw new PlannedWorkAdoptionError('dev/plan.yaml atual não corresponde ao plano do target');
  }

  const rangeShas = new Set(range.map((commit) => commit.sha));
  const taskByCommit = new Map<string, string>();
  for (const [taskId, rawCommit] of input.taskCommits) {
    // Antes do accounting da faixa: um id que não existe no plano é erro de
    // digitação do operador, e apontar para ele é mais útil do que reclamar do
    // commit que ficou órfão por consequência.
    if (!loaded.byId.has(taskId)) {
      throw new PlannedWorkAdoptionError(`tarefa ausente no plano atual: ${taskId}`);
    }
    const sha = await resolveCommitSha(paths.repoRoot, rawCommit, `commit de ${taskId}`);
    if (!rangeShas.has(sha)) {
      throw new PlannedWorkAdoptionError(`commit de ${taskId} está fora da faixa: ${sha}`);
    }
    if (sha === planBinding.planExtensionCommitSha) {
      throw new PlannedWorkAdoptionError(
        `${taskId} mapeada para o commit de extensão de plano; ele não implementa tarefa`,
      );
    }
    const owner = taskByCommit.get(sha);
    if (owner !== undefined) {
      throw new PlannedWorkAdoptionError(`commit ${sha} mapeado por ${owner} e ${taskId}`);
    }
    taskByCommit.set(sha, taskId);
  }

  const maintenanceShas = new Set<string>();
  for (const raw of input.maintenanceCommits) {
    const sha = await resolveCommitSha(paths.repoRoot, raw, '--maintenance-commits');
    if (!rangeShas.has(sha)) {
      throw new PlannedWorkAdoptionError(`commit de manutenção fora da faixa: ${sha}`);
    }
    if (taskByCommit.has(sha) || sha === planBinding.planExtensionCommitSha) {
      throw new PlannedWorkAdoptionError(`commit ${sha} declarado duas vezes com papéis diferentes`);
    }
    maintenanceShas.add(sha);
  }

  const commits = classifyRange(
    range,
    planBinding.planExtensionCommitSha,
    taskByCommit,
    maintenanceShas,
  );
  const planExtensionIndex = commits.findIndex((commit) => commit.role === 'plan_extension');
  const orderedTaskIds = commits
    .filter((commit) => commit.role === 'planned_task')
    .map((commit) => commit.task_id as string);
  const commitIndexByTask = new Map(
    commits
      .map((commit, index) => [commit, index] as const)
      .filter(([commit]) => commit.role === 'planned_task')
      .map(([commit, index]) => [commit.task_id as string, index]),
  );

  await assertTasksAdoptable({
    paths,
    loaded,
    state,
    addedTaskIds: planBinding.addedTaskIds,
    orderedTaskIds,
    commitIndexByTask,
    planExtensionIndex,
  });

  const acceptedCommitByTask = new Map(
    [...taskByCommit.entries()].map(([sha, taskId]) => [taskId, sha]),
  );
  const rangeValidationCommands = adoptionValidationCommands(previous, target);

  if (input.dryRun === true) {
    const preview: PlannedWorkAdoptionPreview = {
      previousAuthorizedHeadSha: previous,
      targetSha: target,
      planExtensionCommitSha: planBinding.planExtensionCommitSha,
      previousPlanSha256: planBinding.previousPlanSha256,
      adoptedPlanSha256: planBinding.adoptedPlanSha256,
      planAddedTaskIds: planBinding.addedTaskIds,
      commits,
      tasks: await Promise.all(
        orderedTaskIds.map(async (taskId) => {
          const planTask = loaded.byId.get(taskId) as PlanTask;
          const acceptedCommit = acceptedCommitByTask.get(taskId) as string;
          return {
            taskId,
            acceptedCommit,
            planTaskFingerprintSha256: canonicalSha256(planTask),
            committedAt: await committerTimestamp(paths.repoRoot, acceptedCommit),
            validationArgv: planTask.validation.map((command) => command.argv),
          };
        }),
      ),
      rangeValidationArgv: rangeValidationCommands.map((command) => command.argv),
      stateTransitions: orderedTaskIds.map((taskId) => ({
        taskId,
        from: state.tasks.find((task) => task.id === taskId)?.status ?? 'ausente',
        to: 'PASS' as const,
      })),
      authorizedHeadTransition: { from: previous, to: target },
    };
    return { status: 'DRY_RUN', preview };
  }

  const rangeRunner = input.rangeValidationRunner ?? defaultRangeValidationRunner;
  const rangeValidationResults = await withCommitValidationCwd(
    paths.repoRoot,
    target,
    async (cwd) => {
      const results: ValidationResult[] = [];
      for (const command of rangeValidationCommands) {
        const result = await rangeRunner(command, cwd);
        results.push(result);
        if (result.exit_code !== 0 || result.timed_out) {
          throw new PlannedWorkAdoptionError(
            `gate da faixa falhou: ${command.argv.join(' ')}`,
          );
        }
      }
      return results;
    },
  );

  const tasks: PlannedWorkAdoptionTask[] = [];
  for (const taskId of orderedTaskIds) {
    const planTask = loaded.byId.get(taskId) as PlanTask;
    const acceptedCommit = acceptedCommitByTask.get(taskId) as string;
    const { results, evidence } = await revalidateTask({
      paths,
      targetSha: target,
      planTask,
      commitSha: acceptedCommit,
    });
    tasks.push({
      task_id: taskId,
      completion_origin: 'out_of_band_planned_work',
      executed_by_harness: false,
      accepted_commit: acceptedCommit,
      plan_task_fingerprint_sha256: canonicalSha256(planTask),
      committed_at: await committerTimestamp(paths.repoRoot, acceptedCommit),
      validation_source: 'adoption_revalidation',
      validation_results: results,
      validation_evidence: evidence,
    });
  }

  if (!(await isWorkingTreeClean(paths.repoRoot))) {
    throw new PlannedWorkAdoptionError('working tree ficou suja durante a adoção');
  }

  const record = PlannedWorkAdoptionRecord.parse({
    schema_version: DEV_SCHEMA_VERSION,
    adoption_kind: 'planned_work_range',
    previous_authorized_head_sha: previous,
    adopted_head_sha: target,
    commits,
    changed_files: [...new Set(commits.flatMap((commit) => commit.changed_files))].sort(),
    plan_extension_commit_sha: planBinding.planExtensionCommitSha,
    previous_plan_sha256: planBinding.previousPlanSha256,
    adopted_plan_sha256: planBinding.adoptedPlanSha256,
    plan_added_task_ids: planBinding.addedTaskIds,
    tasks,
    range_validation_results: rangeValidationResults,
    working_tree_clean: true,
    reason,
    adopted_at: (input.now ?? (() => new Date().toISOString()))(),
  });

  // Ordem transacional: evidence imutável primeiro; o state só depois.
  await writePlannedWorkAdoption(paths, record);
  await applyAdoptedState(paths, target);
  return {
    status: 'ADOPTED',
    record,
    recordPath: plannedWorkAdoptionPath(paths, target),
    authorizedHeadSha: target,
  };
}
