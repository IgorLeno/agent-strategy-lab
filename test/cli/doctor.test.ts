import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createRunDirectory, finalizeExecution } from '../../src/storage/index.js';
import { runDoctor, type RunDoctorOptions } from '../../src/cli/doctor.js';
import { runAgentlabCli } from './helpers.js';

const temporaryRoots: string[] = [];

async function temporaryLabRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-doctor-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function baseOptions(labRoot: string): RunDoctorOptions {
  return {
    labRoot,
    env: {},
    agentClis: ['definitely-not-a-real-agent-cli-xyz'],
  };
}

describe('runDoctor', () => {
  it('reporta cada checagem com um status próprio', async () => {
    const labRoot = await temporaryLabRoot();
    const report = await runDoctor(baseOptions(labRoot));

    const names = report.checks.map((check) => check.name);
    expect(names).toContain('node');
    expect(names).toContain('git');
    expect(names).toContain('data-dir');
    expect(names).toContain('data-integrity');
    for (const check of report.checks) {
      expect(['PASS', 'WARN', 'FAIL']).toContain(check.status);
      expect(check.detail.length).toBeGreaterThan(0);
    }
  });

  it('marca node abaixo do mínimo como FAIL e bloqueia o relatório', async () => {
    const labRoot = await temporaryLabRoot();
    const report = await runDoctor({
      ...baseOptions(labRoot),
      nodeVersion: 'v18.0.0',
      minNodeVersion: '22.13.0',
    });

    const node = report.checks.find((check) => check.name === 'node');
    expect(node?.status).toBe('FAIL');
    expect(report.ok).toBe(false);
  });

  it('CLI de agente ausente é aviso, não erro, e não bloqueia o relatório', async () => {
    const labRoot = await temporaryLabRoot();
    const report = await runDoctor(baseOptions(labRoot));

    const agentCheck = report.checks.find(
      (check) => check.name === 'agent-cli:definitely-not-a-real-agent-cli-xyz',
    );
    expect(agentCheck?.status).toBe('WARN');
    expect(report.ok).toBe(true);
  });

  it('data dir gravável reporta PASS e cria o diretório se preciso', async () => {
    const labRoot = await temporaryLabRoot();
    const report = await runDoctor(baseOptions(labRoot));

    const dataDirCheck = report.checks.find((check) => check.name === 'data-dir');
    expect(dataDirCheck?.status).toBe('PASS');
  });

  it('data dir não gravável reporta FAIL e bloqueia o relatório', async () => {
    const labRoot = await temporaryLabRoot();
    const dataDirPath = path.join(labRoot, 'data');
    // Um arquivo no lugar do data dir garante que mkdir recursivo falhe.
    await writeFile(dataDirPath, 'não é um diretório', 'utf8');

    const report = await runDoctor(baseOptions(labRoot));

    const dataDirCheck = report.checks.find((check) => check.name === 'data-dir');
    expect(dataDirCheck?.status).toBe('FAIL');
    expect(report.ok).toBe(false);
  });

  it('sem runs no data dir, a integridade básica passa trivialmente', async () => {
    const labRoot = await temporaryLabRoot();
    const report = await runDoctor(baseOptions(labRoot));

    const integrityCheck = report.checks.find((check) => check.name === 'data-integrity');
    expect(integrityCheck?.status).toBe('PASS');
  });

  it('detecta run com integridade quebrada e reporta FAIL', async () => {
    const labRoot = await temporaryLabRoot();
    const run = await createRunDirectory({ labRoot });
    await mkdir(path.join(run.executionDir, 'changes'), { recursive: true });
    await writeFile(path.join(run.executionDir, 'execution-record.json'), '{"status":"COMPLETED"}', 'utf8');
    await writeFile(path.join(run.executionDir, 'events.jsonl'), '{"seq":1,"type":"START"}\n', 'utf8');
    await writeFile(path.join(run.executionDir, 'changes/changes.patch'), 'diff --git a/x b/x\n', 'utf8');
    await finalizeExecution(run.runDir);

    // Corrompe um artifact depois de selado — deve ser detectado pela verificação.
    await writeFile(path.join(run.executionDir, 'events.jsonl'), '{"seq":1,"type":"ADULTERADO"}\n', 'utf8');

    const report = await runDoctor(baseOptions(labRoot));

    const integrityCheck = report.checks.find((check) => check.name === 'data-integrity');
    expect(integrityCheck?.status).toBe('FAIL');
    expect(report.ok).toBe(false);
  });
});

describe('agentlab doctor (processo)', () => {
  it('roda `agentlab doctor` e sai com exit code 0 quando não há bloqueio', async () => {
    const labRoot = await temporaryLabRoot();
    const result = await runAgentlabCli(['doctor'], { AGENTLAB_DATA_DIR: path.join(labRoot, 'data') });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('[PASS] node');
    expect(result.stdout).toContain('doctor: ok');
  });

  it('comando desconhecido sai com exit code 1 e não crasha', async () => {
    const result = await runAgentlabCli(['nao-existe']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('comando desconhecido');
  });
});
