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
  LabRunError,
  resumeHumanInstruction,
  submitHumanInstruction,
} from '../lib/lab.js';
import { PlanSetupError } from '../lib/run-plan.js';
import { ProjectAuthorizationError } from '../lib/project-authorization.js';
import { SelfMaintenanceError } from '../lib/lab-self.js';

const BOOLEAN_FLAGS = [VERBOSE_FLAG, 'self', 'publish'] as const;

async function readStdin(interactive: boolean): Promise<string> {
  if (interactive && stdinStream.isTTY === true) {
    process.stderr.write('Paste the instruction, then press Ctrl+D.\n');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stdinStream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), [...BOOLEAN_FLAGS]);
  const resume = args.options.get('resume');
  const promptFile = args.options.get('prompt-file');
  const runtimeDir = args.options.get('runtime-dir');
  const announceRuntime = (dir: string): void => {
    process.stderr.write(`runtime: ${dir}\n`);
  };

  try {
    if (resume !== undefined) {
      if (promptFile !== undefined || args.options.get('repo') !== undefined) {
        fail('--resume não aceita nova instrução nem --repo. O runtime já tem a autoridade humana.');
      }
      const result = await resumeHumanInstruction({
        runtime_dir: resume,
        on_runtime: announceRuntime,
        publish: args.flags.has('publish'),
        max_iterations: parseMaxIterations(args),
        verbose: isVerbose(args),
        ...(args.options.get('planner-profile') === undefined
          ? {}
          : { planner_profile_id: args.options.get('planner-profile') as string }),
        ...(args.options.get('timeout-seconds') === undefined
          ? {}
          : { timeout_override: args.options.get('timeout-seconds') as string }),
        ...(parseRoutineAutonomy(args) === undefined ? {} : { autonomy: 'routine' }),
        ...(process.env['AGENTLAB_CONTROL_ROOT'] === undefined
          ? {}
          : { control_root: process.env['AGENTLAB_CONTROL_ROOT'] }),
      });
      emit(result.payload);
      if (result.exitCode !== 0) process.exit(result.exitCode);
      return;
    }

    const self = args.flags.has('self');
    const repo = args.options.get('repo');
    if (!self && (repo === undefined || repo.length === 0)) {
      fail(
        '--repo é obrigatório.\nUso: pnpm lab --repo PATH\n     pnpm lab --self\n     pnpm lab --resume RUNTIME',
      );
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

    const result = await submitHumanInstruction({
      raw_instruction: raw,
      instruction_source: source,
      ...(sourcePath === undefined ? {} : { source_path: sourcePath }),
      ...(repo === undefined ? {} : { repo }),
      self,
      publish: args.flags.has('publish'),
      on_runtime: announceRuntime,
      ...(runtimeDir === undefined ? {} : { runtime_dir: runtimeDir }),
      ...(args.options.get('authorization') === undefined
        ? {}
        : { authorization_file: args.options.get('authorization') as string }),
      ...(args.options.get('policy') === undefined ? {} : { policy_preset: args.options.get('policy') as string }),
      ...(args.options.get('planner-profile') === undefined
        ? {}
        : { planner_profile_id: args.options.get('planner-profile') as string }),
      max_iterations: parseMaxIterations(args),
      verbose: isVerbose(args),
      ...(args.options.get('timeout-seconds') === undefined
        ? {}
        : { timeout_override: args.options.get('timeout-seconds') as string }),
      ...(parseRoutineAutonomy(args) === undefined ? {} : { autonomy: 'routine' }),
      ...(process.env['AGENTLAB_CONTROL_ROOT'] === undefined
        ? {}
        : { control_root: process.env['AGENTLAB_CONTROL_ROOT'] }),
    });
    emit(result.payload);
    if (result.exitCode !== 0) process.exit(result.exitCode);
  } catch (error) {
    if (error instanceof LabRunError) fail(error.message);
    if (error instanceof PlanSetupError) fail(error.message);
    if (error instanceof ProjectAuthorizationError) fail(error.message);
    if (error instanceof SelfMaintenanceError) fail(error.message);
    throw error;
  }
}

await runMain(main);
