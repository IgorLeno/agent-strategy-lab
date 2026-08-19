import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface HarnessPaths {
  readonly repoRoot: string;
  /**
   * Raiz do catálogo de profiles. Histórico: igual a `repoRoot`. Em
   * `dev-run-plan` sobre repositório externo, aponta para a instalação do
   * Agent Strategy Lab — o alvo não precisa conter `dev/profiles`.
   */
  readonly profileCatalogRoot: string;
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
  readonly revalidationsDir: string;
  /**
   * Attempts encerrados sem solução aceita: rejeitados pela validation oficial
   * (com a solução preservada) ou abortados por falha de infraestrutura do
   * provider (sem solução nenhuma a preservar).
   */
  readonly failedAttemptsDir: string;
  readonly validationLogsDir: string;
}

/**
 * Override ADITIVO usado quando o harness opera sobre um repositório ALVO que
 * não é o seu próprio: o plano do projeto, o runtime e (opcionalmente) o
 * catálogo de profiles vivem fora do layout default. Omitir os campos reproduz
 * exatamente o comportamento histórico — nenhum caminho muda de lugar.
 */
export interface HarnessPathsOverride {
  /** Caminho absoluto do plan file do repositório alvo. */
  readonly planFile?: string;
  /** Runtime do orquestrador para este alvo; o inbox continua derivado dele. */
  readonly devDir?: string;
  /**
   * Catálogo de profiles. Omitir preserva o default histórico (`repoRoot`).
   * `dev-run-plan` preenche com a instalação do harness.
   */
  readonly profileCatalogRoot?: string;
}

/**
 * `AGENTLAB_DEV_DIR` existe para testes e para inspeção manual; o default é
 * sempre `<repo>/.dev`, que está no .gitignore. O inbox é derivado dele
 * (`<devDir>-inbox`), então redirecionar o runtime redireciona os dois juntos.
 *
 * `override` tem precedência sobre a variável de ambiente porque é uma decisão
 * explícita do control plane sobre QUAL repositório está sendo conduzido, não
 * uma preferência de ambiente do operador.
 */

/**
 * Raiz da instalação do Agent Strategy Lab. Determinada pelo módulo versionado,
 * nunca por `process.cwd()` — o operador pode invocar de qualquer diretório.
 */
export function resolveHarnessInstallationRoot(): string {
  return path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
}

/**
 * Traduz flags aditivas das CLIs (`--plan-file`, `--runtime-dir`,
 * `--profile-root`) no override de `resolveHarnessPaths`. Omitir os campos
 * reproduz o layout histórico.
 */
export function harnessOverrideFromCli(options: {
  readonly planFile?: string | undefined;
  readonly runtimeDir?: string | undefined;
  readonly profileRoot?: string | undefined;
}): HarnessPathsOverride {
  return {
    ...(options.planFile === undefined ? {} : { planFile: options.planFile }),
    ...(options.runtimeDir === undefined ? {} : { devDir: options.runtimeDir }),
    ...(options.profileRoot === undefined ? {} : { profileCatalogRoot: options.profileRoot }),
  };
}

export function resolveHarnessPaths(
  repoRoot: string = process.cwd(),
  override: HarnessPathsOverride = {},
): HarnessPaths {
  const root = path.resolve(repoRoot);
  const devDir = override.devDir
    ? path.resolve(override.devDir)
    : process.env['AGENTLAB_DEV_DIR']
      ? path.resolve(process.env['AGENTLAB_DEV_DIR'])
      : path.join(root, '.dev');
  return {
    repoRoot: root,
    profileCatalogRoot: override.profileCatalogRoot
      ? path.resolve(override.profileCatalogRoot)
      : root,
    planFile: override.planFile
      ? path.resolve(override.planFile)
      : path.join(root, 'dev', 'plan.yaml'),
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
    revalidationsDir: path.join(devDir, 'revalidations'),
    failedAttemptsDir: path.join(devDir, 'failed-attempts'),
    validationLogsDir: path.join(devDir, 'validation-logs'),
  };
}
