import path from 'node:path';
import { homedir } from 'node:os';

import { confirm, editor, input, select } from '@inquirer/prompts';

import { formatRunSummary, type LabRunResult, type resumeHumanInstruction, type submitRunDirective } from './lab.js';
import { createProgressRenderer } from './lab-progress.js';
import {
  inspectWizardProject,
  listRecentRuntimes,
  prepareNewProject,
  type ProjectChoice,
} from './lab-project-selection.js';
import { buildWizardRunDirective, type WizardAction, type WizardTarget } from './lab-wizard-directive.js';
import { resolveHarnessInstallationRoot } from './paths.js';

export interface WizardPrompts {
  select<T>(message: string, choices: readonly { readonly name: string; readonly value: T }[]): Promise<T>;
  input(message: string, options?: { readonly default?: string; readonly validate?: (value: string) => true | string }): Promise<string>;
  confirm(message: string, options?: { readonly default?: boolean }): Promise<boolean>;
  editor(message: string, options?: { readonly default?: string }): Promise<string>;
}

export class WizardCancelled extends Error {
  constructor() {
    super('Operação cancelada.');
    this.name = 'WizardCancelled';
  }
}

export type WizardResult = 'completed' | 'advanced' | LabRunResult;
type PrimaryChoice = 'existing' | 'new' | 'resume' | 'self' | 'advanced' | 'exit';
type SummaryChoice = 'start' | 'review' | 'cancel';

async function promptResult<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Error && (error.name === 'ExitPromptError' || error.name === 'AbortPromptError')) {
      throw new WizardCancelled();
    }
    throw error;
  }
}

/** Keep library cancellation semantics at the terminal adapter boundary. */
export function createWizardPrompts(): WizardPrompts {
  return {
    select: (message, choices) => promptResult(() => select({ message, choices: [...choices] })),
    input: (message, options) => promptResult(() => input({ message, ...options })),
    confirm: (message, options) => promptResult(() => confirm({ message, ...options })),
    editor: (message, options) => promptResult(() => editor({ message, ...options })),
  };
}

function paint(text: string, color: boolean): string {
  return color ? `\x1b[36m${text}\x1b[0m` : text;
}

function redactRemoteUrl(remoteUrl: string): string {
  return remoteUrl.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
}

export function renderWelcome(columns = 80, color = false): string {
  const logo = columns < 60 ? 'AGENT LAB' : [
    '    _                    _     _          _',
    '   / \\   __ _  ___ _ __ | |_  | |    __ _| |__',
    "  / _ \\ / _` |/ _ \\ '_ \\| __| | |   / _` | '_ \\",
    ' / ___ \\ (_| |  __/ | | | |_  | |__| (_| | |_) |',
    '/_/   \\_\\__, |\\___|_| |_|\\__| |_____|\\__,_|_.__/',
    '        |___/',
  ].join('\n');
  return `${paint(logo, color)}\n\nPlaneje, implemente e revise projetos com agentes.\n`;
}

const actions: readonly { readonly name: string; readonly value: WizardAction }[] = [
  { name: 'Implementar funcionalidade', value: 'implement' },
  { name: 'Corrigir problema', value: 'fix' },
  { name: 'Refatorar', value: 'refactor' },
  { name: 'Investigar ou auditar', value: 'investigate' },
  { name: 'Continuar plano', value: 'continue-plan' },
  { name: 'Executar validação', value: 'validate' },
  { name: 'Outra atividade', value: 'other' },
];

function required(value: string): true | string {
  return value.trim().length > 0 || 'Preencha este campo para continuar.';
}

function projectName(value: string): true | string {
  return (value.trim() === value && value.length > 0 && value !== '.' && value !== '..' && !/[\\/]/.test(value))
    || 'Informe um nome de projeto sem barras, diferente de . e ..';
}

async function collectObjective(prompts: WizardPrompts): Promise<{ action: WizardAction; objective: string }> {
  const action = await prompts.select('Qual atividade deseja realizar?', actions);
  const objective = await prompts.input('Descreva o objetivo:', { validate: required });
  const contextChoice = await prompts.select<'continue' | 'context'>('Deseja adicionar mais detalhes?', [
    { name: 'Continuar para o resumo', value: 'continue' },
    { name: 'Adicionar contexto longo (abrir editor)', value: 'context' },
  ]);
  if (contextChoice === 'continue') return { action, objective };
  const context = await prompts.editor('Escreva o contexto adicional:');
  return { action, objective: context.trim().length > 0 ? `${objective}\n\n${context}` : objective };
}

export async function runLabWizard(input: {
  readonly prompts: WizardPrompts;
  readonly stderr: { write(chunk: string): void; columns?: number };
  readonly color: boolean;
  readonly submit: typeof submitRunDirective;
  readonly resume: typeof resumeHumanInstruction;
  readonly controlRoot?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): Promise<WizardResult> {
  const { prompts } = input;
  const controlRoot = input.controlRoot ?? resolveHarnessInstallationRoot();
  const env = input.env ?? process.env;
  const color = input.color && env['NO_COLOR'] === undefined;
  const write = (chunk: string): void => input.stderr.write(chunk);
  const describeError = (error: unknown): void => {
    write(`${error instanceof Error ? error.message : String(error)}\n`);
  };
  const recentInput = { controlRoot, env };
  const dispatchOptions = () => ({
    control_root: controlRoot,
    env,
    on_runtime: (dir: string): void => write(`runtime: ${dir}\n`),
    on_summary: (summary: Parameters<typeof formatRunSummary>[0]): void => write(`${formatRunSummary(summary)}\n`),
    on_progress: createProgressRenderer(write),
  });

  async function chooseExisting(): Promise<ProjectChoice | null> {
    while (true) {
      const recent = await listRecentRuntimes(recentInput);
      const projects = new Map<string, ProjectChoice>();
      for (const run of recent) {
        if ('root' in run.target && !projects.has(run.target.root)) projects.set(run.target.root, run.target);
      }
      const choice = await prompts.select('Escolha um projeto:', [
        ...Array.from(projects.values(), (project) => ({ name: `${project.name} — ${project.root}`, value: project.root })),
        { name: 'Informar caminho local', value: 'path' },
        { name: 'Voltar', value: 'back' },
      ]);
      if (choice === 'back') return null;
      const requestedPath = choice === 'path'
        ? await prompts.input('Caminho do projeto:', { validate: required })
        : choice;
      try {
        return await inspectWizardProject({ requestedPath, controlRoot });
      } catch (error) {
        describeError(error);
      }
    }
  }

  async function reviewSummary(input: {
    readonly target: WizardTarget;
    readonly project?: ProjectChoice;
    readonly action: WizardAction;
    readonly objective: string;
    readonly pending?: { readonly remoteUrl: string };
  }): Promise<SummaryChoice> {
    const project = input.project;
    write(`\n${paint('Resumo da execução', color)}\n`);
    write(`Projeto: ${project?.name ?? 'Agent Strategy Lab'}\n`);
    write(`Caminho: ${input.target.type === 'repository' ? input.target.path : controlRoot}\n`);
    write(`Branch: ${input.pending ? 'main (será criada)' : project?.branch ?? 'definida pelo runtime ao iniciar'}\n`);
    write(`Estado Git: ${input.pending ? 'repositório novo, sem alterações pendentes' : project ? (project.clean ? 'limpo' : 'alterações locais') : 'verificado pelo runtime ao iniciar'}\n`);
    const remote = input.pending ? redactRemoteUrl(input.pending.remoteUrl) : project?.remote;
    write(`Remote: ${remote || 'não informado'}\n`);
    write(`Atividade: ${actions.find((action) => action.value === input.action)!.name}\n`);
    // The objective remains plain text; terminal styling never enters the directive.
    write(`Objetivo:\n${input.objective}\n`);
    if (input.pending) {
      write('Ao iniciar: criar diretório, inicializar Git na branch main e criar um commit inicial vazio.\n');
      if (input.pending.remoteUrl) write('Configurar o remote origin localmente com a URL acima, sem conexão ao servidor.\n');
    }
    return prompts.select<SummaryChoice>('Como deseja continuar?', [
      { name: 'Iniciar', value: 'start' },
      { name: 'Revisar', value: 'review' },
      { name: 'Cancelar', value: 'cancel' },
    ]);
  }

  async function submit(target: WizardTarget, action: WizardAction, objective: string): Promise<LabRunResult> {
    return input.submit({
      raw_directive: buildWizardRunDirective({ target, action, objective }),
      instruction_source: 'stdin',
      self: target.type === 'self',
      ...(target.type === 'repository' ? { repo: target.path } : {}),
      ...dispatchOptions(),
    });
  }

  async function newProject(): Promise<'back' | 'completed' | LabRunResult> {
    while (true) {
      const name = await prompts.input('Nome do novo projeto:', { validate: projectName });
      const parent = await prompts.input('Diretório pai:', { default: process.cwd(), validate: required });
      const home = env['HOME']?.trim() || homedir();
      const expanded = parent === '~' ? home : parent.startsWith('~/') ? path.join(home, parent.slice(2)) : parent;
      const parentDirectory = path.resolve(expanded);
      const root = path.join(parentDirectory, name);
      if (!await prompts.confirm(`Criar o diretório ${root} ao iniciar?`, { default: false })) return 'back';
      if (!await prompts.confirm('Inicializar Git e criar um commit inicial vazio ao iniciar?', { default: true })) {
        write('Para executar um projeto, o Agent Lab precisa de um repositório Git com um commit inicial.\n');
        continue;
      }
      const remoteUrl = (await prompts.input('URL do remote origin (opcional):')).trim();
      const { action, objective } = await collectObjective(prompts);
      const target: WizardTarget = { type: 'repository', path: root };
      // Validate the request before presenting any destructive-or-runtime choice.
      buildWizardRunDirective({ target, action, objective });
      const decision = await reviewSummary({
        target, project: { root, name, branch: 'main', clean: true, remote: null }, action, objective, pending: { remoteUrl },
      });
      if (decision === 'cancel') return 'completed';
      if (decision === 'review') continue;
      let prepared: ProjectChoice;
      try {
        prepared = await prepareNewProject({ parentDirectory, name, ...(remoteUrl ? { remoteUrl } : {}) });
      } catch (error) {
        describeError(error);
        continue;
      }
      return submit({ type: 'repository', path: prepared.root }, action, objective);
    }
  }

  write(renderWelcome(input.stderr.columns, color));
  while (true) {
    const choice = await prompts.select<PrimaryChoice>('O que deseja fazer?', [
      { name: 'Trabalhar em projeto existente', value: 'existing' },
      { name: 'Criar novo projeto', value: 'new' },
      { name: 'Continuar uma execução anterior', value: 'resume' },
      { name: 'Trabalhar no Agent Strategy Lab', value: 'self' },
      { name: 'Modo avançado', value: 'advanced' },
      { name: 'Sair', value: 'exit' },
    ]);
    if (choice === 'advanced') return 'advanced';
    if (choice === 'exit') return 'completed';
    if (choice === 'new') {
      const newProjectResult = await newProject();
      if (newProjectResult === 'completed') return 'completed';
      if (newProjectResult !== 'back') return newProjectResult;
      continue;
    }
    if (choice === 'resume') {
      const recent = await listRecentRuntimes(recentInput);
      if (recent.length === 0) write('Nenhuma execução válida encontrada.\n');
      const runtime = await prompts.select('Escolha a execução para continuar:', [
        ...recent.map((run) => ({
          name: `${'root' in run.target ? run.target.name : 'Agent Strategy Lab'} — ${run.runtimeDir}`,
          value: run.runtimeDir,
        })),
        { name: 'Voltar', value: 'back' },
      ]);
      if (runtime === 'back') continue;
      return input.resume({ runtime_dir: runtime, ...dispatchOptions() });
    }
    while (true) {
      const project = choice === 'existing' ? await chooseExisting() : null;
      if (choice === 'existing' && project === null) break;
      const target: WizardTarget = project ? { type: 'repository', path: project.root } : { type: 'self' };
      const { action, objective } = await collectObjective(prompts);
      buildWizardRunDirective({ target, action, objective });
      const decision = await reviewSummary({ target, ...(project ? { project } : {}), action, objective });
      if (decision === 'cancel') return 'completed';
      if (decision === 'review') continue;
      return submit(target, action, objective);
    }
  }
}
