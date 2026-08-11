import { access, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runValidation, toValidationResult } from './exec.js';
import {
  changedFiles,
  commitExists,
  gitOrThrow,
  headSha,
  isAncestor,
  isWorkingTreeClean,
  parentShas,
} from './git.js';
import {
  adoptionValidationCommands,
  resolveAdoptionKind,
  verifyMaintenanceRecord,
  type MaintenanceValidationRunner,
} from './maintenance.js';
import type { HarnessPaths } from './paths.js';
import { loadPlan, parsePlan, type LoadedPlan } from './plan.js';
import {
  assertAppendOnlyPlanExtension,
  planSourceAtCommit,
  verifyPlanExtensionCommit,
} from './plan-extension-contract.js';
import { readMaintenanceRecord, writeMaintenanceRecord } from './records.js';
import { recover } from './recover.js';
import {
  DEV_SCHEMA_VERSION,
  MaintenanceRecord,
  type ValidationResult,
} from './schemas.js';
import { readState, writeState } from './state.js';

export { assertAppendOnlyPlanExtension } from './plan-extension-contract.js';

export class PlanExtensionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanExtensionError';
  }
}

export interface PlanExtensionInput {
  readonly paths: HarnessPaths;
  readonly target: string;
  readonly reason: string;
  readonly validationRunner?: MaintenanceValidationRunner;
  readonly now?: () => string;
}

export interface PlanExtensionResult {
  readonly record: MaintenanceRecord;
  readonly alreadyAdopted: boolean;
  readonly addedTaskIds: readonly string[];
  readonly previousAuthorizedHeadSha: string;
  readonly authorizedHeadSha: string;
  readonly targetSha: string;
}

const defaultValidationRunner: MaintenanceValidationRunner = async (command, cwd) =>
  toValidationResult(await runValidation(command, { cwd }));

async function resolveCommitSha(repoRoot: string, raw: string): Promise<string> {
  const trimmed = raw.trim();
  if (trimmed === '') throw new PlanExtensionError('--target é obrigatório');
  try {
    return (await gitOrThrow(repoRoot, ['rev-parse', '--verify', `${trimmed}^{commit}`])).trim();
  } catch {
    throw new PlanExtensionError(`target não existe: ${trimmed}`);
  }
}

async function assertNoLaterPlanEdits(
  repoRoot: string,
  target: string,
  head: string,
): Promise<void> {
  if (target === head) return;
  const log = (await gitOrThrow(repoRoot, ['log', '--format=%H', `${target}..${head}`])).trim();
  if (log === '') return;
  for (const sha of log.split('\n')) {
    const files = await changedFiles(repoRoot, sha);
    if (files.includes('dev/plan.yaml')) {
      throw new PlanExtensionError(
        `commit posterior ${sha} também modificou dev/plan.yaml`,
      );
    }
  }
}

async function assertCurrentPlanMatchesTarget(
  paths: HarnessPaths,
  target: string,
): Promise<void> {
  const currentPlan = await loadPlan(paths.planFile);
  const targetPlan = parsePlan(await planSourceAtCommit(paths.repoRoot, target));
  if (currentPlan.planSha256 !== targetPlan.planSha256) {
    throw new PlanExtensionError(
      'dev/plan.yaml atual não corresponde ao plano do target',
    );
  }
}

/**
 * Valida o TARGET sem contaminar o working tree principal: quando HEAD ≠
 * target, usa worktree detachado + symlink de node_modules.
 */
async function withTargetValidationCwd<T>(
  repoRoot: string,
  target: string,
  run: (cwd: string) => Promise<T>,
): Promise<T> {
  const head = await headSha(repoRoot);
  if (head === target) return run(repoRoot);

  const worktreeDir = await mkdtemp(path.join(tmpdir(), 'agentlab-plan-ext-'));
  try {
    await gitOrThrow(repoRoot, ['worktree', 'add', '--detach', worktreeDir, target]);
    const nodeModules = path.join(repoRoot, 'node_modules');
    try {
      await access(nodeModules);
      await symlink(nodeModules, path.join(worktreeDir, 'node_modules'), 'dir');
    } catch {
      // Sem node_modules compartilhado: typecheck/build/test falharão de forma auditável.
    }
    return await run(worktreeDir);
  } finally {
    try {
      await gitOrThrow(repoRoot, ['worktree', 'remove', '--force', worktreeDir]);
    } catch {
      await rm(worktreeDir, { recursive: true, force: true });
      await gitOrThrow(repoRoot, ['worktree', 'prune']).catch(() => undefined);
    }
  }
}

async function runTargetValidations(
  paths: HarnessPaths,
  previous: string,
  target: string,
  runner: MaintenanceValidationRunner,
): Promise<ValidationResult[]> {
  const commands = adoptionValidationCommands(previous, target);
  return withTargetValidationCwd(paths.repoRoot, target, async (cwd) => {
    const validationResults: ValidationResult[] = [];
    for (const command of commands) {
      // git diff --check usa o object DB do repo; rodar a partir do worktree
      // ou do root é equivalente — o range é previous..target, não o HEAD.
      const result = await runner(command, cwd);
      validationResults.push(result);
      if (result.exit_code !== 0 || result.timed_out) {
        throw new PlanExtensionError(`validação falhou: ${command.argv.join(' ')}`);
      }
    }
    return validationResults;
  });
}

async function applyAdoptedState(
  paths: HarnessPaths,
  loaded: LoadedPlan,
): Promise<void> {
  const recovery = await recover(paths, loaded);
  await writeState(paths, recovery.state);
}

export async function adoptPlanExtension(
  input: PlanExtensionInput,
): Promise<PlanExtensionResult> {
  const reason = input.reason.trim();
  if (reason === '') throw new PlanExtensionError('--reason é obrigatório');
  if (!(await isWorkingTreeClean(input.paths.repoRoot))) {
    throw new PlanExtensionError('working tree suja; adoção recusada');
  }

  const state = await readState(input.paths);
  const running = state.tasks.find((task) => task.status === 'RUNNING');
  if (running) throw new PlanExtensionError(`tarefa RUNNING: ${running.id}`);

  const previous = state.authorized_head_sha;
  if (previous === null) throw new PlanExtensionError('authorized_head_sha ausente');

  const target = await resolveCommitSha(input.paths.repoRoot, input.target);
  const head = await headSha(input.paths.repoRoot);
  const existing = await readMaintenanceRecord(input.paths, target);

  const finish = async (
    record: MaintenanceRecord,
    alreadyAdopted: boolean,
    addedTaskIds: readonly string[],
  ): Promise<PlanExtensionResult> => {
    const loaded = await loadPlan(input.paths.planFile);
    await applyAdoptedState(input.paths, loaded);
    const after = await readState(input.paths);
    if (after.authorized_head_sha !== target) {
      throw new PlanExtensionError(
        `authorized_head_sha não avançou para o target (${after.authorized_head_sha} ≠ ${target})`,
      );
    }
    if (after.plan_sha256 !== loaded.planSha256) {
      throw new PlanExtensionError('plan_sha256 não corresponde ao plano adotado');
    }
    return {
      record,
      alreadyAdopted,
      addedTaskIds,
      previousAuthorizedHeadSha: previous,
      authorizedHeadSha: target,
      targetSha: target,
    };
  };

  if (existing) {
    // Não reroda validações caras já seladas; revalida fatos baratos + contrato Git.
    await verifyMaintenanceRecord(input.paths, existing);
    if (resolveAdoptionKind(existing) !== 'plan_extension') {
      throw new PlanExtensionError('record existente no target não é plan_extension');
    }
    if (existing.previous_authorized_head_sha !== previous && previous !== target) {
      throw new PlanExtensionError(
        'MaintenanceRecord existente não começa no authorized_head_sha',
      );
    }
    if (!(await isAncestor(input.paths.repoRoot, target, head))) {
      throw new PlanExtensionError('target não é ancestral do HEAD');
    }
    await assertNoLaterPlanEdits(input.paths.repoRoot, target, head);
    await assertCurrentPlanMatchesTarget(input.paths, target);
    const addedTaskIds = await verifyPlanExtensionCommit(input.paths.repoRoot, existing);
    return finish(existing, true, addedTaskIds);
  }

  if (previous === target) {
    throw new PlanExtensionError('target já é a base autorizada; nenhuma extensão a adotar');
  }

  if (!(await commitExists(input.paths.repoRoot, target))) {
    throw new PlanExtensionError(`target não existe: ${target}`);
  }

  const parents = await parentShas(input.paths.repoRoot, target);
  if (parents.length !== 1 || parents[0] !== previous) {
    throw new PlanExtensionError(
      `parent(target) deve ser exatamente authorized_head_sha (${previous}); ` +
        `recebido ${parents.join(',') || '(nenhum)'}`,
    );
  }

  if (!(await isAncestor(input.paths.repoRoot, target, head))) {
    throw new PlanExtensionError('target não é ancestral do HEAD');
  }

  const targetFiles = await changedFiles(input.paths.repoRoot, target);
  if (JSON.stringify(targetFiles) !== JSON.stringify(['dev/plan.yaml'])) {
    throw new PlanExtensionError(
      `target deve modificar somente dev/plan.yaml; recebido: ${JSON.stringify(targetFiles)}`,
    );
  }

  await assertNoLaterPlanEdits(input.paths.repoRoot, target, head);
  await assertCurrentPlanMatchesTarget(input.paths, target);

  const oldPlan = parsePlan(await planSourceAtCommit(input.paths.repoRoot, previous));
  const targetPlan = parsePlan(await planSourceAtCommit(input.paths.repoRoot, target));
  const addedTaskIds = assertAppendOnlyPlanExtension(oldPlan.plan, targetPlan.plan);

  const runner = input.validationRunner ?? defaultValidationRunner;
  const validationResults = await runTargetValidations(
    input.paths,
    previous,
    target,
    runner,
  );

  if (!(await isWorkingTreeClean(input.paths.repoRoot))) {
    throw new PlanExtensionError('working tree ficou suja durante as validações');
  }

  const record = MaintenanceRecord.parse({
    schema_version: DEV_SCHEMA_VERSION,
    previous_authorized_head_sha: previous,
    adopted_head_sha: target,
    commits: [
      {
        sha: target,
        parent_sha: previous,
        changed_files: ['dev/plan.yaml'],
      },
    ],
    changed_files: ['dev/plan.yaml'],
    validation_results: validationResults,
    working_tree_clean: true,
    bootstrap_range: false,
    reason,
    adopted_at: (input.now ?? (() => new Date().toISOString()))(),
    adoption_kind: 'plan_extension',
  });

  // Evidence imutável primeiro; state (via recover) só depois.
  await writeMaintenanceRecord(input.paths, record);
  return finish(record, false, addedTaskIds);
}
