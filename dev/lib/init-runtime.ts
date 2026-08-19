import { access } from 'node:fs/promises';
import { headSha } from './git.js';
import { withHarnessLock } from './lock.js';
import type { HarnessPaths } from './paths.js';
import { loadPlan } from './plan.js';
import { buildInitialState, ensureRuntimeDirs, writeState } from './state.js';

/**
 * Recusa de recriação: um state existente é evidência, não rascunho. Reconciliar
 * é trabalho do `dev-recover`; `--force` fica só no `dev-init` explícito.
 */
export class RuntimeExistsError extends Error {
  constructor(readonly stateFile: string) {
    super(`state já existe em ${stateFile} — use dev-recover, ou --force para recriar`);
    this.name = 'RuntimeExistsError';
  }
}

export interface InitRuntimeResult {
  readonly initialized: true;
  readonly dev_dir: string;
  readonly plan_file: string;
  readonly plan_sha256: string;
  readonly task_count: number;
  readonly baseline_sha: string;
}

/**
 * Primitive canônica de inicialização. `dev-init` e `dev-run-plan` compartilham
 * este caminho — o wrapper não monta `buildInitialState` por conta própria.
 */
export async function initializeHarnessRuntime(
  paths: HarnessPaths,
  options: { readonly force?: boolean } = {},
): Promise<InitRuntimeResult> {
  const { plan, planSha256 } = await loadPlan(paths.planFile);

  const exists = await access(paths.stateFile).then(
    () => true,
    () => false,
  );
  if (exists && !options.force) {
    throw new RuntimeExistsError(paths.stateFile);
  }

  await ensureRuntimeDirs(paths);
  // O HEAD do init é a base legítima da primeira tarefa: sem esse registro,
  // não há como distinguir "nada aconteceu ainda" de "alguém commitou fora".
  const baselineSha = await headSha(paths.repoRoot);
  await withHarnessLock(paths, 'dev-init', () =>
    writeState(paths, buildInitialState(plan, planSha256, { baselineSha })),
  );

  return {
    initialized: true,
    dev_dir: paths.devDir,
    plan_file: paths.planFile,
    plan_sha256: planSha256,
    task_count: plan.tasks.length,
    baseline_sha: baselineSha,
  };
}
