#!/usr/bin/env tsx
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { stdin as stdinStream } from 'node:process';

import { select } from '@inquirer/prompts';

import {
  VERBOSE_FLAG,
  emit,
  fail,
  isVerbose,
  parseArgs,
  parseMaxIterations,
  parseRoutineAutonomy,
  runMain,
} from '../lib/cli.js';
import {
  authorizeAdditionalRepairForRuntime,
  authorizeProviderExpansionForRuntime,
  formatRunSummary,
  LabRunError,
  resumeHumanInstruction,
  submitRunDirective,
} from '../lib/lab.js';
import { createLabUi } from '../lib/lab-ui.js';
import { parseLabUiMode } from '../lib/lab-tui.js';
import { AdditionalRepairAuthorizationError } from '../lib/automatic-repair.js';
import { ProviderExpansionAuthorizationError } from '../lib/provider-expansion.js';
import { PlanSetupError } from '../lib/run-plan.js';
import { ProjectAuthorizationError } from '../lib/project-authorization.js';
import { SelfMaintenanceError } from '../lib/lab-self.js';
import { dispatchWizardResult, shouldOpenWizard } from '../lib/lab-wizard-dispatch.js';
import { createWizardPrompts, runLabWizard, WizardCancelled } from '../lib/lab-wizard.js';
import { createRecoveryDecisionPrompt } from '../lib/recovery-prompt.js';
import { RunDirectiveError } from '../../src/intake/index.js';
import { dispatchControllerRestart } from '../lib/controller-restart.js';

const BOOLEAN_FLAGS = [VERBOSE_FLAG, 'self', 'publish'] as const;

export { shouldOpenWizard };

const PRODUCT_PROMPT = [
  'Agent Strategy Lab',
  '',
  'What do you want to implement?',
  'Paste the complete run directive below.',
  'Press Ctrl+D when finished.',
  '',
  '> ',
].join('\n');

async function readStdin(interactive: boolean, onWaiting?: () => void): Promise<string> {
  if (interactive && stdinStream.isTTY === true) {
    onWaiting?.();
    process.stderr.write(PRODUCT_PROMPT);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stdinStream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  // EOF need not follow a newline. Start subsequent output below the input.
  if (interactive && stdinStream.isTTY === true) process.stderr.write('\n');
  return Buffer.concat(chunks).toString('utf8');
}

const recoveryDecidePrompt = createRecoveryDecisionPrompt({
  write: (chunk) => process.stderr.write(chunk),
  select: (message, choices) => select({ message, choices: [...choices] }),
});

async function restartInFreshController(result: {
  readonly payload: Record<string, unknown>;
  readonly exitCode: number;
}): Promise<boolean> {
  const dispatched = await dispatchControllerRestart(result);
  if (!dispatched.handled) return false;
  if (dispatched.exitCode !== 0) process.exit(dispatched.exitCode);
  return true;
}

function sharedFlags(args: ReturnType<typeof parseArgs>) {
  const plannerProfile = args.options.get('planner-profile');
  // Escape hatch do failsafe de INFRAESTRUTURA — nunca deadline de task.
  const ceilingSeconds = args.options.get('machine-safety-ceiling-seconds');
  const controlRoot = process.env['AGENTLAB_CONTROL_ROOT'];
  return {
    publish: args.flags.has('publish'),
    max_iterations: parseMaxIterations(args),
    verbose: isVerbose(args),
    ...(plannerProfile === undefined ? {} : { planner_profile_id: plannerProfile }),
    ...(ceilingSeconds === undefined ? {} : { machine_safety_ceiling_override: ceilingSeconds }),
    ...(parseRoutineAutonomy(args) === undefined ? {} : { autonomy: 'routine' as const }),
    ...(controlRoot === undefined ? {} : { control_root: controlRoot }),
    ...(process.stderr.isTTY === true ? { recovery_decide: recoveryDecidePrompt } : {}),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (shouldOpenWizard({
    argv,
    stdinIsTTY: stdinStream.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
  })) {
    try {
      const result = await runLabWizard({
        prompts: createWizardPrompts(),
        stderr: process.stderr,
        color: process.env['NO_COLOR'] === undefined,
        submit: submitRunDirective,
        resume: resumeHumanInstruction,
        recovery_decide: recoveryDecidePrompt,
      });
      if (typeof result === 'object' && await restartInFreshController(result)) return;
      if (dispatchWizardResult(result, emit, process.exit) === 'return') return;
    } catch (error) {
      if (error instanceof WizardCancelled) return;
      throw error;
    }
  }

  const args = parseArgs(argv, [...BOOLEAN_FLAGS]);
  const subcommand = args.positionals[0];
  if (
    subcommand !== undefined &&
    subcommand !== 'run' &&
    subcommand !== 'resume' &&
    subcommand !== 'authorize-repair' &&
    subcommand !== 'authorize-provider-expansion'
  ) {
    fail(
      `comando desconhecido: ${subcommand}. Use pnpm lab run | pnpm lab resume RUNTIME | pnpm lab authorize-repair RUNTIME --task ID --reason TEXTO | pnpm lab authorize-provider-expansion RUNTIME --reason TEXTO.`,
    );
  }

  const resumeFromSubcommand = subcommand === 'resume' ? args.positionals[1] : undefined;
  const resumeFromFlag = args.options.get('resume');
  const resumeRuntime = resumeFromSubcommand ?? resumeFromFlag;
  const promptFile = args.options.get('prompt-file');
  const runtimeDir = args.options.get('runtime-dir');
  const announceRuntime = (dir: string): void => {
    process.stderr.write(`runtime: ${dir}\n`);
  };
  const uiMode = args.flags.has('ui') ? null : parseLabUiMode(args.options.get('ui'));
  if (uiMode === null) fail('--ui aceita somente auto, tui ou plain.');
  const ui = createLabUi({
    mode: uiMode,
    isTTY: process.stderr.isTTY === true,
    write: (chunk) => {
      process.stderr.write(chunk);
    },
    title: path.basename(path.resolve(args.options.get('repo') ?? process.cwd())),
    ...(process.stderr.columns === undefined ? {} : { columns: process.stderr.columns }),
  });
  const progress = ui.listener;
  const announceSummary = (summary: Parameters<typeof formatRunSummary>[0]): void => {
    process.stderr.write(`${formatRunSummary(summary)}\n`);
  };

  try {
    if (subcommand === 'authorize-provider-expansion') {
      const runtime = args.positionals[1];
      if (runtime === undefined || runtime.length === 0) {
        fail('pnpm lab authorize-provider-expansion exige o caminho do runtime.');
      }
      const reason = args.options.get('reason') ?? '';
      const granted = await authorizeProviderExpansionForRuntime({
        runtime_dir: runtime,
        reason,
      });
      ui.finish();
      emit({ status: 'GRANTED', ...granted });
      return;
    }

    if (subcommand === 'authorize-repair') {
      const runtime = args.positionals[1];
      if (runtime === undefined || runtime.length === 0) {
        fail('pnpm lab authorize-repair exige o caminho do runtime.');
      }
      const taskId = args.options.get('task') ?? '';
      const reason = args.options.get('reason') ?? '';
      const granted = await authorizeAdditionalRepairForRuntime({
        runtime_dir: runtime,
        task_id: taskId,
        reason,
      });
      ui.finish();
      emit({ status: 'GRANTED', ...granted });
      return;
    }

    if (subcommand === 'resume' || resumeFromFlag !== undefined) {
      if (resumeRuntime === undefined || resumeRuntime.length === 0) {
        fail('pnpm lab resume exige o caminho do runtime.');
      }
      if (
        resumeFromSubcommand !== undefined &&
        resumeFromFlag !== undefined &&
        resumeFromSubcommand !== resumeFromFlag
      ) {
        fail('conflito: `lab resume` e --resume apontam para runtimes diferentes.');
      }
      if (promptFile !== undefined || args.options.get('repo') !== undefined) {
        fail('--resume não aceita nova instrução nem --repo. O runtime já tem a autoridade humana.');
      }
      const result = await resumeHumanInstruction({
        runtime_dir: resumeRuntime,
        on_runtime: announceRuntime,
        on_summary: announceSummary,
        on_progress: progress,
        ...sharedFlags(args),
      });
      ui.finish();
      if (await restartInFreshController(result)) return;
      emit(result.payload);
      if (result.exitCode !== 0) process.exit(result.exitCode);
      return;
    }

    let raw: string;
    let source: 'stdin' | 'file';
    let sourcePath: string | undefined;
    if (promptFile !== undefined) {
      raw = await readFile(promptFile, 'utf8');
      source = 'file';
      sourcePath = promptFile;
    } else {
      raw = await readStdin(true, () => progress({ stage: 'WAITING_FOR_INPUT' }));
      source = 'stdin';
    }

    const repo = args.options.get('repo');
    const authorization = args.options.get('authorization');
    const policy = args.options.get('policy');
    const result = await submitRunDirective({
      raw_directive: raw,
      instruction_source: source,
      ...(sourcePath === undefined ? {} : { source_path: sourcePath }),
      ...(repo === undefined ? {} : { repo }),
      self: args.flags.has('self'),
      on_runtime: announceRuntime,
      on_summary: announceSummary,
      on_progress: progress,
      ...(runtimeDir === undefined ? {} : { runtime_dir: runtimeDir }),
      ...(authorization === undefined ? {} : { authorization_file: authorization }),
      ...(policy === undefined ? {} : { policy_preset: policy }),
      ...sharedFlags(args),
    });
    ui.finish();
    if (await restartInFreshController(result)) return;
    emit(result.payload);
    if (result.exitCode !== 0) process.exit(result.exitCode);
  } catch (error) {
    ui.finish();
    if (error instanceof LabRunError) fail(error.message);
    if (error instanceof AdditionalRepairAuthorizationError) fail(error.message);
    if (error instanceof ProviderExpansionAuthorizationError) fail(error.message);
    if (error instanceof RunDirectiveError) fail(error.message);
    if (error instanceof PlanSetupError) fail(error.message);
    if (error instanceof ProjectAuthorizationError) fail(error.message);
    if (error instanceof SelfMaintenanceError) fail(error.message);
    throw error;
  }
}

await runMain(main);
