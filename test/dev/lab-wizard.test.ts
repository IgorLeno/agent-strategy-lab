import { beforeEach, describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';

import { parseRunDirective } from '../../src/intake/index.js';
import { inspectWizardProject, listRecentRuntimes, prepareNewProject } from '../../dev/lib/lab-project-selection.js';
import type { resumeHumanInstruction, submitRunDirective } from '../../dev/lib/lab.js';
import { createWizardPrompts, renderWelcome, runLabWizard, WizardCancelled, type WizardPrompts } from '../../dev/lib/lab-wizard.js';
import * as inquirer from '@inquirer/prompts';

vi.mock('../../dev/lib/lab-project-selection.js', () => ({
  inspectWizardProject: vi.fn(),
  listRecentRuntimes: vi.fn(),
  prepareNewProject: vi.fn(),
}));
vi.mock('@inquirer/prompts', () => ({ select: vi.fn(), input: vi.fn(), confirm: vi.fn(), editor: vi.fn() }));

const repo = '/work/app';
const controlRoot = '/work/agent-lab';
const runtime = '/runs/app/previous';
const project = { root: repo, name: 'app', branch: 'main', clean: true, remote: 'team/app' };
type Step = { kind: keyof WizardPrompts; value: unknown; before?: () => void };
const select = (value: unknown): Step => ({ kind: 'select', value });
const input = (value: string): Step => ({ kind: 'input', value });
const confirm = (value: boolean): Step => ({ kind: 'confirm', value });
const objective = [select('implement'), input('Add account recovery.'), select('continue')];

function fixture(steps: Step[]) {
  const messages: string[] = [];
  const choicesSeen: unknown[][] = [];
  const queue = [...steps];
  function next(kind: keyof WizardPrompts, message: string): unknown {
    messages.push(message);
    const step = queue.shift();
    expect(step, `Unexpected ${kind}: ${message}`).toBeDefined();
    expect(step!.kind).toBe(kind);
    step!.before?.();
    if (step!.value instanceof Error) throw step!.value;
    return step!.value;
  }
  const prompts: WizardPrompts = {
    async select<T>(message: string, choices: readonly { readonly name: string; readonly value: T }[]): Promise<T> {
      choicesSeen.push(choices.map((choice) => choice.value));
      const value = next('select', message) as T;
      expect(choices.map((choice) => choice.value)).toContainEqual(value);
      return value;
    },
    async input(message, options) {
      const value = next('input', message) as string;
      expect(options?.validate?.(value) ?? true).toBe(true);
      return value;
    },
    async confirm(message) { return next('confirm', message) as boolean; },
    async editor(message) { return next('editor', message) as string; },
  };
  const stderr = { write: vi.fn<(chunk: string) => void>(), columns: 80 };
  const submit = vi.fn<typeof submitRunDirective>().mockResolvedValue({ payload: {}, exitCode: 0 });
  const resume = vi.fn<typeof resumeHumanInstruction>().mockResolvedValue({ payload: {}, exitCode: 0 });
  return {
    prompts, stderr, submit, resume, messages, choicesSeen, queue,
    run: () => runLabWizard({ prompts, stderr, submit, resume, color: false, controlRoot, env: { NO_COLOR: '' } }),
    output: () => stderr.write.mock.calls.map(([chunk]) => chunk).join(''),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listRecentRuntimes).mockResolvedValue([]);
  vi.mocked(inspectWizardProject).mockResolvedValue(project);
  vi.mocked(prepareNewProject).mockResolvedValue({ ...project, root: '/work/new-app', name: 'new-app' });
});

describe('runLabWizard', () => {
  it('submits a parser-valid external directive only after Start, using input by default', async () => {
    const f = fixture([select('existing'), select('path'), input(repo), ...objective, {
      ...select('start'), before: () => expect(f.submit).not.toHaveBeenCalled(),
    }]);
    expect(await f.run()).toBe('completed');
    expect(f.queue).toHaveLength(0);
    expect(f.submit).toHaveBeenCalledOnce();
    const submitted = f.submit.mock.calls[0]![0];
    expect(submitted).toMatchObject({ repo, self: false, instruction_source: 'stdin', control_root: controlRoot });
    expect(parseRunDirective(submitted.raw_directive).header?.target).toEqual({ type: 'repository', path: repo });
    expect(f.output()).toContain('main');
    expect(f.output()).toContain('team/app');
    expect(f.output()).toContain('Add account recovery.');
    expect(f.output()).not.toContain('\x1b');
  });

  it('does not dispatch after Cancel or prompt cancellation', async () => {
    const f = fixture([select('self'), ...objective, select('cancel')]);
    expect(await f.run()).toBe('completed');
    expect(f.submit).not.toHaveBeenCalled();
    const cancelled = fixture([{ kind: 'select', value: new WizardCancelled() }]);
    await expect(cancelled.run()).rejects.toBeInstanceOf(WizardCancelled);
    expect(cancelled.submit).not.toHaveBeenCalled();
    expect(cancelled.resume).not.toHaveBeenCalled();
  });

  it('uses the canonical self target', async () => {
    const f = fixture([select('self'), ...objective, select('start')]);
    await f.run();
    expect(f.submit.mock.calls[0]![0]).toMatchObject({ self: true });
    expect(f.submit.mock.calls[0]![0]).not.toHaveProperty('repo');
    expect(parseRunDirective(f.submit.mock.calls[0]![0].raw_directive).header?.target).toEqual({ type: 'self' });
  });

  it('opens an editor only when long context is explicitly chosen and preserves its body', async () => {
    const context = 'First line\n\n```ts\nconst x = 1;\n```';
    const f = fixture([select('self'), select('fix'), input('Fix login.'), select('context'), { kind: 'editor', value: context }, select('start')]);
    await f.run();
    expect(parseRunDirective(f.submit.mock.calls[0]![0].raw_directive).body).toContain(`Fix login.\n\n${context}`);
  });

  it('shows unique recent projects and revalidates before asking for an objective', async () => {
    vi.mocked(listRecentRuntimes).mockResolvedValue([
      { runtimeDir: runtime, target: project, updatedAtMs: 3 },
      { runtimeDir: '/runs/older', target: project, updatedAtMs: 2 },
      { runtimeDir: '/runs/self', target: { type: 'self' }, updatedAtMs: 1 },
    ]);
    const f = fixture([select('existing'), select(repo), ...objective, select('start')]);
    await f.run();
    expect(f.choicesSeen[1]!.filter((value) => value === repo)).toHaveLength(1);
    expect(inspectWizardProject).toHaveBeenCalledWith({ requestedPath: repo, controlRoot });
  });

  it('explains invalid projects and returns to selection', async () => {
    vi.mocked(inspectWizardProject).mockRejectedValueOnce(new Error('O repositório possui alterações locais.'));
    const f = fixture([select('existing'), select('path'), input('/dirty'), select('back'), select('exit')]);
    await f.run();
    expect(f.output()).toContain('alterações locais');
    expect(f.submit).not.toHaveBeenCalled();
  });

  it('resumes the selected runtime without asking for a replacement objective', async () => {
    vi.mocked(listRecentRuntimes).mockResolvedValue([{ runtimeDir: runtime, target: project, updatedAtMs: 1 }]);
    const f = fixture([select('resume'), select(runtime)]);
    await f.run();
    expect(f.resume).toHaveBeenCalledWith(expect.objectContaining({ runtime_dir: runtime, on_runtime: expect.any(Function), on_summary: expect.any(Function), on_progress: expect.any(Function) }));
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.queue).toHaveLength(0);
  });

  it('allows Back from an empty resume list', async () => {
    const f = fixture([select('resume'), select('back'), select('exit')]);
    await f.run();
    expect(f.output()).toContain('Nenhuma execução');
    expect(f.resume).not.toHaveBeenCalled();
  });

  it('returns Review to project selection without dispatching the discarded objective', async () => {
    const f = fixture([select('existing'), select('path'), input(repo), ...objective, select('review'), select('back'), select('exit')]);
    await f.run();
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.queue).toHaveLength(0);
  });

  it('creates a new project only after directory, Git, and Start confirmation', async () => {
    const f = fixture([select('new'), input('new-app'), input('/work'), confirm(true), confirm(true), input('https://example.com/team/new-app.git'), ...objective, {
      ...select('start'), before: () => {
        expect(prepareNewProject).not.toHaveBeenCalled();
        expect(f.submit).not.toHaveBeenCalled();
        expect(f.output()).toContain('commit inicial vazio');
        expect(f.output()).toContain('https://example.com/team/new-app.git');
      },
    }]);
    await f.run();
    expect(prepareNewProject).toHaveBeenCalledWith({ name: 'new-app', parentDirectory: '/work', remoteUrl: 'https://example.com/team/new-app.git' });
    expect(f.submit.mock.calls[0]![0].repo).toBe('/work/new-app');
  });

  it('uses the system home directory when HOME is unavailable', async () => {
    const f = fixture([select('new'), input('new-app'), input('~'), confirm(true), confirm(true), input(''), ...objective, select('start')]);
    await f.run();
    expect(prepareNewProject).toHaveBeenCalledWith({ name: 'new-app', parentDirectory: homedir() });
  });

  it('redacts remote credentials from the summary without changing the configured URL', async () => {
    const remoteUrl = 'https://user:secret@example.com/team/new-app.git';
    const f = fixture([select('new'), input('new-app'), input('/work'), confirm(true), confirm(true), input(remoteUrl), ...objective, select('start')]);
    await f.run();
    expect(f.output()).toContain('https://example.com/team/new-app.git');
    expect(f.output()).not.toContain('secret');
    expect(prepareNewProject).toHaveBeenCalledWith({ name: 'new-app', parentDirectory: '/work', remoteUrl });
  });

  it.each(['cancel', 'review'] as const)('does not create a project on %s', async (choice) => {
    const suffix = choice === 'review' ? [input('new-app'), input('/work'), confirm(false), select('exit')] : [];
    const f = fixture([select('new'), input('new-app'), input('/work'), confirm(true), confirm(true), input(''), ...objective, select(choice), ...suffix]);
    await f.run();
    expect(prepareNewProject).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  it('explains the Git requirement and returns to new-project entry if Git is declined', async () => {
    const f = fixture([select('new'), input('new-app'), input('/work'), confirm(true), confirm(false), input('new-app'), input('/work'), confirm(false), select('exit')]);
    await f.run();
    expect(f.output()).toContain('repositório Git com um commit inicial');
    expect(prepareNewProject).not.toHaveBeenCalled();
  });

  it('surfaces preparation errors with a route back and never submits a failed project', async () => {
    vi.mocked(prepareNewProject).mockRejectedValue(new Error('Configure git config --global user.email.'));
    const f = fixture([select('new'), input('new-app'), input('/work'), confirm(true), confirm(true), input(''), ...objective, select('start'), input('new-app'), input('/work'), confirm(false), select('exit')]);
    await f.run();
    expect(f.output()).toContain('git config --global user.email');
    expect(f.submit).not.toHaveBeenCalled();
  });

  it.each(['advanced', 'exit'] as const)('handles %s without dispatch', async (choice) => {
    const f = fixture([select(choice)]);
    expect(await f.run()).toBe(choice === 'advanced' ? 'advanced' : 'completed');
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.resume).not.toHaveBeenCalled();
  });

  it('does not swallow errors from runtime dispatch', async () => {
    const f = fixture([select('self'), ...objective, select('start')]);
    f.submit.mockRejectedValue(new Error('runtime failed'));
    await expect(f.run()).rejects.toThrow('runtime failed');
  });
});

describe('prompt adapter', () => {
  it.each(['ExitPromptError', 'AbortPromptError'])('normalizes %s at the adapter boundary', async (name) => {
    vi.mocked(inquirer.select).mockRejectedValue(Object.assign(new Error('cancel'), { name }));
    await expect(createWizardPrompts().select('Choose', [])).rejects.toBeInstanceOf(WizardCancelled);
  });
  it('preserves unexpected errors', async () => {
    const error = new Error('editor missing');
    vi.mocked(inquirer.editor).mockRejectedValue(error);
    await expect(createWizardPrompts().editor('Context')).rejects.toBe(error);
  });
  it('adapts all standard prompts and their options', async () => {
    vi.mocked(inquirer.select).mockResolvedValue('one');
    vi.mocked(inquirer.input).mockResolvedValue('goal');
    vi.mocked(inquirer.confirm).mockResolvedValue(true);
    vi.mocked(inquirer.editor).mockResolvedValue('context');
    const prompts = createWizardPrompts();
    await expect(prompts.select('Choose', [{ name: 'One', value: 'one' }])).resolves.toBe('one');
    await expect(prompts.input('Goal', { default: 'goal' })).resolves.toBe('goal');
    await expect(prompts.confirm('OK?', { default: false })).resolves.toBe(true);
    await expect(prompts.editor('Context', { default: 'context' })).resolves.toBe('context');
    expect(inquirer.input).toHaveBeenCalledWith({ message: 'Goal', default: 'goal' });
  });
});

describe('renderWelcome', () => {
  it('uses a compact fallback under 60 columns', () => {
    expect(renderWelcome(59)).toContain('AGENT LAB');
    expect(renderWelcome(59)).not.toContain('|___/');
  });
  it('renders the full ASCII logo at 60 columns', () => {
    const banner = renderWelcome(60, false);
    expect(banner.split('\n').slice(0, 6)).toEqual([
      '    _                    _     _          _',
      '   / \\   __ _  ___ _ __ | |_  | |    __ _| |__',
      "  / _ \\ / _` |/ _ \\ '_ \\| __| | |   / _` | '_ \\",
      ' / ___ \\ (_| |  __/ | | | |_  | |__| (_| | |_) |',
      '/_/   \\_\\__, |\\___|_| |_|\\__| |_____|\\__,_|_.__/',
      '        |___/',
    ]);
    expect(banner).not.toMatch(/[^\x00-\x7f]/);
  });
  it('colors only on request, preserving a plain-text equivalent', () => {
    expect(renderWelcome(80, false)).not.toContain('\x1b');
    expect(renderWelcome(80, true).replace(/\x1b\[[0-9;]*m/g, '')).toBe(renderWelcome(80, false));
  });
});
