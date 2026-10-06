import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { InvocationRequest } from '../../src/adapters/invocation.js';
import { buildCatalog } from '../../src/catalog/catalog.js';
import { git } from '../../src/git/git.js';
import { Ledger } from '../../src/ledger/ledger.js';
import { PlanLoop, type LoopEvent, type LoopOptions } from '../../src/loop/loop.js';
import { parsePlan } from '../../src/plan/plan.js';

const FAKE_AGENT = path.join(import.meta.dirname, '..', 'fixtures', 'fake-agent.mjs');
const PLAN_REL = '.asl/plan.md';
const GATE = 'test ! -f broken';

const CATALOG = buildCatalog([
  { id: 'fake-a', scaffold: 'fake', provider: 'none', model: 'fake-a', effort: null, tier: 'standard', cost_rank: 1 },
  { id: 'fake-b', scaffold: 'fake', provider: 'none', model: 'fake-b', effort: null, tier: 'standard', cost_rank: 2 },
  { id: 'fake-c', scaffold: 'fake', provider: 'none', model: 'fake-c', effort: null, tier: 'economy', cost_rank: 1 },
]);

const PLAN = [
  '# Plano: Fake',
  '',
  '## Fase 1',
  '- [ ] 1.1 Primeiro',
  '- [ ] 1.2 [economy] Segundo',
  '',
  '## Fase 2',
  '- [ ] 2.1 Terceiro',
  '- [ ] 2.2 Quarto',
  '',
].join('\n');

let root: string;
let repo: string;
let scriptPath: string;
let ledger: Ledger | null = null;

async function teardown(): Promise<void> {
  if (ledger === null) return;
  ledger.close();
  ledger = null;
  await rm(root, { recursive: true, force: true });
}

async function setup(plan = PLAN): Promise<void> {
  await teardown();
  root = await mkdtemp(path.join(os.tmpdir(), 'asl-loop-'));
  repo = path.join(root, 'repo');
  await mkdir(repo);
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'teste@example.com']);
  await git(repo, ['config', 'user.name', 'Teste']);
  await writeFile(path.join(repo, 'README.md'), 'oi\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'inicial']);
  await mkdir(path.join(repo, '.asl'));
  await writeFile(path.join(repo, PLAN_REL), plan);
  scriptPath = path.join(root, 'script.json');
  ledger = new Ledger(':memory:');
}

async function script(calls: readonly Record<string, unknown>[]): Promise<void> {
  await writeFile(scriptPath, JSON.stringify({ calls }));
}

function fakeInvoke(request: InvocationRequest) {
  return {
    argv: [process.execPath, FAKE_AGENT, request.profile.id],
    env: { PATH: process.env['PATH'] ?? '', ASL_FAKE_SCRIPT: scriptPath, ...request.extraEnv },
    stdin: request.prompt,
  };
}

function loop(overrides: Partial<LoopOptions> = {}, events: LoopEvent[] = []): PlanLoop {
  return new PlanLoop({
    repo,
    planRelPath: PLAN_REL,
    gitMode: 'branch',
    mode: 'edit',
    continuity: 'continuous',
    catalog: CATALOG,
    ledger: db(),
    gateCommand: GATE,
    allowedCommands: [],
    maxRetries: 2,
    sourceEnv: { PATH: process.env['PATH'] },
    invoke: fakeInvoke,
    onEvent: (event) => events.push(event),
    ...overrides,
  });
}

async function prompts(): Promise<string[]> {
  const dir = `${scriptPath}.prompts`;
  const files = (await readdir(dir)).sort((left, right) => Number.parseInt(left) - Number.parseInt(right));
  return Promise.all(files.map((file) => readFile(path.join(dir, file), 'utf8')));
}

async function subjects(): Promise<string[]> {
  return (await git(repo, ['log', '--format=%s', 'main..HEAD'])).trim().split('\n').reverse();
}

async function planStatuses(): Promise<string[]> {
  return parsePlan(await readFile(path.join(repo, PLAN_REL), 'utf8')).steps.map((step) => `${step.id}:${step.status}`);
}

beforeEach(async () => {
  await setup();
});

afterEach(teardown);

function db(): Ledger {
  if (ledger === null) throw new Error('ledger não inicializado');
  return ledger;
}

describe('loop com agente falso', () => {
  it('2 fases / 4 steps até o fim; gate vermelho na 1ª tentativa do 1.2 vira retry com o erro', async () => {
    await script([
      { files: { 'a.txt': '1\n' }, final: 'criei a.txt', tokens: 11 },
      { files: { broken: 'x' }, final: 'tentei' },
      { files: { broken: null, 'b.txt': '2\n' }, final: 'corrigi', tokens: 7 },
      { files: { 'c.txt': '3\n' }, final: 'c' },
      { files: { 'd.txt': '4\n' }, final: 'd' },
    ]);
    const result = await loop().run();
    expect(result).toEqual({ status: 'done' });
    expect(await planStatuses()).toEqual(['1.1:done', '1.2:done', '2.1:done', '2.2:done']);
    expect(await subjects()).toEqual(['asl: plano fake', '1.1: Primeiro', '1.2: Segundo', '2.1: Terceiro', '2.2: Quarto']);
    expect((await git(repo, ['status', '--porcelain'])).trim()).toBe('');

    const plan = db().plans()[0];
    expect(plan?.status).toBe('done');
    const steps = db().stepsOf(plan?.id ?? -1);
    expect(steps.map((step) => step.status)).toEqual(['done', 'done', 'done', 'done']);
    const second = steps[1];
    expect(db().attemptsOf(second?.id ?? -1).map((attempt) => [attempt.attempt_no, attempt.outcome, attempt.profile_id])).toEqual([
      [1, 'gate_failed', 'fake-c'],
      [2, 'success', 'fake-c'],
    ]);
    expect(db().attemptsOf(steps[0]?.id ?? -1)[0]?.tokens_total).toBe(11);

    const sent = await prompts();
    expect(sent[1]).toContain('# Nota do step anterior\n\ncriei a.txt');
    expect(sent[2]).toContain('A tentativa anterior deste step falhou');
    expect(sent[2]).toContain('test ! -f broken');
    // O diff do handoff acumula o trabalho dos steps anteriores.
    expect(sent[3]).toContain('b.txt');
  });

  it('retries esgotados: step vira [!], loop pausa e nada do step é commitado', async () => {
    await script([
      { files: { broken: 'x' } },
      { files: { broken: 'x' } },
    ]);
    const result = await loop({ maxRetries: 1 }).run();
    expect(result).toMatchObject({ status: 'paused', reason: 'step_failed' });
    expect(await planStatuses()).toEqual(['1.1:failed', '1.2:pending', '2.1:pending', '2.2:pending']);
    expect(await subjects()).toEqual(['asl: plano fake']);
    expect(existsSync(path.join(repo, 'broken'))).toBe(true);
    const step = db().stepsOf(db().plans()[0]?.id ?? -1)[0];
    expect(step?.status).toBe('failed');
    expect(db().attemptsOf(step?.id ?? -1)).toHaveLength(2);
  });

  it('retomar com [!] pede decisão; trocar para [ ] refaz a partir da árvore suja', async () => {
    await script([{ files: { broken: 'x' } }, { files: { broken: null, 'a.txt': 'ok\n' }, final: 'ok' }]);
    await loop({ maxRetries: 0 }).run();
    const again = await loop({ maxRetries: 0 }).run();
    expect(again).toMatchObject({ status: 'paused', reason: 'failed_step_in_plan' });

    const planPath = path.join(repo, PLAN_REL);
    await writeFile(planPath, (await readFile(planPath, 'utf8')).replace('- [!] 1.1', '- [ ] 1.1'));
    const resumed = await loop({ maxRetries: 0, continuity: 'step' }).run();
    expect(resumed).toMatchObject({ status: 'paused', reason: 'step_boundary' });
    expect(await planStatuses()).toEqual(['1.1:done', '1.2:pending', '2.1:pending', '2.2:pending']);
    expect((await subjects()).at(-1)).toBe('1.1: Primeiro');
  });

  it('falha de provider troca de perfil no mesmo tier sem gastar retry', async () => {
    await setup('# Plano: P\n- [ ] 1 Único\n');
    await script([{ providerFailure: 'limite atingido' }, { files: { 'a.txt': 'x' }, final: 'ok' }]);
    const result = await loop({ maxRetries: 0 }).run();
    expect(result).toEqual({ status: 'done' });
    const step = db().stepsOf(db().plans()[0]?.id ?? -1)[0];
    expect(db().attemptsOf(step?.id ?? -1).map((attempt) => [attempt.profile_id, attempt.outcome])).toEqual([
      ['fake-a', 'provider_failed'],
      ['fake-b', 'success'],
    ]);
  });

  it('tier sem perfil disponível pausa sem marcar o step como falho', async () => {
    await setup('# Plano: P\n- [ ] 1 [economy] Único\n');
    await script([{ providerFailure: 'fora do ar' }]);
    const result = await loop().run();
    expect(result).toMatchObject({ status: 'paused', reason: 'no_profile_available' });
    expect(await planStatuses()).toEqual(['1:pending']);
  });

  it('continuidade por fase pausa na troca de fase; pausa pedida termina o step corrente', async () => {
    await script([{ final: '1' }, { final: '2' }, { final: '3' }, { final: '4' }]);
    const byPhase = await loop({ continuity: 'phase' }).run();
    expect(byPhase).toMatchObject({ status: 'paused', reason: 'phase_boundary', detail: 'Fase 2' });
    expect(await planStatuses()).toEqual(['1.1:done', '1.2:done', '2.1:pending', '2.2:pending']);

    const events: LoopEvent[] = [];
    const running = loop({}, events);
    const originalEmit = events.push.bind(events);
    events.push = (...items: LoopEvent[]) => {
      if (items.some((item) => item.type === 'attempt_started')) running.requestPause();
      return originalEmit(...items);
    };
    const paused = await running.run();
    expect(paused).toMatchObject({ status: 'paused', reason: 'requested' });
    expect(await planStatuses()).toEqual(['1.1:done', '1.2:done', '2.1:done', '2.2:pending']);
  });

  it('transcript ao vivo e tag de processo por tentativa', async () => {
    await setup('# Plano: P\n- [ ] 1 Único\n');
    await script([{ final: 'ok' }]);
    const events: LoopEvent[] = [];
    await loop({}, events).run();
    const lines = events.filter((event) => event.type === 'transcript');
    expect(lines.length).toBeGreaterThan(0);
    const [first] = await prompts();
    expect(first).toMatch(/^profile=fake-a\ntag=\d+:1:1:[0-9a-f-]{36}\n/);
  });
});
