import path from 'node:path';

export interface HarnessPaths {
  readonly repoRoot: string;
  /** Definição versionada das tarefas — fonte autoritativa. */
  readonly planFile: string;
  /** Runtime NÃO versionado (.gitignore). */
  readonly devDir: string;
  readonly stateFile: string;
  readonly packetsDir: string;
  readonly completionsDir: string;
  readonly handoffsDir: string;
  readonly logsDir: string;
}

/**
 * `AGENTLAB_DEV_DIR` existe para testes e para inspeção manual; o default é
 * sempre `<repo>/.dev`, que está no .gitignore.
 */
export function resolveHarnessPaths(repoRoot: string = process.cwd()): HarnessPaths {
  const root = path.resolve(repoRoot);
  const devDir = process.env['AGENTLAB_DEV_DIR']
    ? path.resolve(process.env['AGENTLAB_DEV_DIR'])
    : path.join(root, '.dev');
  return {
    repoRoot: root,
    planFile: path.join(root, 'dev', 'plan.yaml'),
    devDir,
    stateFile: path.join(devDir, 'state.json'),
    packetsDir: path.join(devDir, 'task-packets'),
    completionsDir: path.join(devDir, 'completions'),
    handoffsDir: path.join(devDir, 'handoffs'),
    logsDir: path.join(devDir, 'logs'),
  };
}
