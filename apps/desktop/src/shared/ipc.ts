/**
 * Contrato entre renderer, main e daemon.
 *
 * O renderer importa este arquivo, então ele não importa `@asl/core` nem
 * módulos `node:` (teste de fronteira). Os tipos aqui são DTOs de tela; o
 * daemon traduz os tipos do core para eles.
 */

export type PermissionMode = 'plan' | 'edit' | 'auto';
export type Continuity = 'step' | 'phase' | 'continuous';
export type GitMode = 'direct' | 'branch' | 'worktree';
/** Espelha `TIERS` do core (o renderer não importa o core), do mais exigente ao mais barato. */
export type Tier = 'frontier' | 'expert' | 'advanced' | 'balanced' | 'core' | 'fast' | 'economy';

export interface ProjectSettings {
  /** Relativo à raiz do repo (Q7: `.asl/plan.md`). */
  readonly planRelPath: string;
  /** `null` = sem gate automático. */
  readonly gateCommand: string | null;
  /** Prefixos liberados no modo `edit`. */
  readonly allowedCommands: readonly string[];
  readonly maxRetries: number;
  readonly gitMode: GitMode;
  readonly mode: PermissionMode;
  readonly continuity: Continuity;
}

export const DEFAULT_SETTINGS: ProjectSettings = {
  planRelPath: '.asl/plan.md',
  gateCommand: null,
  allowedCommands: [],
  maxRetries: 2,
  gitMode: 'branch',
  mode: 'edit',
  continuity: 'step',
};

/**
 * `pausing` = pausa pedida, o step corrente ainda termina.
 * `paused` traz o motivo do loop; `idle` = nunca rodou nesta sessão do app.
 */
export type LoopState = 'idle' | 'running' | 'pausing' | 'paused' | 'done' | 'error';

export interface ProjectView {
  readonly id: string;
  readonly name: string;
  readonly repo: string;
  readonly settings: ProjectSettings;
  readonly state: LoopState;
  /** Motivo da última parada (pausa, erro); `null` quando rodando ou ocioso. */
  readonly stateDetail: string | null;
  readonly progress: { readonly done: number; readonly total: number } | null;
  readonly currentStepId: string | null;
}

export type PlanStepState = 'pending' | 'running' | 'done' | 'failed';

export interface PlanStepView {
  readonly id: string;
  readonly title: string;
  readonly tier: Tier;
  readonly state: PlanStepState;
  readonly phase: string | null;
  readonly body: string;
}

export interface PlanView {
  readonly title: string | null;
  /** Caminho absoluto do `plan.md` que o loop lê (repo ou worktree). */
  readonly path: string;
  readonly steps: readonly PlanStepView[];
}

/** `null` quando o arquivo não existe ou não parseia; `error` diz por quê. */
export type PlanResult = { readonly plan: PlanView; readonly error: null } | { readonly plan: null; readonly error: string };

export interface StepHistoryView {
  readonly stepId: string;
  readonly title: string;
  readonly tier: Tier;
  readonly status: 'pending' | 'running' | 'done' | 'failed' | 'interrupted';
  readonly commitSha: string | null;
  /** Soma das tentativas. */
  readonly durationMs: number | null;
  readonly tokensTotal: number | null;
  /** Modelo da última tentativa. */
  readonly model: string | null;
  readonly attempts: number;
}

export type TranscriptItem =
  | { readonly kind: 'attempt'; readonly attemptNo: number; readonly profileId: string; readonly model: string }
  | { readonly kind: 'message'; readonly role: 'assistant' | 'user' | 'system'; readonly text: string }
  | { readonly kind: 'tool_call'; readonly name: string; readonly summary: string }
  /** `denied` = a CLI negou a ferramenta pelo modo de permissão; `error` = rodou e falhou. */
  | { readonly kind: 'tool_result'; readonly name: string; readonly status: 'ok' | 'error' | 'denied'; readonly summary: string }
  | { readonly kind: 'attempt_finished'; readonly outcome: string; readonly error: string | null };

export interface StepHeader {
  readonly stepId: string;
  readonly title: string;
  readonly tier: Tier;
  readonly attemptNo: number;
  readonly model: string;
}

export type DaemonEvent =
  | { readonly type: 'project'; readonly project: ProjectView }
  | { readonly type: 'step_header'; readonly projectId: string; readonly header: StepHeader }
  | { readonly type: 'transcript'; readonly projectId: string; readonly stepId: string; readonly item: TranscriptItem }
  /** Plano ou ledger mudaram (checkbox, commit, nova tentativa): o renderer relê. */
  | { readonly type: 'plan_changed'; readonly projectId: string };

/** Comandos que o daemon atende. `result` tipa a resposta de cada um. */
export interface DaemonCommands {
  listProjects: { args: Record<string, never>; result: ProjectView[] };
  addProject: { args: { repo: string }; result: ProjectView };
  removeProject: { args: { projectId: string }; result: null };
  updateSettings: { args: { projectId: string; patch: Partial<ProjectSettings> }; result: ProjectView };
  getPlan: { args: { projectId: string }; result: PlanResult };
  getHistory: { args: { projectId: string }; result: StepHistoryView[] };
  /** Transcript do step corrente (ou do último) guardado no daemon nesta sessão. */
  getTranscript: { args: { projectId: string }; result: { header: StepHeader | null; items: TranscriptItem[] } };
  start: { args: { projectId: string }; result: null };
  pause: { args: { projectId: string }; result: null };
}

export type CommandName = keyof DaemonCommands;

/** Comandos que só o main atende (diálogo nativo, editor externo). */
export interface MainCommands {
  pickDirectory: { args: Record<string, never>; result: string | null };
  openPath: { args: { path: string }; result: null };
  /** Avisos do main (ex.: PATH do shell indisponível) e onde ficam os dados. */
  getAppInfo: { args: Record<string, never>; result: { warnings: string[]; dataDir: string } };
}

export type AllCommands = DaemonCommands & MainCommands;

/** Ponte exposta pelo preload em `window.asl`. */
export interface AslBridge {
  invoke<K extends keyof AllCommands>(command: K, args: AllCommands[K]['args']): Promise<AllCommands[K]['result']>;
  /** Devolve a função que cancela a inscrição. */
  onEvent(listener: (event: DaemonEvent) => void): () => void;
}

export const IPC_INVOKE = 'asl:invoke';
export const IPC_EVENT = 'asl:event';

/** Mensagens main ↔ daemon (MessagePort do utilityProcess). */
export type DaemonRequest =
  | { readonly kind: 'request'; readonly id: number; readonly command: CommandName; readonly args: unknown }
  /** App fechando: mata steps em curso (ficam `interrupted`), fecha o ledger e solta o lock. */
  | { readonly kind: 'shutdown' };
export type DaemonMessage =
  | { readonly kind: 'response'; readonly id: number; readonly ok: true; readonly result: unknown }
  | { readonly kind: 'response'; readonly id: number; readonly ok: false; readonly error: string }
  | { readonly kind: 'event'; readonly event: DaemonEvent }
  | { readonly kind: 'fatal'; readonly error: string };
