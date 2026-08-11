import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { runValidation, toValidationResult } from './exec.js';
import {
  changedFiles,
  commitExists,
  headSha,
  isWorkingTreeClean,
  parentShas,
} from './git.js';
import type { HarnessPaths } from './paths.js';
import {
  readMaintenanceRecord,
  writeMaintenanceRecord,
} from './records.js';
import {
  DEV_SCHEMA_VERSION,
  MaintenanceRecord,
  type MaintenanceCommit,
  type ValidationCommand,
  type ValidationResult,
} from './schemas.js';
import { readState, writeState } from './state.js';

export class MaintenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaintenanceError';
  }
}

export type MaintenanceValidationRunner = (
  command: ValidationCommand,
  cwd: string,
) => Promise<ValidationResult>;

export interface AdoptionInput {
  readonly paths: HarnessPaths;
  readonly reason: string;
  readonly bootstrapRange?: boolean;
  readonly maxCommits?: number;
  readonly validationRunner?: MaintenanceValidationRunner;
  readonly now?: () => string;
}

export interface AdoptionResult {
  readonly record: MaintenanceRecord;
  readonly alreadyAdopted: boolean;
}

const VALIDATION_TIMEOUT_SECONDS = 3_600;

export function adoptionValidationCommands(
  previous: string,
  adopted: string,
): ValidationCommand[] {
  return [
    { argv: ['pnpm', 'typecheck'], timeout_seconds: VALIDATION_TIMEOUT_SECONDS },
    { argv: ['pnpm', 'build'], timeout_seconds: VALIDATION_TIMEOUT_SECONDS },
    { argv: ['pnpm', 'test'], timeout_seconds: VALIDATION_TIMEOUT_SECONDS },
    {
      argv: ['git', 'diff', '--check', `${previous}..${adopted}`],
      timeout_seconds: VALIDATION_TIMEOUT_SECONDS,
    },
  ];
}

function validationCommands(previous: string, adopted: string): ValidationCommand[] {
  return adoptionValidationCommands(previous, adopted);
}

const defaultValidationRunner: MaintenanceValidationRunner = async (command, cwd) =>
  toValidationResult(await runValidation(command, { cwd }));

export function assertLinearCommitChain(
  previousAuthorizedHead: string,
  commits: readonly MaintenanceCommit[],
): void {
  let expectedParent = previousAuthorizedHead;
  for (const commit of commits) {
    if (commit.parent_sha !== expectedParent) {
      throw new MaintenanceError(
        `cadeia de manutenção inválida: parent de ${commit.sha} é ${commit.parent_sha}, esperado ${expectedParent}`,
      );
    }
    expectedParent = commit.sha;
  }
}

export function isAllowedMaintenancePath(file: string): boolean {
  if (file === 'dev/plan.yaml') return false;
  if (/^docs\/S\d+-run-real\.md$/.test(file)) return false;
  if (
    file === 'package.json' ||
    file === 'pnpm-lock.yaml' ||
    /^tsconfig[^/]*\.json$/.test(file)
  ) {
    return true;
  }
  return ['test/', 'fixtures/', 'docs/', 'dev/'].some((prefix) => file.startsWith(prefix));
}

export function assertAllowedMaintenanceFiles(files: readonly string[]): void {
  for (const file of files) {
    if (!isAllowedMaintenancePath(file)) {
      throw new MaintenanceError(`arquivo fora do escopo de manutenção: ${file}`);
    }
  }
}

function assertAllowedFiles(commits: readonly MaintenanceCommit[]): string[] {
  for (const commit of commits) {
    assertAllowedMaintenanceFiles(commit.changed_files);
  }
  return [...new Set(commits.flatMap((commit) => commit.changed_files))].sort();
}

/** Paths permitidos só para records com `adoption_kind: plan_extension`. */
export function assertPlanExtensionFiles(files: readonly string[]): void {
  if (files.length !== 1 || files[0] !== 'dev/plan.yaml') {
    throw new MaintenanceError(
      `plan_extension exige exatamente [dev/plan.yaml]; recebido: ${JSON.stringify(files)}`,
    );
  }
}

export function resolveAdoptionKind(
  record: Pick<MaintenanceRecord, 'adoption_kind'>,
): 'maintenance' | 'plan_extension' {
  return record.adoption_kind ?? 'maintenance';
}

async function maintenanceRecordFiles(paths: HarnessPaths): Promise<string[]> {
  try {
    return (await readdir(paths.maintenanceDir))
      .filter((file) => file.endsWith('.json'))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function collectCommitChain(
  paths: HarnessPaths,
  previous: string,
  adopted: string,
  bootstrapRange: boolean,
  maxCommits: number | undefined,
): Promise<MaintenanceCommit[]> {
  const maximum = bootstrapRange ? maxCommits : 1;
  if (!maximum || !Number.isInteger(maximum) || maximum < 1) {
    throw new MaintenanceError('--bootstrap-range exige --max-commits inteiro e positivo');
  }

  const reversed: MaintenanceCommit[] = [];
  let current = adopted;
  while (current !== previous) {
    if (reversed.length >= maximum) {
      const detail = bootstrapRange
        ? `faixa contém mais de ${maximum} commits (--max-commits)`
        : 'modo normal exige exatamente um commit';
      throw new MaintenanceError(detail);
    }
    const parents = await parentShas(paths.repoRoot, current);
    if (parents.length !== 1) {
      throw new MaintenanceError(
        parents.length > 1
          ? `merge commit não permitido: ${current} possui mais de um parent`
          : `commit ${current} não possui parent até a base autorizada`,
      );
    }
    reversed.push({
      sha: current,
      parent_sha: parents[0] as string,
      changed_files: await changedFiles(paths.repoRoot, current),
    });
    current = parents[0] as string;
  }

  const commits = reversed.reverse();
  if (commits.length === 0) throw new MaintenanceError('HEAD não difere da base autorizada');
  if (!bootstrapRange && commits.length !== 1) {
    throw new MaintenanceError('modo normal exige exatamente um commit');
  }
  assertLinearCommitChain(previous, commits);
  return commits;
}

async function verifyRecordedCommit(
  paths: HarnessPaths,
  commit: MaintenanceCommit,
): Promise<void> {
  if (!(await commitExists(paths.repoRoot, commit.sha))) {
    throw new MaintenanceError(`commit do MaintenanceRecord não existe: ${commit.sha}`);
  }
  const parents = await parentShas(paths.repoRoot, commit.sha);
  if (parents.length !== 1 || parents[0] !== commit.parent_sha) {
    throw new MaintenanceError(`parent do MaintenanceRecord diverge em ${commit.sha}`);
  }
  const actualFiles = await changedFiles(paths.repoRoot, commit.sha);
  if (JSON.stringify(actualFiles) !== JSON.stringify(commit.changed_files)) {
    throw new MaintenanceError(`changed_files do MaintenanceRecord diverge em ${commit.sha}`);
  }
}

export async function verifyMaintenanceRecord(
  paths: HarnessPaths,
  record: MaintenanceRecord,
): Promise<void> {
  assertLinearCommitChain(record.previous_authorized_head_sha, record.commits);
  if (record.commits.at(-1)?.sha !== record.adopted_head_sha) {
    throw new MaintenanceError('MaintenanceRecord não termina no adopted_head_sha');
  }
  const kind = resolveAdoptionKind(record);
  if (kind === 'plan_extension') {
    if (record.bootstrap_range) {
      throw new MaintenanceError('plan_extension não admite bootstrap_range');
    }
    if (record.commits.length !== 1) {
      throw new MaintenanceError('plan_extension exige exatamente um commit');
    }
    assertPlanExtensionFiles(record.changed_files);
    for (const commit of record.commits) assertPlanExtensionFiles(commit.changed_files);
  } else {
    assertAllowedFiles(record.commits);
  }
  for (const commit of record.commits) await verifyRecordedCommit(paths, commit);
}

async function readAllMaintenanceRecords(paths: HarnessPaths): Promise<MaintenanceRecord[]> {
  const records: MaintenanceRecord[] = [];
  for (const file of await maintenanceRecordFiles(paths)) {
    const sha = path.basename(file, '.json');
    const record = await readMaintenanceRecord(paths, sha);
    if (!record || record.adopted_head_sha !== sha) {
      throw new MaintenanceError(`MaintenanceRecord inválido: ${file}`);
    }
    await verifyMaintenanceRecord(paths, record);
    records.push(record);
  }
  return records;
}

/** Avança somente por records válidos que começam exatamente na base atual. */
export async function reconcileMaintenanceRecords(
  paths: HarnessPaths,
  authorizedHead: string | null,
): Promise<string | null> {
  if (authorizedHead === null) return null;
  const records = await readAllMaintenanceRecords(paths);
  let current = authorizedHead;
  const consumed = new Set<string>();
  while (true) {
    const candidates = records.filter(
      (record) =>
        !consumed.has(record.adopted_head_sha) &&
        record.previous_authorized_head_sha === current,
    );
    if (candidates.length === 0) return current;
    if (candidates.length > 1) {
      throw new MaintenanceError(`MaintenanceRecords ambíguos a partir de ${current}`);
    }
    const next = candidates[0] as MaintenanceRecord;
    consumed.add(next.adopted_head_sha);
    current = next.adopted_head_sha;
  }
}

/**
 * Cadeia de MaintenanceRecords adotados que leva `from` até `to`, na ordem de
 * adoção e já verificada contra o Git. Só existe caminho por records: um `to`
 * inalcançável significa que ninguém respondeu pela diferença entre as duas
 * bases, e a cadeia vazia é sempre recusa — não há manutenção a invocar.
 */
export async function maintenanceChainBetween(
  paths: HarnessPaths,
  from: string,
  to: string,
): Promise<MaintenanceRecord[]> {
  const records = await readAllMaintenanceRecords(paths);
  const chain: MaintenanceRecord[] = [];
  const consumed = new Set<string>();
  let current = from;
  while (current !== to) {
    const candidates = records.filter(
      (record) =>
        !consumed.has(record.adopted_head_sha) &&
        record.previous_authorized_head_sha === current,
    );
    if (candidates.length === 0) {
      throw new MaintenanceError(`nenhum MaintenanceRecord adotado liga ${from} a ${to}`);
    }
    if (candidates.length > 1) {
      throw new MaintenanceError(`MaintenanceRecords ambíguos a partir de ${current}`);
    }
    const next = candidates[0] as MaintenanceRecord;
    consumed.add(next.adopted_head_sha);
    chain.push(next);
    current = next.adopted_head_sha;
  }
  if (chain.length === 0) throw new MaintenanceError(`nenhuma manutenção adotada entre ${from} e ${to}`);
  return chain;
}

export async function adoptMaintenance(input: AdoptionInput): Promise<AdoptionResult> {
  const bootstrapRange = input.bootstrapRange ?? false;
  const reason = input.reason.trim();
  if (reason === '') throw new MaintenanceError('--reason é obrigatório');
  if (!bootstrapRange && input.maxCommits !== undefined) {
    throw new MaintenanceError('--max-commits só pode ser usado com --bootstrap-range');
  }
  if (!(await isWorkingTreeClean(input.paths.repoRoot))) {
    throw new MaintenanceError('working tree suja; adoção recusada');
  }

  const state = await readState(input.paths);
  const running = state.tasks.find((task) => task.status === 'RUNNING');
  if (running) throw new MaintenanceError(`tarefa RUNNING: ${running.id}`);
  const previous = state.authorized_head_sha;
  if (previous === null) throw new MaintenanceError('authorized_head_sha ausente');
  const adopted = await headSha(input.paths.repoRoot);
  const existing = await readMaintenanceRecord(input.paths, adopted);

  if (adopted === previous) {
    if (!existing) throw new MaintenanceError('HEAD já autorizado; nenhuma manutenção a adotar');
    await verifyMaintenanceRecord(input.paths, existing);
    return { record: existing, alreadyAdopted: true };
  }

  // Crash depois do record e antes do state: a evidência imutável vence. Não
  // reexecutar validações nem reescrever timestamps/reason; apenas concluir a
  // atualização que ficou pendente, depois de verificar o record contra Git.
  if (existing) {
    await verifyMaintenanceRecord(input.paths, existing);
    if (existing.previous_authorized_head_sha !== previous) {
      throw new MaintenanceError('MaintenanceRecord existente não começa no authorized_head_sha');
    }
    await writeState(input.paths, { ...state, authorized_head_sha: adopted });
    return { record: existing, alreadyAdopted: true };
  }

  const existingRecordFiles = await maintenanceRecordFiles(input.paths);
  if (bootstrapRange && existingRecordFiles.length > 0) {
    throw new MaintenanceError('bootstrap recusado: já existe MaintenanceRecord anterior');
  }

  const commits = await collectCommitChain(
    input.paths,
    previous,
    adopted,
    bootstrapRange,
    input.maxCommits,
  );
  const aggregate = assertAllowedFiles(commits);
  const runner = input.validationRunner ?? defaultValidationRunner;
  const validationResults: ValidationResult[] = [];
  for (const command of validationCommands(previous, adopted)) {
    const result = await runner(command, input.paths.repoRoot);
    validationResults.push(result);
    if (result.exit_code !== 0 || result.timed_out) {
      throw new MaintenanceError(`validação falhou: ${command.argv.join(' ')}`);
    }
  }
  if (!(await isWorkingTreeClean(input.paths.repoRoot))) {
    throw new MaintenanceError('working tree ficou suja durante as validações');
  }

  const record = MaintenanceRecord.parse({
    schema_version: DEV_SCHEMA_VERSION,
    previous_authorized_head_sha: previous,
    adopted_head_sha: adopted,
    commits,
    changed_files: aggregate,
    validation_results: validationResults,
    working_tree_clean: true,
    bootstrap_range: bootstrapRange,
    reason,
    adopted_at: (input.now ?? (() => new Date().toISOString()))(),
  });

  // Ordem transacional: evidence primeiro; state só avança depois do record.
  await writeMaintenanceRecord(input.paths, record);
  await writeState(input.paths, { ...state, authorized_head_sha: adopted });
  return { record, alreadyAdopted: false };
}
