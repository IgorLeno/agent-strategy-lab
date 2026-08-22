import {
  changedFiles,
  commitExists,
  parentShas,
} from './git.js';
import type { HarnessPaths } from './paths.js';
import { parsePlan } from './plan.js';
import {
  assertAppendOnlyPlanExtension,
  planSourceAtCommit,
  PlanExtensionContractError,
} from './plan-extension-contract.js';
import {
  listPlannedWorkAdoptionShas,
  readPlannedWorkAdoption,
} from './records.js';
import {
  PlannedWorkAdoptionRecord,
  type PlannedWorkAdoptionTask,
} from './schemas.js';

export class PlannedWorkAdoptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlannedWorkAdoptionError';
  }
}

/**
 * Reverifica um record já publicado contra o Git e contra o plano dos commits
 * envolvidos. NÃO reroda validações: elas estão seladas no record, e repeti-las
 * a cada `recover` transformaria reconciliação em rebuild.
 */
export async function verifyPlannedWorkAdoptionRecord(
  paths: HarnessPaths,
  record: PlannedWorkAdoptionRecord,
): Promise<void> {
  PlannedWorkAdoptionRecord.parse(record);
  for (const commit of record.commits) {
    if (!(await commitExists(paths.repoRoot, commit.sha))) {
      throw new PlannedWorkAdoptionError(`commit da adoção não existe: ${commit.sha}`);
    }
    const parents = await parentShas(paths.repoRoot, commit.sha);
    if (parents.length !== 1 || parents[0] !== commit.parent_sha) {
      throw new PlannedWorkAdoptionError(`parent da adoção diverge em ${commit.sha}`);
    }
    const actual = await changedFiles(paths.repoRoot, commit.sha);
    if (JSON.stringify(actual) !== JSON.stringify(commit.changed_files)) {
      throw new PlannedWorkAdoptionError(`changed_files da adoção diverge em ${commit.sha}`);
    }
  }

  const previousPlan = parsePlan(
    await planSourceAtCommit(paths.repoRoot, record.previous_authorized_head_sha),
  );
  const adoptedPlan = parsePlan(await planSourceAtCommit(paths.repoRoot, record.adopted_head_sha));
  if (previousPlan.planSha256 !== record.previous_plan_sha256) {
    throw new PlannedWorkAdoptionError('previous_plan_sha256 diverge do plano da base autorizada');
  }
  if (adoptedPlan.planSha256 !== record.adopted_plan_sha256) {
    throw new PlannedWorkAdoptionError('adopted_plan_sha256 diverge do plano do target');
  }
  let addedTaskIds: readonly string[];
  try {
    addedTaskIds = assertAppendOnlyPlanExtension(previousPlan.plan, adoptedPlan.plan);
  } catch (error) {
    if (error instanceof PlanExtensionContractError) {
      throw new PlannedWorkAdoptionError(error.message);
    }
    throw error;
  }
  if (JSON.stringify([...addedTaskIds]) !== JSON.stringify([...record.plan_added_task_ids])) {
    throw new PlannedWorkAdoptionError('plan_added_task_ids diverge da extensão provada pelo Git');
  }
}

export async function readAllPlannedWorkAdoptions(
  paths: HarnessPaths,
): Promise<PlannedWorkAdoptionRecord[]> {
  const records: PlannedWorkAdoptionRecord[] = [];
  for (const sha of await listPlannedWorkAdoptionShas(paths)) {
    const record = await readPlannedWorkAdoption(paths, sha);
    if (!record || record.adopted_head_sha !== sha) {
      throw new PlannedWorkAdoptionError(`PlannedWorkAdoptionRecord inválido: ${sha}.json`);
    }
    await verifyPlannedWorkAdoptionRecord(paths, record);
    records.push(record);
  }
  return records;
}

/** Avança a base autorizada por adoções válidas que começam exatamente nela. */
export async function reconcilePlannedWorkAdoptions(
  paths: HarnessPaths,
  authorizedHead: string | null,
): Promise<string | null> {
  if (authorizedHead === null) return null;
  const records = await readAllPlannedWorkAdoptions(paths);
  let current = authorizedHead;
  const consumed = new Set<string>();
  for (;;) {
    const candidates = records.filter(
      (record) =>
        !consumed.has(record.adopted_head_sha) &&
        record.previous_authorized_head_sha === current,
    );
    if (candidates.length === 0) return current;
    if (candidates.length > 1) {
      throw new PlannedWorkAdoptionError(`adoções ambíguas a partir de ${current}`);
    }
    const next = candidates[0] as PlannedWorkAdoptionRecord;
    consumed.add(next.adopted_head_sha);
    current = next.adopted_head_sha;
  }
}

export interface AdoptedTaskEvidence {
  readonly record: PlannedWorkAdoptionRecord;
  readonly task: PlannedWorkAdoptionTask;
}

/**
 * Evidência de adoção por tarefa, já verificada. Uma tarefa adotada duas vezes
 * é contradição: quem responde pelo PASS dela deixaria de ser único.
 */
export async function loadAdoptedTaskEvidence(
  paths: HarnessPaths,
): Promise<Map<string, AdoptedTaskEvidence>> {
  const byTask = new Map<string, AdoptedTaskEvidence>();
  for (const record of await readAllPlannedWorkAdoptions(paths)) {
    for (const task of record.tasks) {
      if (byTask.has(task.task_id)) {
        throw new PlannedWorkAdoptionError(`${task.task_id} adotada por mais de um record`);
      }
      byTask.set(task.task_id, { record, task });
    }
  }
  return byTask;
}

