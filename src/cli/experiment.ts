/**
 * CLI `agentlab experiment --pilot`: inspeção/preflight do piloto congelado
 * e gate explícito para o caminho oficial de execução.
 *
 * `--dry-run` lê o ExperimentSpec, liga o adapter Claude e NÃO observa quota
 * de provider, NÃO autoriza REAL_INFERENCE e NÃO executa slots.
 *
 * `--execute` só avança com `--confirm-real-inference` e um arquivo de
 * evidência humana. Sem esses gates nenhum slot real é lançado. A existência
 * deste comando NÃO autoriza o piloto.
 */
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z, ZodError } from 'zod';

import { CLAUDE_ADAPTER_IDENTITY, type ProbeClaudeQuotaOptions } from '../adapters/index.js';
import type { RealExecutionAuthorization } from '../billing/index.js';
import type { ExecutionStatus } from '../core/enums.js';
import {
  inspectOfficialPilot,
  runOfficialPilot,
  type OfficialPilotInspection,
  type PlannedSlot,
} from '../experiment/index.js';
import { buildPilotExperimentSpec } from '../experiment/pilot.js';
import type { DataDirectoryConfig } from '../project/index.js';
import { executeRun } from './run-execute.js';
import { prepareRun } from './run-prepare.js';

export const EXPERIMENT_USAGE =
  'Uso: agentlab experiment --pilot --dry-run\n' +
  '     agentlab experiment --pilot --execute --confirm-real-inference --input <caminho>\n' +
  'experiment --pilot --dry-run inspeciona o spec congelado sem provider e NÃO autoriza o piloto.\n' +
  'experiment --pilot --execute exige --confirm-real-inference e evidência humana em --input;\n' +
  'sem esses gates nenhum dos 12 slots reais é lançado.\n';

export interface RunPilotCliOptions {
  readonly args: readonly string[];
  readonly repoRoot?: string;
  readonly labRoot?: string;
  readonly config?: DataDirectoryConfig;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdout?: (chunk: string) => void;
  readonly stderr?: (chunk: string) => void;
  /** Somente testes: injeta a probe Claude fake. Produção nunca passa isto. */
  readonly quotaProbe?: ProbeClaudeQuotaOptions;
  /** Somente testes: substitui prepareRun/executeRun. Produção nunca passa isto. */
  readonly executeSlot?: (slot: PlannedSlot) => Promise<ExecutionStatus> | ExecutionStatus;
}

const evidence = <Value extends z.ZodTypeAny>(value: Value) =>
  z.object({ value: value.nullable(), provenance: z.string() }).strict();

const RealExecutionAuthorizationInput: z.ZodType<RealExecutionAuthorization> = z
  .object({
    authorization: evidence(z.enum(['AUTHORIZED', 'DENIED'])),
    billing_mode: evidence(z.enum(['SUBSCRIPTION', 'API', 'NO_CHARGE'])),
    quota: z
      .object({
        availability: evidence(z.enum(['SUFFICIENT', 'INSUFFICIENT'])),
        remaining: evidence(z.number()),
        unit: z.string().nullable(),
      })
      .strict(),
    cost: z
      .object({
        api_equivalent_usd: evidence(z.number()),
        projected_incremental_charge_usd: evidence(z.number()),
        actual_incremental_charge_usd: evidence(z.number()),
        actual_incremental_charge_authoritative: z.boolean(),
      })
      .strict(),
    budget: z
      .object({
        maximum_incremental_charge_usd: evidence(z.number()),
      })
      .strict(),
  })
  .strict();

const PilotExecuteInput = z
  .object({
    source_repo: z.string().min(1),
    base_sha: z.string().regex(/^[0-9a-f]{40}$/),
    real_execution_authorization: RealExecutionAuthorizationInput,
  })
  .strict();

export async function runPilotCli(options: RunPilotCliOptions): Promise<number> {
  const writeOut = options.stdout ?? ((chunk) => process.stdout.write(chunk));
  const writeErr = options.stderr ?? ((chunk) => process.stderr.write(chunk));
  const repoRoot = options.repoRoot ?? process.cwd();
  const args = options.args;

  if (!args.includes('--pilot')) {
    writeErr(`experiment: --pilot é obrigatório\n${EXPERIMENT_USAGE}`);
    return 1;
  }

  const execute = args.includes('--execute');
  const dryRun = args.includes('--dry-run') || !execute;

  if (execute && dryRun && args.includes('--dry-run')) {
    writeErr(`experiment: --dry-run e --execute são mutuamente exclusivos\n${EXPERIMENT_USAGE}`);
    return 1;
  }

  if (!execute) {
    const inspection = await inspectOfficialPilot(repoRoot);
    writeOut(formatInspection(inspection));
    return 0;
  }

  if (!args.includes('--confirm-real-inference')) {
    writeErr(
      'experiment: --execute exige --confirm-real-inference; sem isso nenhum slot real é lançado\n' +
        EXPERIMENT_USAGE,
    );
    return 1;
  }

  const input = readFlagValue(args, '--input');
  if (input === undefined) {
    writeErr(`experiment: --execute exige --input <caminho> com evidência humana\n${EXPERIMENT_USAGE}`);
    return 1;
  }

  try {
    const parsed = await readExecuteInput(input);
    const frozen = await buildPilotExperimentSpec(repoRoot);
    const quotaProbe = options.quotaProbe ?? {
      binary: 'claude',
      env: options.env ?? process.env,
      cwd: repoRoot,
    };
    let executeSlot = options.executeSlot;
    if (executeSlot === undefined) {
      const sanitizedHome = await mkdtemp(path.join(os.tmpdir(), 'agentlab-pilot-home-'));
      executeSlot = (slot) =>
        executePilotSlot(slot, {
          frozen,
          sourceRepo: parsed.source_repo,
          baseSha: parsed.base_sha,
          humanAuthorization: parsed.real_execution_authorization,
          sanitizedHome,
          ...(options.labRoot === undefined ? {} : { labRoot: options.labRoot }),
          ...(options.config === undefined ? {} : { config: options.config }),
          ...(options.env === undefined ? {} : { env: options.env }),
        });
    }
    const result = await runOfficialPilot({
      frozen,
      humanAuthorization: parsed.real_execution_authorization,
      quotaProbe,
      executeSlot,
    });

    writeOut(`experiment: stopped_by_billing_guard=${result.stoppedByBillingGuard}\n`);
    writeOut(`experiment: launches=${result.launches.length}\n`);
    writeOut(`experiment: remaining_slots=${result.remainingSlots.length}\n`);
    writeOut(`experiment: observe_quota=${result.observeQuotaKind}\n`);
    if (result.blockedDecision !== undefined) {
      writeOut(`experiment: blocked_reasons=${result.blockedDecision.reasons.join(',')}\n`);
    }
    return result.stoppedByBillingGuard ? 1 : 0;
  } catch (error) {
    writeErr(`experiment: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function formatInspection(inspection: OfficialPilotInspection): string {
  return (
    `experiment: dry-run\n` +
    `experiment: spec_id=${inspection.spec_id}\n` +
    `experiment: hash=${inspection.hash}\n` +
    `experiment: planned_slot_count=${inspection.planned_slot_count}\n` +
    `experiment: quota_stop_threshold_pct=${inspection.quota_stop_threshold_pct}\n` +
    `experiment: adapter=${inspection.adapter_name} ${inspection.execution_kind}\n` +
    `experiment: observe_quota=${inspection.observe_quota}\n` +
    `experiment: authorizes_real_inference=${inspection.authorizes_real_inference}\n` +
    `experiment: este dry-run NÃO autoriza o piloto e NÃO executa slots\n`
  );
}

interface ExecutePilotSlotOptions {
  readonly frozen: Awaited<ReturnType<typeof buildPilotExperimentSpec>>;
  readonly sourceRepo: string;
  readonly baseSha: string;
  readonly humanAuthorization: RealExecutionAuthorization;
  readonly sanitizedHome: string;
  readonly labRoot?: string;
  readonly config?: DataDirectoryConfig;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

async function executePilotSlot(
  slot: PlannedSlot,
  options: ExecutePilotSlotOptions,
): Promise<ExecutionStatus> {
  const arm = options.frozen.spec.arms.find((candidate) => candidate.id === slot.arm_id);
  if (arm === undefined) throw new Error(`arm desconhecido: ${slot.arm_id}`);
  const task = options.frozen.spec.tasks.find((candidate) => candidate.id === slot.task_id);
  if (task === undefined) throw new Error(`task desconhecida: ${slot.task_id}`);

  const trialId = (slot.retry_of ?? slot.slot_id).replace(/:/g, '-');
  const prepared = await prepareRun({
    trial: {
      id: trialId,
      task,
      agent: arm.agent_profile,
      strategy: options.frozen.spec.strategy,
      environment: options.frozen.spec.environment_profile,
      status: 'PLANNED',
    },
    baseSha: options.baseSha,
    budgets: task.budgets,
    timeoutMs: task.budgets.duration_ms.maximum,
    sourceRepo: options.sourceRepo,
    adapter: CLAUDE_ADAPTER_IDENTITY,
    ...(options.labRoot === undefined ? {} : { labRoot: options.labRoot }),
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });

  const executed = await executeRun({
    prepared,
    sanitizedHome: options.sanitizedHome,
    realExecutionAuthorization: options.humanAuthorization,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  return executed.record.status;
}

async function readExecuteInput(inputPath: string): Promise<z.infer<typeof PilotExecuteInput>> {
  let raw: string;
  try {
    raw = await readFile(inputPath, 'utf8');
  } catch (error) {
    throw new Error(`não foi possível ler --input (${inputPath}): ${errorMessage(error)}`, {
      cause: error,
    });
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`--input não é JSON válido: ${errorMessage(error)}`, { cause: error });
  }

  try {
    return PilotExecuteInput.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      const details = error.issues
        .map((issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.message}`)
        .join('; ');
      throw new Error(`entrada de experiment --execute inválida: ${details}`, { cause: error });
    }
    throw error;
  }
}

function readFlagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
