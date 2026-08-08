import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type {
  SubscriptionUsage,
  SubscriptionUsageProbe,
  SubscriptionUsageWindow,
} from './schemas.js';

/**
 * Medição da quota REAL da assinatura, antes e depois de cada run Claude.
 *
 * A fonte é `claude -p "/usage"`, que nesta versão da CLI (2.1.226) é um probe
 * LOCAL: o result volta com `duration_api_ms=0`, `num_turns=0`,
 * `total_cost_usd=0`, todos os contadores de token zerados e `modelUsage={}`.
 * Nada disso é presumido — cada run do probe volta a provar esses campos, e sem
 * a prova a medição não é aceita.
 *
 * O que este módulo NÃO faz: não usa `--bare`, não usa API key, não consulta
 * endpoint de OAuth, não raspa TUI, não lê statusLine e não reaproveita a
 * sessão do worker. É sempre um processo novo e descartável.
 */

// ---------------------------------------------------------------------------
// Comando do probe
// ---------------------------------------------------------------------------

export const CLAUDE_USAGE_PROMPT = '/usage';

/**
 * Teto de gasto do próprio probe. Não é o mecanismo de segurança — o contrato
 * de inferência zero é —, mas limita o estrago de qualquer versão futura da CLI
 * que resolvesse responder `/usage` com um turno de modelo.
 */
export const CLAUDE_USAGE_MAX_BUDGET_USD = '0.000001';

/**
 * `--tools` é VARIÁDICA na CLI: `--tools '' "/usage"` faria o prompt ser lido
 * como nome de ferramenta. Por isso ela nunca é a última opção antes do prompt
 * — `--strict-mcp-config` fecha a lista.
 */
export function claudeUsageArgv(binary: string): string[] {
  return [
    binary,
    '--print',
    '--output-format',
    'json',
    '--no-session-persistence',
    '--max-budget-usd',
    CLAUDE_USAGE_MAX_BUDGET_USD,
    '--tools',
    '',
    '--settings',
    '{"disableAllHooks":true}',
    '--setting-sources',
    'project',
    '--strict-mcp-config',
    CLAUDE_USAGE_PROMPT,
  ];
}

/**
 * Runner próprio, com stdout SEPARADO do stderr: o result do probe é JSON, e
 * qualquer aviso da CLI misturado na mesma string corromperia o parse — o que
 * viraria "probe falhou" em cima de um probe que funcionou.
 */
export type UsageCommandRunner = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export const spawnUsageRunner: UsageCommandRunner = (command, args, env, cwd) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => resolve({ code: null, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

// ---------------------------------------------------------------------------
// Contrato de inferência zero
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Todo número dentro de `usage` precisa ser 0 — inclusive os aninhados. */
function nonZeroNumbers(value: unknown, path: string, found: string[]): void {
  if (typeof value === 'number') {
    if (Number.isFinite(value) && value !== 0) found.push(`${path}=${value}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => nonZeroNumbers(item, `${path}[${index}]`, found));
    return;
  }
  if (isRecord(value)) {
    for (const [key, nested] of Object.entries(value)) {
      nonZeroNumbers(nested, `${path}.${key}`, found);
    }
  }
}

/**
 * Prova POSITIVA de que o probe não gastou nada. Campo ausente não passa: ele
 * não prova zero, e tratar ausência como zero seria exatamente a mentira que a
 * política proíbe em toda parte do harness.
 */
export function zeroInferenceViolations(
  result: unknown,
  exitCode: number | null,
): string[] {
  const violations: string[] = [];
  if (exitCode !== 0) violations.push(`exit_code=${exitCode ?? 'null'}`);
  if (!isRecord(result)) return [...violations, 'result ausente ou não é objeto'];

  if (result['is_error'] === true) violations.push('is_error=true');

  const cost = result['total_cost_usd'];
  if (typeof cost !== 'number' || !Number.isFinite(cost)) {
    violations.push('total_cost_usd ausente');
  } else if (cost !== 0) {
    violations.push(`total_cost_usd=${cost}`);
  }

  const turns = result['num_turns'];
  if (typeof turns === 'number' && turns !== 0) violations.push(`num_turns=${turns}`);

  const usage = result['usage'];
  if (!isRecord(usage)) violations.push('usage ausente');
  else nonZeroNumbers(usage, 'usage', violations);

  const modelUsage = result['modelUsage'] ?? result['model_usage'];
  if (!isRecord(modelUsage)) violations.push('modelUsage ausente');
  else if (Object.keys(modelUsage).length > 0) {
    violations.push(`modelUsage com ${Object.keys(modelUsage).length} modelo(s)`);
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Parser do texto do /usage — falha fechada
// ---------------------------------------------------------------------------

export interface ClaudeUsageWindowReading {
  readonly used_pct: number;
  /** Rótulo de reset EXATO, usado como identidade da janela. */
  readonly reset_label: string;
}

export interface ClaudeUsageReading {
  readonly five_hour: ClaudeUsageWindowReading;
  readonly seven_day_all_models: ClaudeUsageWindowReading;
}

const FIVE_HOUR_LINE = /^\s*Current session:\s*([\d.]+)%\s*used\s*·\s*resets\s+(.+?)\s*$/m;
const SEVEN_DAY_LINE =
  /^\s*Current week \(all models\):\s*([\d.]+)%\s*used\s*·\s*resets\s+(.+?)\s*$/m;

function readWindow(text: string, pattern: RegExp): ClaudeUsageWindowReading | null {
  const match = pattern.exec(text);
  if (!match) return null;
  const used = Number(match[1]);
  const label = (match[2] ?? '').trim();
  if (!Number.isFinite(used) || label === '') return null;
  return { used_pct: used, reset_label: label };
}

/**
 * Só os dois cabeçalhos declarados são lidos. O bloco "What's contributing to
 * your limits usage?" é telemetria local aproximada e NÃO é quota da tarefa —
 * interpretá-lo aqui seria inventar métrica.
 */
export function parseClaudeUsageText(text: string): ClaudeUsageReading | null {
  const fiveHour = readWindow(text, FIVE_HOUR_LINE);
  const sevenDay = readWindow(text, SEVEN_DAY_LINE);
  if (!fiveHour || !sevenDay) return null;
  return { five_hour: fiveHour, seven_day_all_models: sevenDay };
}

// ---------------------------------------------------------------------------
// Execução do probe
// ---------------------------------------------------------------------------

/** Objeto `result` do `--output-format json`; `null` se o stdout não trouxe um. */
function readUsageResult(stdout: string): Record<string, unknown> | null {
  const text = stdout.trim();
  if (text === '') return null;
  try {
    const whole: unknown = JSON.parse(text);
    if (isRecord(whole)) return whole;
  } catch {
    // Pode ter vindo com ruído em volta: cai para a varredura linha a linha.
  }
  let last: Record<string, unknown> | null = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) last = parsed;
    } catch {
      // Linha que não é JSON não é erro aqui: o contrato é avaliado no result.
    }
  }
  return last;
}

export interface ClaudeUsageProbeInput {
  readonly binary: string;
  /** Ambiente FINAL do worker: a medição precisa valer para a MESMA credencial. */
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly runner?: UsageCommandRunner;
}

export interface ClaudeUsageProbeOutcome {
  readonly probe: SubscriptionUsageProbe;
  /** Leitura utilizável; `null` sempre que a medição não puder ser aceita. */
  readonly reading: ClaudeUsageReading | null;
  /**
   * `true` quando o result EXISTE mas não prova inferência zero. Nesse caso o
   * probe pode ter gastado franquia, e o launcher não pode seguir como se o
   * valor fosse baseline válido.
   */
  readonly unsafe: boolean;
}

export const NOT_RUN_PROBE: SubscriptionUsageProbe = {
  available: false,
  zero_inference_verified: false,
  reason_code: 'NOT_RUN',
  reason: 'probe não executado',
  result_text_sha256: null,
  command: `claude ${CLAUDE_USAGE_PROMPT}`,
  exit_code: null,
};

export async function probeClaudeUsage(
  input: ClaudeUsageProbeInput,
): Promise<ClaudeUsageProbeOutcome> {
  const argv = claudeUsageArgv(input.binary);
  const command = argv.join(' ');
  const runner = input.runner ?? spawnUsageRunner;

  let code: number | null = null;
  let stdout = '';
  let stderr = '';
  try {
    ({ code, stdout, stderr } = await runner(
      argv[0] as string,
      argv.slice(1),
      input.env,
      input.cwd,
    ));
  } catch (error) {
    stderr = error instanceof Error ? error.message : String(error);
  }

  const result = readUsageResult(stdout);
  if (result === null) {
    // Sem result não há o que interpretar — e também não há evidência nenhuma
    // de inferência. O run segue sem baseline, com o motivo registrado.
    return {
      probe: {
        available: false,
        zero_inference_verified: false,
        reason_code: 'PROBE_FAILED',
        reason: `/usage não devolveu result legível (exit ${code ?? 'null'})${
          stderr.trim() === '' ? '' : `: ${firstLine(stderr)}`
        }`,
        result_text_sha256: null,
        command,
        exit_code: code,
      },
      reading: null,
      unsafe: false,
    };
  }

  const violations = zeroInferenceViolations(result, code);
  const resultText = typeof result['result'] === 'string' ? (result['result'] as string) : null;
  const sha = resultText === null ? null : sha256(resultText);

  if (violations.length > 0) {
    return {
      probe: {
        available: false,
        zero_inference_verified: false,
        reason_code: 'ZERO_INFERENCE_UNVERIFIED',
        reason: `/usage não provou execução sem inferência: ${violations.join(', ')}`,
        result_text_sha256: sha,
        command,
        exit_code: code,
      },
      reading: null,
      unsafe: true,
    };
  }

  const reading = resultText === null ? null : parseClaudeUsageText(resultText);
  if (reading === null) {
    return {
      probe: {
        available: false,
        zero_inference_verified: true,
        reason_code: 'PARSE_ERROR',
        reason: 'os dois cabeçalhos de uso não puderam ser extraídos do texto do /usage',
        result_text_sha256: sha,
        command,
        exit_code: code,
      },
      reading: null,
      unsafe: false,
    };
  }

  return {
    probe: {
      available: true,
      zero_inference_verified: true,
      reason_code: 'OK',
      reason: null,
      result_text_sha256: sha,
      command,
      exit_code: code,
    },
    reading,
    unsafe: false,
  };
}

function firstLine(text: string): string {
  return (text.trim().split('\n')[0] ?? '').slice(0, 200);
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Medição — consumo só existe dentro da MESMA janela
// ---------------------------------------------------------------------------

/** Ponto flutuante em pp acumula ruído (6.000000000000005); 6 casas bastam. */
function round(value: number): number {
  return Number(value.toFixed(6));
}

function windowMeasurement(
  before: ClaudeUsageWindowReading | null,
  after: ClaudeUsageWindowReading | null,
): SubscriptionUsageWindow {
  const base = {
    before_used_pct: before?.used_pct ?? null,
    after_used_pct: after?.used_pct ?? null,
    before_reset_label: before?.reset_label ?? null,
    after_reset_label: after?.reset_label ?? null,
  };
  if (!before || !after) {
    return { ...base, same_window: false, consumed_pp: null, reason_code: 'MEASUREMENT_UNAVAILABLE' };
  }
  // Comparação exata do rótulo: converter data para comparar janela exigiria
  // reimplementar fuso e formato da CLI, e um erro ali produziria "3 - 97".
  if (before.reset_label !== after.reset_label) {
    return { ...base, same_window: false, consumed_pp: null, reason_code: 'RATE_LIMIT_WINDOW_RESET' };
  }
  return {
    ...base,
    same_window: true,
    consumed_pp: round(after.used_pct - before.used_pct),
    reason_code: 'OK',
  };
}

export function buildSubscriptionUsage(
  before: ClaudeUsageProbeOutcome,
  after: ClaudeUsageProbeOutcome,
): SubscriptionUsage {
  return {
    source: 'claude_print_usage',
    probe_contract: { before: before.probe, after: after.probe },
    five_hour: windowMeasurement(
      before.reading?.five_hour ?? null,
      after.reading?.five_hour ?? null,
    ),
    seven_day_all_models: windowMeasurement(
      before.reading?.seven_day_all_models ?? null,
      after.reading?.seven_day_all_models ?? null,
    ),
  };
}

/** Resultado do probe que não rodou — usado antes do AFTER e em perfis sem probe. */
export const NOT_RUN_OUTCOME: ClaudeUsageProbeOutcome = {
  probe: NOT_RUN_PROBE,
  reading: null,
  unsafe: false,
};
