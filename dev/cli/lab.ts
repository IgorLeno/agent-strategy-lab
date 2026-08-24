#!/usr/bin/env tsx
import { readFile } from 'node:fs/promises';
import { stdin as stdinStream } from 'node:process';

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
  formatRunSummary,
  LabRunError,
  resumeHumanInstruction,
  submitRunDirective,
} from '../lib/lab.js';
import { PlanSetupError } from '../lib/run-plan.js';
import { ProjectAuthorizationError } from '../lib/project-authorization.js';
import { SelfMaintenanceError } from '../lib/lab-self.js';
import { RunDirectiveError } from '../../src/intake/index.js';

const BOOLEAN_FLAGS = [VERBOSE_FLAG, 'self', 'publish'] as const;

const PRODUCT_PROMPT = [
  'Agent Strategy Lab',
  '',
  'What do you want to implement?',
  'Paste the complete run directive below.',
  'Press Ctrl+D when finished.',
  '',
  '> ',
].join('\n');

async function readStdin(interactive: boolean): Promise<string> {
  if (interactive && stdinStream.isTTY === true) {
    process.stderr.write(PRODUCT_PROMPT);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stdinStream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sharedFlags(args: ReturnType<typeof parseArgs>) {
  const plannerProfile = args.options.get('planner-profile');
  const timeoutSeconds = args.options.get('timeout-seconds');
  const controlRoot = process.env['AGENTLAB_CONTROL_ROOT'];
  return {
    publish: args.flags.has('publish'),
    max_iterations: parseMaxIterations(args),
    verbose: isVerbose(args),
    ...(plannerProfile === undefined ? {} : { planner_profile_id: plannerProfile }),
    ...(timeoutSeconds === undefined ? {} : { timeout_override: timeoutSeconds }),
    ...(parseRoutineAutonomy(args) === undefined ? {} : { autonomy: 'routine' as const }),
    ...(controlRoot === undefined ? {} : { control_root: controlRoot }),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), [...BOOLEAN_FLAGS]);
  const subcommand = args.positionals[0];
  if (subcommand !== undefined && subcommand !== 'run' && subcommand !== 'resume') {
    fail(`comando desconhecido: ${subcommand}. Use pnpm lab run | pnpm lab resume RUNTIME.`);
  }

  const resumeFromSubcommand = subcommand === 'resume' ? args.positionals[1] : undefined;
  const resumeFromFlag = args.options.get('resume');
  const resumeRuntime = resumeFromSubcommand ?? resumeFromFlag;
  const promptFile = args.options.get('prompt-file');
  const runtimeDir = args.options.get('runtime-dir');
  const announceRuntime = (dir: string): void => {
    process.stderr.write(`runtime: ${dir}\n`);
  };
  const announceSummary = (summary: Parameters<typeof formatRunSummary>[0]): void => {
    process.stderr.write(`${formatRunSummary(summary)}\n`);
  };

  try {
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
        ...sharedFlags(args),
      });
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
      raw = await readStdin(true);
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
      ...(runtimeDir === undefined ? {} : { runtime_dir: runtimeDir }),
      ...(authorization === undefined ? {} : { authorization_file: authorization }),
      ...(policy === undefined ? {} : { policy_preset: policy }),
      ...sharedFlags(args),
    });
    emit(result.payload);
    if (result.exitCode !== 0) process.exit(result.exitCode);
  } catch (error) {
    if (error instanceof LabRunError) fail(error.message);
    if (error instanceof RunDirectiveError) fail(error.message);
    if (error instanceof PlanSetupError) fail(error.message);
    if (error instanceof ProjectAuthorizationError) fail(error.message);
    if (error instanceof SelfMaintenanceError) fail(error.message);
    throw error;
  }
}

await runMain(main);
