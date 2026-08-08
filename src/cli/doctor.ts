/**
 * Lógica do `agentlab doctor`: cada checagem é independente e nunca lança —
 * uma ausência (git, CLI de agente, data dir) vira um `DoctorCheck` com
 * status próprio, para que uma checagem quebrada não esconda as outras.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resolveDataDir, type DataDirectoryConfig } from '../project/index.js';
import { verifyRunIntegrity } from '../storage/integrity.js';

export type DoctorStatus = 'PASS' | 'WARN' | 'FAIL';

export interface DoctorCheck {
  readonly name: string;
  readonly status: DoctorStatus;
  readonly detail: string;
}

export interface DoctorReport {
  /** false quando pelo menos uma checagem é FAIL — WARN nunca bloqueia. */
  readonly ok: boolean;
  readonly checks: readonly DoctorCheck[];
}

export interface RunDoctorOptions {
  readonly labRoot?: string;
  readonly config?: DataDirectoryConfig;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly nodeVersion?: string;
  readonly minNodeVersion?: string;
  /** CLIs de agente a sondar; ausência de qualquer uma é aviso, não erro. */
  readonly agentClis?: readonly string[];
}

const DEFAULT_MIN_NODE_VERSION = '22.13.0';
const DEFAULT_AGENT_CLIS: readonly string[] = ['claude', 'codex'];

export async function runDoctor(options: RunDoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  checks.push(
    checkNodeVersion(options.nodeVersion ?? process.version, options.minNodeVersion ?? DEFAULT_MIN_NODE_VERSION),
  );
  checks.push(await checkGit());

  for (const cli of options.agentClis ?? DEFAULT_AGENT_CLIS) {
    checks.push(await checkAgentCli(cli));
  }

  const dataDir = resolveDataDir({
    ...(options.labRoot === undefined ? {} : { labRoot: options.labRoot }),
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  checks.push(await checkDataDirWritable(dataDir));
  checks.push(await checkDataIntegrity(dataDir));

  const ok = checks.every((check) => check.status !== 'FAIL');
  return { ok, checks };
}

function checkNodeVersion(rawVersion: string, minVersion: string): DoctorCheck {
  const current = parseVersion(rawVersion);
  const minimum = parseVersion(minVersion);
  if (current === null) {
    return { name: 'node', status: 'FAIL', detail: `versão de node ilegível: ${rawVersion}` };
  }
  if (compareVersions(current, minimum!) < 0) {
    return {
      name: 'node',
      status: 'FAIL',
      detail: `node ${rawVersion} abaixo do mínimo exigido (${minVersion})`,
    };
  }
  return { name: 'node', status: 'PASS', detail: `node ${rawVersion}` };
}

function parseVersion(value: string): readonly [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    const diff = a[index]! - b[index]!;
    if (diff !== 0) return diff;
  }
  return 0;
}

async function checkGit(): Promise<DoctorCheck> {
  const result = await probeBinary('git', ['--version']);
  if (!result.found) {
    return { name: 'git', status: 'FAIL', detail: 'git não encontrado no PATH' };
  }
  return { name: 'git', status: 'PASS', detail: result.output.trim() || 'git disponível' };
}

async function checkAgentCli(cliName: string): Promise<DoctorCheck> {
  const result = await probeBinary(cliName, ['--version']);
  if (!result.found) {
    return {
      name: `agent-cli:${cliName}`,
      status: 'WARN',
      detail: `CLI de agente "${cliName}" não encontrada no PATH`,
    };
  }
  return { name: `agent-cli:${cliName}`, status: 'PASS', detail: result.output.trim() || `${cliName} disponível` };
}

function probeBinary(
  command: string,
  args: readonly string[],
): Promise<{ found: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.on('error', () => resolve({ found: false, output: '' }));
    child.on('close', () => resolve({ found: true, output }));
  });
}

async function checkDataDirWritable(dataDir: string): Promise<DoctorCheck> {
  try {
    await mkdir(dataDir, { recursive: true });
    const probeDir = await mkdtemp(path.join(dataDir, '.doctor-probe-'));
    const probeFile = path.join(probeDir, 'probe.txt');
    await writeFile(probeFile, 'ok', 'utf8');
    await rm(probeDir, { recursive: true, force: true });
    return { name: 'data-dir', status: 'PASS', detail: `gravável: ${dataDir}` };
  } catch (error) {
    return {
      name: 'data-dir',
      status: 'FAIL',
      detail: `não gravável (${dataDir}): ${errorMessage(error)}`,
    };
  }
}

async function checkDataIntegrity(dataDir: string): Promise<DoctorCheck> {
  const runsDir = path.join(dataDir, 'runs');
  let entries;
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { name: 'data-integrity', status: 'PASS', detail: 'nenhum run para verificar' };
    }
    return {
      name: 'data-integrity',
      status: 'FAIL',
      detail: `falha ao listar runs (${runsDir}): ${errorMessage(error)}`,
    };
  }

  const runIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (runIds.length === 0) {
    return { name: 'data-integrity', status: 'PASS', detail: 'nenhum run para verificar' };
  }

  const brokenRunIds: string[] = [];
  for (const runId of runIds) {
    const report = await verifyRunIntegrity(path.join(runsDir, runId));
    if (!report.ok) brokenRunIds.push(runId);
  }

  if (brokenRunIds.length > 0) {
    return {
      name: 'data-integrity',
      status: 'FAIL',
      detail: `runs com violação de integridade: ${brokenRunIds.join(', ')}`,
    };
  }
  return { name: 'data-integrity', status: 'PASS', detail: `${runIds.length} run(s) íntegro(s)` };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
