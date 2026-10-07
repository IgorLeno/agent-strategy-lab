import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { InvocationRequest, ModelProfile } from '@asl/core';

import { Daemon } from '../src/daemon/daemon.js';
import type { DaemonEvent, LoopState, ProjectView } from '../src/shared/ipc.js';

const run = promisify(execFile);
const FAKE_AGENT = path.resolve(import.meta.dirname, '../../../packages/core/test/fixtures/fake-agent.mjs');
const CATALOG = [
  { id: 'fake-s', scaffold: 'fake', provider: 'none', model: 'fake-s', effort: null, tier: 'balanced', cost_rank: 1 },
] as unknown as readonly ModelProfile[];

let root: string;
let scriptPath: string;
let events: DaemonEvent[];
let daemon: Daemon;

async function git(cwd: string, args: string[]): Promise<string> {
  return (await run('git', args, { cwd })).stdout.trim();
}

async function makeRepo(name: string, plan: string): Promise<string> {
  const repo = path.join(root, name);
  await mkdir(path.join(repo, '.asl'), { recursive: true });
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 't@t']);
  await git(repo, ['config', 'user.name', 't']);
  await writeFile(path.join(repo, 'README.md'), 'x\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'inicial']);
  await writeFile(path.join(repo, '.asl', 'plan.md'), plan);
  return repo;
}

async function script(calls: readonly Record<string, unknown>[]): Promise<void> {
  await writeFile(scriptPath, JSON.stringify({ calls }));
}

function newDaemon(): Daemon {
  return new Daemon({
    ledgerPath: path.join(root, 'data', 'ledger.db'),
    projectsFile: path.join(root, 'data', 'projects.json'),
    sourceEnv: { PATH: process.env['PATH'] },
    catalog: CATALOG,
    invoke: (request: InvocationRequest) => ({
      argv: [process.execPath, FAKE_AGENT, request.profile.id],
      env: { PATH: process.env['PATH'] ?? '', ASL_FAKE_SCRIPT: scriptPath, ...request.extraEnv },
      stdin: request.prompt,
    }),
    emit: (event) => events.push(event),
  });
}

/** Espera o estado do projeto chegar a um dos finais (via eventos, como a UI). */
async function settle(projectId: string, states: readonly LoopState[] = ['paused', 'done', 'error']): Promise<ProjectView> {
  for (let waited = 0; waited < 20_000; waited += 25) {
    const last = events.filter((event) => event.type === 'project' && event.project.id === projectId).at(-1);
    if (last?.type === 'project' && states.includes(last.project.state)) return last.project;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`projeto ${projectId} não chegou a ${states.join('/')}`);
}

const PLAN = '# Plano: Demo\n\n## Fase 1 — Base\n- [ ] 1.1 Primeiro\n- [ ] 1.2 Segundo\n\n## Fase 2 — Fim\n- [ ] 2.1 Terceiro\n';

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'asl-daemon-'));
  scriptPath = path.join(root, 'script.json');
  events = [];
  daemon = newDaemon();
});

afterEach(async () => {
  await daemon.shutdown();
});

describe('daemon com agente fake', () => {
  it('recusa pasta que não é repositório Git', async () => {
    await mkdir(path.join(root, 'solta'));
    await expect(daemon.handle('addProject', { repo: path.join(root, 'solta') })).rejects.toThrow(/não é um repositório Git/);
  });

  it('Step a step: um step por início, transcript, plano e histórico', async () => {
    const repo = await makeRepo('a', PLAN);
    await script([{ files: { 'a.txt': '1' }, final: 'fiz 1.1', tokens: 120 }, { files: { 'b.txt': '2' }, final: 'fiz 1.2', tokens: 80 }]);
    const project = await daemon.handle('addProject', { repo });
    expect(project).toMatchObject({ name: 'a', state: 'idle', progress: { done: 0, total: 3 }, settings: { continuity: 'step' } });
    // Adicionar de novo (até por subpasta) devolve o mesmo projeto.
    expect((await daemon.handle('addProject', { repo: path.join(repo, '.asl') })).id).toBe(project.id);

    await daemon.handle('start', { projectId: project.id });
    const paused = await settle(project.id);
    expect(paused).toMatchObject({ state: 'paused', stateDetail: 'fim do step (Step a step)', progress: { done: 1, total: 3 } });

    const transcript = await daemon.handle('getTranscript', { projectId: project.id });
    expect(transcript.header).toMatchObject({ stepId: '1.1', title: 'Primeiro', tier: 'balanced', attemptNo: 1, model: 'fake-s' });
    expect(transcript.items.map((item) => item.kind)).toEqual(['attempt', 'message', 'attempt_finished']);

    const plan = await daemon.handle('getPlan', { projectId: project.id });
    expect(plan.plan?.steps.map((step) => `${step.id}:${step.state}`)).toEqual(['1.1:done', '1.2:pending', '2.1:pending']);
    expect(plan.plan?.path).toBe(path.join(repo, '.asl', 'plan.md'));

    const history = await daemon.handle('getHistory', { projectId: project.id });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ stepId: '1.1', status: 'done', tokensTotal: 120, model: 'fake-s', attempts: 1 });
    expect(history[0]?.commitSha).toBe(await git(repo, ['rev-parse', 'HEAD']));

    await daemon.handle('start', { projectId: project.id });
    expect(await settle(project.id)).toMatchObject({ state: 'paused', progress: { done: 2, total: 3 } });
    expect(await git(repo, ['log', '--format=%s'])).toBe('1.2: Segundo\n1.1: Primeiro\nasl: plano demo\ninicial');
  });

  it('continuidade e modo trocam com o loop rodando; Git mode não', async () => {
    const repo = await makeRepo('b', PLAN);
    await script([{ files: { 'a.txt': '1' }, sleepMs: 600 }, { files: { 'b.txt': '2' } }, { files: { 'c.txt': '3' } }]);
    const { id } = await daemon.handle('addProject', { repo });
    await daemon.handle('start', { projectId: id });
    await expect(daemon.handle('updateSettings', { projectId: id, patch: { gitMode: 'direct' } })).rejects.toThrow(/loop parado/);
    await expect(daemon.handle('updateSettings', { projectId: id, patch: { mode: 'yolo' } })).rejects.toThrow(/mode deve ser/);
    await daemon.handle('updateSettings', { projectId: id, patch: { continuity: 'phase', mode: 'auto' } });
    // Por fase: para na fronteira entre a Fase 1 e a Fase 2.
    expect(await settle(id)).toMatchObject({ state: 'paused', progress: { done: 2, total: 3 } });
    expect((await settle(id)).stateDetail).toMatch(/^fim da fase \(Por fase\): Fase 2/);
  });

  it('Pausar termina o step corrente e para', async () => {
    const repo = await makeRepo('c', PLAN);
    await script([{ files: { 'a.txt': '1' }, sleepMs: 600 }, { files: { 'b.txt': '2' } }]);
    const { id } = await daemon.handle('addProject', { repo });
    await daemon.handle('updateSettings', { projectId: id, patch: { continuity: 'continuous' } });
    await daemon.handle('start', { projectId: id });
    // Pausa só depois que o step começou; pedida antes, o loop para sem rodar nada.
    while (!events.some((event) => event.type === 'step_header')) await new Promise((resolve) => setTimeout(resolve, 10));
    await daemon.handle('pause', { projectId: id });
    expect(events.some((event) => event.type === 'project' && event.project.state === 'pausing')).toBe(true);
    expect(await settle(id)).toMatchObject({ state: 'paused', stateDetail: 'pausa pedida', progress: { done: 1, total: 3 } });
  });

  it('gate vermelho esgota retries: step [!], motivo visível', async () => {
    const repo = await makeRepo('d', PLAN);
    await script([{ files: { 'a.txt': '1' } }, { files: { 'a.txt': '2' } }]);
    const { id } = await daemon.handle('addProject', { repo });
    await daemon.handle('updateSettings', { projectId: id, patch: { gateCommand: 'exit 3', maxRetries: 1 } });
    await daemon.handle('start', { projectId: id });
    const paused = await settle(id);
    expect(paused.stateDetail).toMatch(/^step falhou depois dos retries: gate `exit 3` falhou/);
    const plan = await daemon.handle('getPlan', { projectId: id });
    expect(plan.plan?.steps[0]?.state).toBe('failed');
    const history = await daemon.handle('getHistory', { projectId: id });
    expect(history[0]).toMatchObject({ status: 'failed', attempts: 2 });
  });

  it('pré-condição quebrada (árvore suja) vira estado de erro com o motivo', async () => {
    const repo = await makeRepo('e', PLAN);
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-q', '-m', 'plano']);
    await writeFile(path.join(repo, 'README.md'), 'sujo\n');
    const { id } = await daemon.handle('addProject', { repo });
    await daemon.handle('start', { projectId: id });
    const failed = await settle(id);
    expect(failed.state).toBe('error');
    expect(failed.stateDetail).not.toBeNull();
  });

  it('dois projetos rodam ao mesmo tempo', async () => {
    const plan = '# Plano: Par\n- [ ] 1 Único\n';
    const [first, second] = [await makeRepo('p1', plan), await makeRepo('p2', plan)];
    await script([{ files: { 'x.txt': '1' }, sleepMs: 300 }, { files: { 'x.txt': '1' }, sleepMs: 300 }]);
    const a = await daemon.handle('addProject', { repo: first });
    const b = await daemon.handle('addProject', { repo: second });
    await daemon.handle('start', { projectId: a.id });
    await daemon.handle('start', { projectId: b.id });
    const states = (await daemon.handle('listProjects', {})).map((project) => project.state);
    expect(states).toEqual(['running', 'running']);
    expect((await settle(a.id)).state).toBe('done');
    expect((await settle(b.id)).state).toBe('done');
  });

  it('projetos e configuração sobrevivem a reinício do daemon', async () => {
    const repo = await makeRepo('f', PLAN);
    const { id } = await daemon.handle('addProject', { repo });
    await daemon.handle('updateSettings', { projectId: id, patch: { gateCommand: 'true', allowedCommands: ['npm test', ' '] } });
    await daemon.shutdown();
    daemon = newDaemon();
    const [project] = await daemon.handle('listProjects', {});
    expect(project).toMatchObject({ id, settings: { gateCommand: 'true', allowedCommands: ['npm test'] } });
    expect(JSON.parse(await readFile(path.join(root, 'data', 'projects.json'), 'utf8')).projects).toHaveLength(1);
  });

  it('fechar o app no meio de um step deixa o step interrompido', async () => {
    const repo = await makeRepo('g', PLAN);
    await script([{ files: { 'a.txt': '1' }, sleepMs: 5_000 }]);
    const { id } = await daemon.handle('addProject', { repo });
    await daemon.handle('start', { projectId: id });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await daemon.shutdown();
    daemon = newDaemon();
    const history = await daemon.handle('getHistory', { projectId: id });
    expect(history[0]).toMatchObject({ stepId: '1.1', status: 'interrupted' });
  });
});
