import { canonicalJson } from './canonical.js';
import { changedFiles, gitOrThrow, parentShas } from './git.js';
import { parsePlan } from './plan.js';
import type { MaintenanceRecord, PlanFile } from './schemas.js';

export class PlanExtensionContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanExtensionContractError';
  }
}

/** Conteúdo de `dev/plan.yaml` em um commit — fonte Git, não o working tree. */
export async function planSourceAtCommit(repoRoot: string, sha: string): Promise<string> {
  try {
    return await gitOrThrow(repoRoot, ['show', `${sha}:dev/plan.yaml`]);
  } catch {
    throw new PlanExtensionContractError(`dev/plan.yaml ausente em ${sha}`);
  }
}

/**
 * Extensão append-only: prefixo histórico canonicamente idêntico, na mesma
 * ordem; somente tasks novas no sufixo. Comparação estrutural via JSON canônico.
 */
export function assertAppendOnlyPlanExtension(
  oldPlan: PlanFile,
  newPlan: PlanFile,
): readonly string[] {
  if (oldPlan.schema_version !== newPlan.schema_version) {
    throw new PlanExtensionContractError(
      `schema_version divergente: ${oldPlan.schema_version} → ${newPlan.schema_version}`,
    );
  }
  if (newPlan.tasks.length < oldPlan.tasks.length) {
    throw new PlanExtensionContractError('plan extension recusada: task histórica removida');
  }
  for (let index = 0; index < oldPlan.tasks.length; index += 1) {
    const previous = oldPlan.tasks[index];
    const next = newPlan.tasks[index];
    if (canonicalJson(previous) !== canonicalJson(next)) {
      const previousId = previous?.id ?? '?';
      const nextId = next?.id ?? '?';
      if (previousId !== nextId) {
        throw new PlanExtensionContractError(
          `plan extension recusada: reorder ou remoção na posição ${index} (${previousId} → ${nextId})`,
        );
      }
      throw new PlanExtensionContractError(
        `plan extension recusada: task histórica alterada: ${previousId}`,
      );
    }
  }
  if (newPlan.tasks.length === oldPlan.tasks.length) {
    throw new PlanExtensionContractError('plan extension exige ao menos uma task nova');
  }
  return newPlan.tasks.slice(oldPlan.tasks.length).map((task) => task.id);
}

export type PlanExtensionRecordView = Pick<
  MaintenanceRecord,
  | 'adoption_kind'
  | 'previous_authorized_head_sha'
  | 'adopted_head_sha'
  | 'commits'
  | 'changed_files'
  | 'bootstrap_range'
>;

/**
 * Prova independente a partir do Git de que o record descreve um commit de
 * plan extension append-only válido. Não confia em claims do record além dos
 * SHAs previous/target.
 */
export async function verifyPlanExtensionCommit(
  repoRoot: string,
  record: PlanExtensionRecordView,
): Promise<readonly string[]> {
  if ((record.adoption_kind ?? 'maintenance') !== 'plan_extension') {
    throw new PlanExtensionContractError('record não é plan_extension');
  }
  if (record.bootstrap_range) {
    throw new PlanExtensionContractError('plan_extension não admite bootstrap_range');
  }
  if (record.commits.length !== 1) {
    throw new PlanExtensionContractError('plan_extension exige exatamente um commit');
  }

  const previous = record.previous_authorized_head_sha;
  const target = record.adopted_head_sha;
  const commit = record.commits[0];
  if (!commit || commit.sha !== target) {
    throw new PlanExtensionContractError('plan_extension: commit único deve ser o adopted_head_sha');
  }

  const parents = await parentShas(repoRoot, target);
  if (parents.length !== 1 || parents[0] !== previous) {
    throw new PlanExtensionContractError(
      `parent(target) deve ser exatamente previous_authorized_head_sha (${previous}); ` +
        `recebido ${parents.join(',') || '(nenhum)'}`,
    );
  }

  const actualFiles = await changedFiles(repoRoot, target);
  if (JSON.stringify(actualFiles) !== JSON.stringify(['dev/plan.yaml'])) {
    throw new PlanExtensionContractError(
      `plan_extension exige changed_files=[dev/plan.yaml] no Git; recebido: ${JSON.stringify(actualFiles)}`,
    );
  }

  const oldPlan = parsePlan(await planSourceAtCommit(repoRoot, previous));
  const newPlan = parsePlan(await planSourceAtCommit(repoRoot, target));
  return assertAppendOnlyPlanExtension(oldPlan.plan, newPlan.plan);
}
