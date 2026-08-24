#!/usr/bin/env tsx
import path from 'node:path';

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
  harnessOverrideFromCli,
  resolveHarnessInstallationRoot,
  resolveHarnessPaths,
} from '../lib/paths.js';
import { PlanSetupError } from '../lib/run-plan.js';
import { loadProjectIntakeRequest, runProject } from '../lib/run-project.js';

function requireOption(args: ReturnType<typeof parseArgs>, name: string): string {
  const value = args.options.get(name);
  if (value === undefined || value.length === 0) {
    fail(
      '--' +
        name +
        ' é obrigatório.\nUso: pnpm dev-run-project --repo PATH --request PROJECT-INTAKE --authorization AGENTLAB-RUN',
    );
  }
  return value;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), [VERBOSE_FLAG]);
  const repo = requireOption(args, 'repo');
  const request = requireOption(args, 'request');
  const authorization = requireOption(args, 'authorization');
  const basePaths = resolveHarnessPaths(
    repo,
    harnessOverrideFromCli({
      runtimeDir: args.options.get('runtime-dir'),
      profileRoot: args.options.get('profile-root') ?? resolveHarnessInstallationRoot(),
    }),
  );
  const paths = resolveHarnessPaths(repo, {
    devDir: basePaths.devDir,
    profileCatalogRoot: basePaths.profileCatalogRoot,
    planFile: path.join(basePaths.devDir, 'project', 'generated-plan.yaml'),
  });

  try {
    const machineSafetyCeilingOverride = args.options.get('machine-safety-ceiling-seconds');
    const autonomy = parseRoutineAutonomy(args);
    const result = await runProject({
      paths,
      intake: await loadProjectIntakeRequest(request),
      authorizationFile: authorization,
      maxIterations: parseMaxIterations(args),
      verbose: isVerbose(args),
      ...(args.options.get('planner-profile') === undefined
        ? {}
        : { plannerProfileId: args.options.get('planner-profile') as string }),
      ...(machineSafetyCeilingOverride === undefined ? {} : { machineSafetyCeilingOverride }),
      ...(autonomy === undefined ? {} : { autonomy }),
    });
    emit(result.payload);
    if (result.exitCode !== 0) process.exit(result.exitCode);
  } catch (error) {
    if (error instanceof PlanSetupError) fail(error.message);
    throw error;
  }
}

await runMain(main);
