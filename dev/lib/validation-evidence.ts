import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { writeFileOnce } from './atomic.js';
import { runValidation, toValidationResult } from './exec.js';
import type { HarnessPaths } from './paths.js';
import {
  ValidationEvidence,
  type ValidationCommand,
  type ValidationResult,
} from './schemas.js';

export interface OfficialValidationExecution {
  readonly result: ValidationResult;
  readonly evidence: ValidationEvidence;
}

export interface RunOfficialValidationInput {
  readonly paths: HarnessPaths;
  readonly taskId: string;
  readonly attempt: number;
  readonly command: ValidationCommand;
  readonly env?: NodeJS.ProcessEnv;
  /** Reservado pelo transaction runner quando há um runner injetado. */
  readonly sequence?: number;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Publica um artifact uma única vez. `link` torna a criação do destino
 * atômica e recusa corrida; replay é aceito apenas quando os bytes coincidem.
 */
export async function writeValidationArtifactOnce(file: string, bytes: Buffer): Promise<void> {
  await writeFileOnce(file, bytes);
}

function attemptDirectory(paths: HarnessPaths, taskId: string, attempt: number): string {
  return path.join(paths.validationLogsDir, taskId, `attempt-${attempt}`);
}

async function nextSequence(directory: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 1;
    throw error;
  }
  let maximum = 0;
  for (const name of names) {
    const match = /^(\d+)\.(?:json|stdout\.log|stderr\.log)$/.exec(name);
    if (match?.[1]) maximum = Math.max(maximum, Number(match[1]));
  }
  return maximum + 1;
}

export async function nextValidationEvidenceSequence(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): Promise<number> {
  return nextSequence(attemptDirectory(paths, taskId, attempt));
}

function relativeToDev(paths: HarnessPaths, file: string): string {
  return path.relative(paths.devDir, file).split(path.sep).join('/');
}

export async function runOfficialValidation(
  input: RunOfficialValidationInput,
): Promise<OfficialValidationExecution> {
  const directory = attemptDirectory(input.paths, input.taskId, input.attempt);
  const sequence = input.sequence ?? (await nextSequence(directory));
  const stem = sequence.toString().padStart(4, '0');
  const stdoutFile = path.join(directory, `${stem}.stdout.log`);
  const stderrFile = path.join(directory, `${stem}.stderr.log`);
  const metadataFile = path.join(directory, `${stem}.json`);
  const outcome = await runValidation(input.command, {
    cwd: input.paths.repoRoot,
    ...(input.env === undefined ? {} : { env: input.env }),
  });
  const result = toValidationResult(outcome);
  const evidence = ValidationEvidence.parse({
    sequence,
    ...result,
    stdout_sha256: sha256(outcome.stdoutBuffer),
    stderr_sha256: sha256(outcome.stderrBuffer),
    stdout_bytes: outcome.stdoutBuffer.byteLength,
    stderr_bytes: outcome.stderrBuffer.byteLength,
    stdout_path: relativeToDev(input.paths, stdoutFile),
    stderr_path: relativeToDev(input.paths, stderrFile),
  });

  await writeValidationArtifactOnce(stdoutFile, outcome.stdoutBuffer);
  await writeValidationArtifactOnce(stderrFile, outcome.stderrBuffer);
  await writeValidationArtifactOnce(
    metadataFile,
    Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, 'utf8'),
  );
  return { result, evidence };
}
