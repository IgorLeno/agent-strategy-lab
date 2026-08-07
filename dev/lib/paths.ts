import path from 'node:path';

export interface HarnessPaths {
  readonly repoRoot: string;
  /** Definição versionada das tarefas — fonte autoritativa. */
  readonly planFile: string;
  /** Runtime do ORQUESTRADOR, NÃO versionado (.gitignore). O worker não escreve aqui. */
  readonly devDir: string;
  /**
   * Caixa de entrada do worker: os únicos caminhos de escrita que ele recebe.
   * Fica FORA de devDir para que "o que o worker produziu" e "o que o
   * orquestrador derivou" não morem no mesmo diretório.
   */
  readonly inboxDir: string;
  readonly stateFile: string;
  readonly packetsDir: string;
  readonly completionsDir: string;
  readonly handoffsDir: string;
  readonly logsDir: string;
  readonly maintenanceDir: string;
  readonly attemptsDir: string;
  readonly recoveriesDir: string;
  readonly finalizationsDir: string;
}

/**
 * `AGENTLAB_DEV_DIR` existe para testes e para inspeção manual; o default é
 * sempre `<repo>/.dev`, que está no .gitignore. O inbox é derivado dele
 * (`<devDir>-inbox`), então redirecionar o runtime redireciona os dois juntos.
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
    inboxDir: `${devDir}-inbox`,
    stateFile: path.join(devDir, 'state.json'),
    packetsDir: path.join(devDir, 'task-packets'),
    completionsDir: path.join(devDir, 'completions'),
    handoffsDir: path.join(devDir, 'handoffs'),
    logsDir: path.join(devDir, 'logs'),
    maintenanceDir: path.join(devDir, 'maintenance'),
    attemptsDir: path.join(devDir, 'attempts'),
    recoveriesDir: path.join(devDir, 'recoveries'),
    finalizationsDir: path.join(devDir, 'finalizations'),
  };
}
