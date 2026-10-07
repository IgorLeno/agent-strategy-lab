/**
 * DAEMON: dono único do estado vivo (projetos, loops, ledger). Roda no
 * `utilityProcess` (Q4) e fala só por mensagens; esta classe não conhece
 * Electron para ser testável em Node puro.
 *
 * Um `PlanLoop` por projeto; vários projetos rodam ao mesmo tempo. A UI
 * recebe DTOs (`shared/ipc.ts`), nunca tipos do core.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  DEFAULT_CATALOG,
  Ledger,
  PlanLoop,
  parsePlan,
  planSlug,
  type InvocationRequest,
  type AdapterInvocation,
  type LoopEvent,
  type LoopResult,
  type ModelProfile,
  type PauseReason,
  type Plan,
} from '@asl/core';

import {
  DEFAULT_SETTINGS,
  type DaemonCommands,
  type DaemonEvent,
  type CommandName,
  type PlanResult,
  type ProjectSettings,
  type ProjectView,
  type LoopState,
  type StepHeader,
  type StepHistoryView,
  type TranscriptItem,
} from '../shared/ipc.js';
import { ProjectsStore, type ProjectRecord } from './projects-store.js';
import { TranscriptMapper } from './transcript.js';

const execFileAsync = promisify(execFile);

/** Transcript guardado por projeto; o resto do histórico fica no ledger. */
const TRANSCRIPT_LIMIT = 2_000;

export interface DaemonOptions {
  readonly ledgerPath: string;
  readonly projectsFile: string;
  readonly sourceEnv: Readonly<Record<string, string | undefined>>;
  readonly emit: (event: DaemonEvent) => void;
  readonly catalog?: readonly ModelProfile[];
  /** Injetável para o agente fake (testes e teste de UI). */
  readonly invoke?: (request: InvocationRequest) => AdapterInvocation;
  readonly worktreeRoot?: string;
}

interface Runtime {
  loop: PlanLoop | null;
  run: Promise<void> | null;
  state: LoopState;
  detail: string | null;
  currentStepId: string | null;
  workspaceDir: string | null;
  header: StepHeader | null;
  items: TranscriptItem[];
  mapper: TranscriptMapper;
}

const PAUSE_TEXT: Readonly<Record<PauseReason, string>> = {
  requested: 'pausa pedida',
  step_boundary: 'fim do step (Step a step)',
  phase_boundary: 'fim da fase (Por fase)',
  step_failed: 'step falhou depois dos retries',
  failed_step_in_plan: 'há step marcado [!] no plano',
  no_profile_available: 'nenhum perfil disponível no tier',
};

const MODES = ['plan', 'edit', 'auto'] as const;
const CONTINUITIES = ['step', 'phase', 'continuous'] as const;
const GIT_MODES = ['direct', 'branch', 'worktree'] as const;

/** O patch vem do renderer: valida campo a campo em vez de confiar no tipo. */
export function validatePatch(patch: unknown): Partial<ProjectSettings> {
  if (typeof patch !== 'object' || patch === null) throw new Error('patch de configuração inválido');
  const input = patch as Record<string, unknown>;
  const out: { -readonly [K in keyof ProjectSettings]?: ProjectSettings[K] } = {};
  const oneOf = <T extends string>(key: string, allowed: readonly T[]): T => {
    const value = input[key];
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
    throw new Error(`${key} deve ser ${allowed.join(' | ')}`);
  };
  for (const key of Object.keys(input)) {
    switch (key) {
      case 'mode':
        out.mode = oneOf('mode', MODES);
        break;
      case 'continuity':
        out.continuity = oneOf('continuity', CONTINUITIES);
        break;
      case 'gitMode':
        out.gitMode = oneOf('gitMode', GIT_MODES);
        break;
      case 'maxRetries': {
        const value = input[key];
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 20) {
          throw new Error('maxRetries deve ser inteiro entre 0 e 20');
        }
        out.maxRetries = value;
        break;
      }
      case 'gateCommand': {
        const value = input[key];
        if (value !== null && typeof value !== 'string') throw new Error('gateCommand deve ser texto ou null');
        out.gateCommand = value === null || value.trim() === '' ? null : value.trim();
        break;
      }
      case 'planRelPath': {
        const value = input[key];
        if (typeof value !== 'string' || value.trim() === '' || path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) {
          throw new Error('planRelPath deve ser caminho relativo dentro do repo');
        }
        out.planRelPath = value.trim();
        break;
      }
      case 'allowedCommands': {
        const value = input[key];
        if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
          throw new Error('allowedCommands deve ser lista de textos');
        }
        out.allowedCommands = value.map((item: string) => item.trim()).filter((item: string) => item !== '');
        break;
      }
      default:
        throw new Error(`campo de configuração desconhecido: ${key}`);
    }
  }
  return out;
}

export class Daemon {
  private readonly ledger: Ledger;
  private readonly store: ProjectsStore;
  private readonly runtimes = new Map<string, Runtime>();

  constructor(private readonly options: DaemonOptions) {
    this.ledger = new Ledger(options.ledgerPath);
    this.store = new ProjectsStore(options.projectsFile);
  }

  async handle<K extends CommandName>(command: K, args: unknown): Promise<DaemonCommands[K]['result']> {
    const input = (args ?? {}) as Record<string, unknown>;
    const id = (): string => {
      const value = input['projectId'];
      if (typeof value !== 'string') throw new Error('projectId ausente');
      return value;
    };
    const result = await (async (): Promise<unknown> => {
      switch (command) {
        case 'listProjects':
          return this.store.all().map((record) => this.view(record));
        case 'addProject': {
          const repo = input['repo'];
          if (typeof repo !== 'string') throw new Error('repo ausente');
          return this.addProject(repo);
        }
        case 'removeProject':
          this.removeProject(id());
          return null;
        case 'updateSettings':
          return this.updateSettings(id(), validatePatch(input['patch']));
        case 'getPlan':
          return this.planOf(this.store.get(id()));
        case 'getHistory':
          return this.historyOf(this.store.get(id()));
        case 'getTranscript': {
          const runtime = this.runtimes.get(id());
          return { header: runtime?.header ?? null, items: runtime?.items ?? [] };
        }
        case 'start':
          this.start(id());
          return null;
        case 'pause':
          this.pause(id());
          return null;
        default:
          throw new Error(`comando desconhecido: ${String(command)}`);
      }
    })();
    return result as DaemonCommands[K]['result'];
  }

  /** App fechando: mata os steps em curso (ficam `interrupted` no ledger) e fecha o ledger. */
  async shutdown(): Promise<void> {
    const running = [...this.runtimes.values()].filter((runtime) => runtime.run !== null);
    for (const runtime of running) runtime.loop?.abortNow();
    await Promise.allSettled(running.map((runtime) => runtime.run));
    this.ledger.close();
  }

  // ---- projetos ----

  private async addProject(dir: string): Promise<ProjectView> {
    let repo: string;
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: dir });
      repo = stdout.trim();
    } catch {
      throw new Error(`${dir} não é um repositório Git`);
    }
    const existing = this.store.all().find((record) => record.repo === repo);
    if (existing !== undefined) return this.view(existing);
    const record: ProjectRecord = {
      id: createHash('sha256').update(repo).digest('hex').slice(0, 12),
      repo,
      name: path.basename(repo),
      settings: DEFAULT_SETTINGS,
    };
    this.store.add(record);
    return this.publish(record);
  }

  private removeProject(projectId: string): void {
    if (this.runtimes.get(projectId)?.run != null) throw new Error('pause o loop antes de remover o projeto');
    this.store.remove(projectId);
    this.runtimes.delete(projectId);
  }

  private updateSettings(projectId: string, patch: Partial<ProjectSettings>): ProjectView {
    const runtime = this.runtimes.get(projectId);
    const running = runtime?.run != null;
    if (running && (patch.gitMode !== undefined || patch.planRelPath !== undefined)) {
      throw new Error('Git mode e caminho do plano só mudam com o loop parado');
    }
    const record = this.store.updateSettings(projectId, patch);
    // Modo e continuidade valem com o loop rodando (visão §2); o resto, no próximo início.
    if (running && runtime?.loop != null) {
      if (patch.mode !== undefined) runtime.loop.setMode(patch.mode);
      if (patch.continuity !== undefined) runtime.loop.setContinuity(patch.continuity);
    }
    return this.publish(record);
  }

  private runtime(projectId: string): Runtime {
    let runtime = this.runtimes.get(projectId);
    if (runtime === undefined) {
      runtime = {
        loop: null,
        run: null,
        state: 'idle',
        detail: null,
        currentStepId: null,
        workspaceDir: null,
        header: null,
        items: [],
        mapper: new TranscriptMapper(),
      };
      this.runtimes.set(projectId, runtime);
    }
    return runtime;
  }

  // ---- loop ----

  private start(projectId: string): void {
    const record = this.store.get(projectId);
    const runtime = this.runtime(projectId);
    if (runtime.run !== null) throw new Error('o loop deste projeto já está rodando');
    const { settings } = record;
    const loop = new PlanLoop({
      repo: record.repo,
      planRelPath: settings.planRelPath,
      gitMode: settings.gitMode,
      mode: settings.mode,
      continuity: settings.continuity,
      catalog: this.options.catalog ?? DEFAULT_CATALOG,
      ledger: this.ledger,
      gateCommand: settings.gateCommand,
      allowedCommands: settings.allowedCommands,
      maxRetries: settings.maxRetries,
      sourceEnv: this.options.sourceEnv,
      ...(this.options.worktreeRoot === undefined ? {} : { worktreeRoot: this.options.worktreeRoot }),
      ...(this.options.invoke === undefined ? {} : { invoke: this.options.invoke }),
      onEvent: (event) => this.onLoopEvent(record, runtime, event),
    });
    runtime.loop = loop;
    runtime.state = 'running';
    runtime.detail = null;
    runtime.run = loop.run().then(
      (result) => this.finishRun(record, runtime, result),
      (error: unknown) => {
        // Pré-condição (árvore suja, plano ausente, Git) ou bug: o loop para com o motivo à vista.
        runtime.state = 'error';
        runtime.detail = error instanceof Error ? error.message : String(error);
        this.endRun(record, runtime);
      },
    );
    this.publish(record);
  }

  private pause(projectId: string): void {
    const runtime = this.runtimes.get(projectId);
    if (runtime?.loop == null || runtime.run === null) return;
    runtime.loop.requestPause();
    runtime.state = 'pausing';
    this.publish(this.store.get(projectId));
  }

  private finishRun(record: ProjectRecord, runtime: Runtime, result: LoopResult): void {
    if (result.status === 'done') {
      runtime.state = 'done';
      runtime.detail = null;
    } else if (result.status === 'paused') {
      runtime.state = 'paused';
      runtime.detail = result.detail === null ? PAUSE_TEXT[result.reason] : `${PAUSE_TEXT[result.reason]}: ${result.detail}`;
    } else {
      runtime.state = 'paused';
      runtime.detail = 'step interrompido';
    }
    this.endRun(record, runtime);
  }

  private endRun(record: ProjectRecord, runtime: Runtime): void {
    runtime.loop = null;
    runtime.run = null;
    runtime.currentStepId = null;
    this.publish(record);
    this.options.emit({ type: 'plan_changed', projectId: record.id });
  }

  private onLoopEvent(record: ProjectRecord, runtime: Runtime, event: LoopEvent): void {
    const projectId = record.id;
    const transcript = (stepId: string, item: TranscriptItem): void => {
      runtime.items.push(item);
      if (runtime.items.length > TRANSCRIPT_LIMIT) runtime.items.splice(0, runtime.items.length - TRANSCRIPT_LIMIT);
      this.options.emit({ type: 'transcript', projectId, stepId, item });
    };
    switch (event.type) {
      case 'plan_started':
        runtime.workspaceDir = event.workspace.dir;
        this.options.emit({ type: 'plan_changed', projectId });
        return;
      case 'step_started':
        runtime.currentStepId = event.step.id;
        runtime.items = [];
        runtime.header = null;
        this.publish(record);
        this.options.emit({ type: 'plan_changed', projectId });
        return;
      case 'attempt_started':
        runtime.mapper = new TranscriptMapper();
        runtime.header = {
          stepId: event.step.id,
          title: event.step.title,
          tier: event.step.tier,
          attemptNo: event.attemptNo,
          model: event.model,
        };
        this.options.emit({ type: 'step_header', projectId, header: runtime.header });
        transcript(event.step.id, { kind: 'attempt', attemptNo: event.attemptNo, profileId: event.profileId, model: event.model });
        return;
      case 'transcript': {
        const item = runtime.mapper.map(event.event);
        if (item !== null) transcript(event.stepId, item);
        return;
      }
      case 'attempt_finished':
        transcript(event.stepId, { kind: 'attempt_finished', outcome: event.outcome, error: event.error });
        this.options.emit({ type: 'plan_changed', projectId });
        return;
      case 'step_finished':
        this.publish(record);
        this.options.emit({ type: 'plan_changed', projectId });
        return;
      case 'paused':
      case 'plan_done':
        // O estado final vem do resultado de `run()` (finishRun), que chega logo depois.
        return;
    }
  }

  // ---- leitura ----

  /** O `plan.md` que o loop lê: o do worktree quando houver, senão o do repo. */
  private planPath(record: ProjectRecord): string {
    const runtime = this.runtimes.get(record.id);
    const repoPlan = path.join(record.repo, record.settings.planRelPath);
    if (runtime?.workspaceDir != null) return path.join(runtime.workspaceDir, record.settings.planRelPath);
    const known = this.knownPlan(record, repoPlan);
    return known === null ? repoPlan : path.join(known.workspace_dir, record.settings.planRelPath);
  }

  private knownPlan(record: ProjectRecord, repoPlan: string): ReturnType<Ledger['findPlan']> {
    try {
      const plan = parsePlan(readFileSync(repoPlan, 'utf8'));
      const slug = planSlug(plan.title ?? path.basename(record.settings.planRelPath, '.md'));
      return this.ledger.findPlan(record.repo, record.settings.planRelPath, slug);
    } catch {
      return null;
    }
  }

  private readPlan(record: ProjectRecord): { plan: Plan; path: string } | { error: string } {
    const file = this.planPath(record);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return { error: `plano não encontrado em ${file}` };
    }
    try {
      return { plan: parsePlan(text), path: file };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  private planOf(record: ProjectRecord): PlanResult {
    const read = this.readPlan(record);
    if ('error' in read) return { plan: null, error: read.error };
    const runtime = this.runtimes.get(record.id);
    const active = runtime?.run != null ? runtime.currentStepId : null;
    return {
      error: null,
      plan: {
        title: read.plan.title,
        path: read.path,
        steps: read.plan.steps.map((step) => ({
          id: step.id,
          title: step.title,
          tier: step.tier,
          state: step.id === active && step.status === 'pending' ? 'running' : step.status,
          phase: step.phase,
          body: step.body,
        })),
      },
    };
  }

  private historyOf(record: ProjectRecord): StepHistoryView[] {
    const read = this.readPlan(record);
    if ('error' in read) return [];
    const slug = planSlug(read.plan.title ?? path.basename(record.settings.planRelPath, '.md'));
    const planRow = this.ledger.findPlan(record.repo, record.settings.planRelPath, slug);
    if (planRow === null) return [];
    return this.ledger.stepsOf(planRow.id).map((step) => {
      const attempts = this.ledger.attemptsOf(step.id);
      const sum = (pick: (attempt: (typeof attempts)[number]) => number | null): number | null =>
        attempts.some((attempt) => pick(attempt) !== null)
          ? attempts.reduce((total, attempt) => total + (pick(attempt) ?? 0), 0)
          : null;
      return {
        stepId: step.step_id,
        title: step.title,
        tier: step.tier,
        status: step.status,
        commitSha: step.commit_sha,
        durationMs: sum((attempt) => attempt.duration_ms),
        tokensTotal: sum((attempt) => attempt.tokens_total),
        model: attempts.at(-1)?.model ?? null,
        attempts: attempts.length,
      };
    });
  }

  private view(record: ProjectRecord): ProjectView {
    const runtime = this.runtimes.get(record.id);
    const read = this.readPlan(record);
    return {
      id: record.id,
      name: record.name,
      repo: record.repo,
      settings: record.settings,
      state: runtime?.state ?? 'idle',
      stateDetail: runtime?.detail ?? ('error' in read ? read.error : null),
      progress:
        'error' in read
          ? null
          : { done: read.plan.steps.filter((step) => step.status === 'done').length, total: read.plan.steps.length },
      currentStepId: runtime?.currentStepId ?? null,
    };
  }

  private publish(record: ProjectRecord): ProjectView {
    const project = this.view(record);
    this.options.emit({ type: 'project', project });
    return project;
  }
}
