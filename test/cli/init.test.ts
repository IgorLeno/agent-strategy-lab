import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { runInit } from '../../src/cli/init.js';
import { runAgentlabCli } from './helpers.js';

const execFileAsync = promisify(execFile);

const temporaryRoots: string[] = [];

async function temporaryGitRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-init-'));
  temporaryRoots.push(root);
  await execFileAsync('git', ['init', '--quiet'], { cwd: root });
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('runInit', () => {
  it('cria somente .agentlab/project.yaml no repo-alvo', async () => {
    const repo = await temporaryGitRepo();

    const result = await runInit({ repo });

    expect(result.created).toBe(true);
    expect(result.path).toBe(path.join(repo, '.agentlab', 'project.yaml'));

    const content = await readFile(result.path, 'utf8');
    expect(content).toContain('schema_version: 1');

    const entries = await readdir(repo);
    expect(entries.sort()).toEqual(['.agentlab', '.git']);

    const agentlabEntries = await readdir(path.join(repo, '.agentlab'));
    expect(agentlabEntries).toEqual(['project.yaml']);
  });

  it('rodar duas vezes não sobrescreve config existente sem force', async () => {
    const repo = await temporaryGitRepo();
    const configPath = path.join(repo, '.agentlab', 'project.yaml');

    const first = await runInit({ repo });
    expect(first.created).toBe(true);

    await writeFile(configPath, 'schema_version: 1\ndata_dir: custom\n', 'utf8');

    const second = await runInit({ repo });
    expect(second.created).toBe(false);

    const content = await readFile(configPath, 'utf8');
    expect(content).toContain('data_dir: custom');
  });

  it('com force, sobrescreve config existente', async () => {
    const repo = await temporaryGitRepo();
    const configPath = path.join(repo, '.agentlab', 'project.yaml');

    await runInit({ repo });
    await writeFile(configPath, 'schema_version: 1\ndata_dir: custom\n', 'utf8');

    const result = await runInit({ repo, force: true });
    expect(result.created).toBe(true);

    const content = await readFile(configPath, 'utf8');
    expect(content).toContain('data_dir: data');
    expect(content).not.toContain('custom');
  });
});

describe('agentlab init (processo)', () => {
  it('smoke em repo git temporário: cria o arquivo e sai com exit code 0', async () => {
    const repo = await temporaryGitRepo();

    const result = await runAgentlabCli(['init', '--repo', repo]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('criado');

    const content = await readFile(path.join(repo, '.agentlab', 'project.yaml'), 'utf8');
    expect(content).toContain('schema_version: 1');
  });

  it('sem --repo, falha com exit code 1 e mensagem acionável', async () => {
    const result = await runAgentlabCli(['init']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--repo');
  });
});
