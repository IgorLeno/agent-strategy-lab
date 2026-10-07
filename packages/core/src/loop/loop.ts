/**
 * LOOP RUNNER de um plano.
 *
 * Para cada step pendente do `plan.md`: escolhe perfil do tier, monta o
 * handoff, roda a CLI numa sessão nova, roda o gate, commita e marca o
 * checkbox. Pouca cerimônia por decisão de produto:
 *
 *   gate vermelho / agente falhou  -> retry com o erro no contexto, até N;
 *                                     esgotou -> `- [!]` e o loop pausa;
 *   provider falhou (limite, erro)  -> próximo perfil do mesmo tier, sem
 *                                     gastar retry; tier sem perfil -> pausa;
 *   pausa pedida                    -> termina o step corrente e para.
 *
 * Nada aqui cria gate humano novo: o único estado de parada é "pausado", com
 * motivo, e retomar é rodar de novo.
 */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseClaudeLine } from '../adapters/claude/parser.js';
import { parseCodexLine } from '../adapters/codex/parser.js';
import { parseOpenCodeLine } from '../adapters/opencode/parser.js';
import type { AdapterInvocation, ProviderEvent } from '../adapters/contract.js';
import { AgentEvent } from '../adapters/events.js';
import {
  buildInvocation,
  type InvocationRequest,
  type PermissionMode,
} from '../adapters/invocation.js';
import { decodeStepOutput } from '../adapters/step-output.js';
import { profilesOfTier, type ModelProfile, type Tier } from '../catalog/catalog.js';
import { commitAll, diffSince, planSlug, prepareWorkspace, type GitMode, type Workspace } from '../git/git.js';
import type { AttemptOutcome, Ledger } from '../ledger/ledger.js';
import { nextPendingStep, parsePlan, setStepStatus, type PlanStep } from '../plan/plan.js';
import { buildHandoff, tailBytes } from './handoff.js';
import { runProcess } from './process.js';

export type Continuity = 'step' | 'phase' | 'continuous';

export type PauseReason =
  | 'requested'
  | 'step_boundary'
  | 'phase_boundary'
  | 'step_failed'
  | 'failed_step_in_plan'
  | 'no_profile_available';

export type LoopEvent =
  | { readonly type: 'plan_started'; readonly planId: number; readonly workspace: Workspace }
  | { readonly type: 'step_started'; readonly step: PlanStep }
  | {
      readonly type: 'attempt_started';
      readonly step: PlanStep;
      readonly attemptNo: number;
      readonly profileId: string;
      readonly model: string;
    }
  | { readonly type: 'transcript'; readonly stepId: string; readonly line: string; readonly event: ProviderEvent | null }
  | {
      readonly type: 'attempt_finished';
      readonly stepId: string;
      readonly outcome: AttemptOutcome;
      readonly error: string | null;
    }
  | { readonly type: 'step_finished'; readonly stepId: string; readonly status: 'done' | 'failed'; readonly commitSha: string | null }
  | { readonly type: 'paused'; readonly reason: PauseReason; readonly detail: string | null }
  | { readonly type: 'plan_done' };

export interface LoopOptions {
  readonly repo: string;
  /** Relativo à raiz do repositório. Padrão do produto: `.asl/plan.md` (Q7). */
  readonly planRelPath: string;
  readonly gitMode: GitMode;
  readonly mode: PermissionMode;
  readonly continuity: Continuity;
  readonly catalog: readonly ModelProfile[];
  readonly ledger: Ledger;
  /** Comando do gate (via `sh -c`); `null` = sem gate automático. */
  readonly gateCommand: string | null;
  /** Prefixos de comando liberados no modo `edit`. */
  readonly allowedCommands: readonly string[];
  /** Retries depois da primeira tentativa, por step (padrão 2). */
  readonly maxRetries?: number;
  /** Teto de máquina por processo de agente (padrão 60 min). */
  readonly stepTimeoutMs?: number;
  /** Teto de máquina do gate (padrão 30 min). */
  readonly gateTimeoutMs?: number;
  readonly sourceEnv: Readonly<Record<string, string | undefined>>;
  readonly worktreeRoot?: string;
  readonly onEvent?: (event: LoopEvent) => void;
  /** Injetável nos testes; padrão: `buildInvocation`. */
  readonly invoke?: (request: InvocationRequest) => AdapterInvocation;
}

export type LoopResult =
  | { readonly status: 'done' }
  | { readonly status: 'paused'; readonly reason: PauseReason; readonly detail: string | null }
  | { readonly status: 'aborted' };

type StepResult =
  | { readonly kind: 'done' }
  | { readonly kind: 'failed'; readonly error: string }
  | { readonly kind: 'no_profile'; readonly tier: Tier }
  | { readonly kind: 'aborted' };

export class PlanLoop {
  private continuity: Continuity;
  private mode: PermissionMode;
  private pauseRequested = false;
  private readonly abort = new AbortController();

  constructor(private readonly options: LoopOptions) {
    this.continuity = options.continuity;
    this.mode = options.mode;
  }

  /** Termina o step corrente e para. Vale com o loop rodando. */
  requestPause(): void {
    this.pauseRequested = true;
  }

  /** Mata o step corrente agora (app fechando). O step fica `interrupted`. */
  abortNow(): void {
    this.abort.abort();
  }

  /** Trocável com o loop rodando; vale a partir do próximo step. */
  setContinuity(continuity: Continuity): void {
    this.continuity = continuity;
  }

  /** Trocável com o loop rodando; vale a partir da próxima tentativa. */
  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  private emit(event: LoopEvent): void {
    this.options.onEvent?.(event);
  }

  private pause(planId: number, reason: PauseReason, detail: string | null = null): LoopResult {
    this.options.ledger.setPlanStatus(planId, 'paused');
    this.emit({ type: 'paused', reason, detail });
    return { status: 'paused', reason, detail };
  }

  async run(): Promise<LoopResult> {
    const { options } = this;
    const repo = path.resolve(options.repo);
    const initial = parsePlan(await readFile(path.join(repo, options.planRelPath), 'utf8'));
    const slug = planSlug(initial.title ?? path.basename(options.planRelPath, '.md'));
    const known = options.ledger.findPlan(repo, options.planRelPath, slug);
    const workspace = await prepareWorkspace({
      repo,
      mode: options.gitMode,
      slug,
      planRelPath: options.planRelPath,
      ...(options.worktreeRoot === undefined ? {} : { worktreeRoot: options.worktreeRoot }),
      ...(known === null ? {} : { knownBaseSha: known.base_sha }),
    });
    const planRow = options.ledger.upsertPlan({
      repo,
      plan_rel_path: options.planRelPath,
      slug,
      git_mode: options.gitMode,
      workspace_dir: workspace.dir,
      branch: workspace.branch,
      base_sha: workspace.baseSha,
    });
    options.ledger.markInterrupted(planRow.id);
    this.emit({ type: 'plan_started', planId: planRow.id, workspace });

    let completedThisRun = 0;
    let lastPhase: string | null | undefined;
    for (;;) {
      if (this.pauseRequested) return this.pause(planRow.id, 'requested');

      const planText = await readFile(workspace.planPath, 'utf8');
      const plan = parsePlan(planText);
      const step = nextPendingStep(plan);
      const failedBefore = plan.steps.find(
        (candidate) => candidate.status === 'failed' && (step === null || candidate.line < step.line),
      );
      if (failedBefore !== undefined) {
        return this.pause(
          planRow.id,
          'failed_step_in_plan',
          `step ${failedBefore.id} está marcado [!]; troque para [ ] para refazer ou [x] para pular`,
        );
      }
      if (step === null) {
        options.ledger.setPlanStatus(planRow.id, 'done');
        this.emit({ type: 'plan_done' });
        return { status: 'done' };
      }
      if (completedThisRun > 0 && this.continuity === 'step') {
        return this.pause(planRow.id, 'step_boundary');
      }
      if (completedThisRun > 0 && this.continuity === 'phase' && lastPhase !== undefined && step.phase !== lastPhase) {
        return this.pause(planRow.id, 'phase_boundary', step.phase);
      }

      const result = await this.runStep(planRow.id, workspace, planText, step);
      if (result.kind === 'aborted') return { status: 'aborted' };
      if (result.kind === 'no_profile') {
        return this.pause(planRow.id, 'no_profile_available', `nenhum perfil do tier ${result.tier} disponível`);
      }
      if (result.kind === 'failed') {
        const current = await readFile(workspace.planPath, 'utf8');
        await writeFile(workspace.planPath, setStepStatus(current, step.id, 'failed'));
        return this.pause(planRow.id, 'step_failed', result.error);
      }
      completedThisRun += 1;
      lastPhase = step.phase;
    }
  }

  private async runStep(planId: number, workspace: Workspace, planText: string, step: PlanStep): Promise<StepResult> {
    const { options } = this;
    const ledger = options.ledger;
    const maxRetries = options.maxRetries ?? 2;
    const stepRow = ledger.ensureStep(planId, step);
    ledger.markStepRunning(stepRow.id);
    this.emit({ type: 'step_started', step });

    const excluded = new Set<string>();
    let retries = 0;
    let retryError: string | null = null;

    for (;;) {
      const profile = pickProfile(options.catalog, step.tier, excluded);
      if (profile === null) {
        ledger.finishStep(stepRow.id, { status: 'pending' });
        return { kind: 'no_profile', tier: step.tier };
      }

      const diff = await diffSince(workspace.dir, workspace.baseSha, [options.planRelPath]);
      const prompt = buildHandoff({
        planText,
        step,
        previousNote: ledger.lastNote(planId),
        retryError,
        gateCommand: options.gateCommand,
        diffStat: diff.stat,
        diffPatch: diff.patch,
      });
      const mode = this.mode;
      const attempt = ledger.startAttempt({
        stepRowId: stepRow.id,
        profileId: profile.id,
        scaffold: profile.scaffold,
        provider: profile.provider,
        model: profile.model,
        effort: profile.effort,
        mode,
      });
      this.emit({ type: 'attempt_started', step, attemptNo: attempt.attemptNo, profileId: profile.id, model: profile.model });

      const invocation = (options.invoke ?? buildInvocation)({
        profile,
        mode,
        prompt,
        allowedCommands: options.allowedCommands,
        sourceEnv: options.sourceEnv,
        // Tag por tentativa: identifica processos órfãos mesmo depois de setsid (LESSONS S14).
        extraEnv: { ASL_STEP_TAG: `${planId}:${step.id}:${attempt.attemptNo}:${randomUUID()}` },
      });
      const parseLine = lineParserOf(profile);
      const run = await runProcess({
        argv: invocation.argv,
        cwd: workspace.dir,
        env: invocation.env ?? {},
        ...(invocation.stdin === undefined ? {} : { stdin: invocation.stdin }),
        timeoutMs: options.stepTimeoutMs ?? 60 * 60_000,
        signal: this.abort.signal,
        onStdoutLine: (line) => this.emit({ type: 'transcript', stepId: step.id, line, event: parseLine(line) }),
      });
      const output = decodeStepOutput(profile.scaffold, run.stdout);
      const base = { durationMs: run.durationMs, exitCode: run.exitCode, timedOut: run.timedOut, tokens: output.tokens };
      const finish = (outcome: AttemptOutcome, gateExitCode: number | null, error: string | null): void => {
        ledger.finishAttempt(attempt.id, { ...base, outcome, gateExitCode, error });
        this.emit({ type: 'attempt_finished', stepId: step.id, outcome, error });
      };

      if (run.aborted) {
        finish('aborted', null, 'abortado');
        ledger.finishStep(stepRow.id, { status: 'interrupted' });
        return { kind: 'aborted' };
      }
      if (run.spawnError !== null) {
        finish('spawn_failed', null, run.spawnError);
        excluded.add(profile.id);
        continue;
      }
      if (output.providerFailure !== null) {
        finish('provider_failed', null, output.providerFailure);
        excluded.add(profile.id);
        continue;
      }

      let failure: { outcome: AttemptOutcome; gateExit: number | null; error: string } | null = null;
      if (run.timedOut || run.exitCode !== 0) {
        failure = {
          outcome: 'agent_failed',
          gateExit: null,
          error: run.timedOut
            ? `o agente passou do teto de ${options.stepTimeoutMs ?? 3_600_000} ms`
            : `o agente saiu com código ${run.exitCode}\n${tailBytes(run.stderr || run.stdout, 4_000)}`,
        };
      } else {
        const gate = await this.runGate(workspace.dir);
        if (gate !== null && gate.exitCode !== 0) {
          failure = { outcome: 'gate_failed', gateExit: gate.exitCode, error: `gate \`${options.gateCommand}\` falhou:\n${gate.output}` };
        } else {
          const committed = await this.commitStep(workspace, step);
          if (committed.ok) {
            finish('success', gate?.exitCode ?? null, null);
            ledger.finishStep(stepRow.id, { status: 'done', commitSha: committed.sha, note: output.finalText });
            this.emit({ type: 'step_finished', stepId: step.id, status: 'done', commitSha: committed.sha });
            return { kind: 'done' };
          }
          failure = { outcome: 'commit_failed', gateExit: gate?.exitCode ?? null, error: `commit recusado:\n${committed.error}` };
        }
      }

      finish(failure.outcome, failure.gateExit, failure.error);
      retryError = failure.error;
      retries += 1;
      if (retries > maxRetries) {
        ledger.finishStep(stepRow.id, { status: 'failed' });
        this.emit({ type: 'step_finished', stepId: step.id, status: 'failed', commitSha: null });
        return { kind: 'failed', error: failure.error };
      }
    }
  }

  private async runGate(dir: string): Promise<{ exitCode: number | null; output: string } | null> {
    if (this.options.gateCommand === null) return null;
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(this.options.sourceEnv)) {
      if (value !== undefined) env[name] = value;
    }
    const run = await runProcess({
      argv: ['sh', '-c', this.options.gateCommand],
      cwd: dir,
      env,
      timeoutMs: this.options.gateTimeoutMs ?? 30 * 60_000,
      signal: this.abort.signal,
    });
    const exitCode = run.timedOut ? null : run.exitCode;
    return { exitCode, output: tailBytes(`${run.stdout}\n${run.stderr}`.trim(), 8_000) };
  }

  /** Marca `[x]` e commita tudo junto; se o commit for recusado, desfaz a marca. */
  private async commitStep(
    workspace: Workspace,
    step: PlanStep,
  ): Promise<{ ok: true; sha: string | null } | { ok: false; error: string }> {
    const before = await readFile(workspace.planPath, 'utf8');
    await writeFile(workspace.planPath, setStepStatus(before, step.id, 'done'));
    try {
      return { ok: true, sha: await commitAll(workspace.dir, `${step.id}: ${step.title}`) };
    } catch (error) {
      await writeFile(workspace.planPath, before);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

/**
 * Router mínimo da Fase 1: perfil mais barato do tier que ainda não falhou
 * neste step. Folga de quota entra na Fase 3.
 */
export function pickProfile(
  catalog: readonly ModelProfile[],
  tier: Tier,
  excluded: ReadonlySet<string>,
): ModelProfile | null {
  const candidates = profilesOfTier(catalog, tier)
    .filter((profile) => !excluded.has(profile.id))
    .sort((left, right) => left.cost_rank - right.cost_rank || left.id.localeCompare(right.id));
  return candidates[0] ?? null;
}

/** Parser de linha do stdout do scaffold → evento do transcript ao vivo. */
export function lineParserOf(profile: ModelProfile): (line: string) => ProviderEvent | null {
  if (profile.scaffold === 'claude_code') return (line) => (line.trim() === '' ? null : parseClaudeLine(line).event);
  if (profile.scaffold === 'codex_cli') return (line) => (line.trim() === '' ? null : parseCodexLine(line).event);
  if (profile.scaffold === 'opencode') return (line) => (line.trim() === '' ? null : parseOpenCodeLine(line).event);
  // O agente fake já emite `AgentEvent`; as linhas de tokens/final ficam de fora.
  if (profile.scaffold === 'fake') return parseFakeLine;
  return () => null;
}

function parseFakeLine(line: string): ProviderEvent | null {
  try {
    const parsed = AgentEvent.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
