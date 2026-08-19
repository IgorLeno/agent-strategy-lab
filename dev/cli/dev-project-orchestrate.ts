#!/usr/bin/env tsx
import { readFile } from 'node:fs/promises';

import { emit, fail, parseArgs, runMain } from '../lib/cli.js';
import { resolveHarnessPaths } from '../lib/paths.js';
import { loadProfile } from '../lib/profile.js';
import { planDirectLifecycle, type ObservedTaxonomyFacts } from '../lib/project-orchestrate.js';
import type { DirectTaskClassification } from '../../src/planner/validate.js';

/**
 * SOMENTE LEITURA e DRY-RUN por construção: decide o caminho do lifecycle
 * universal para um repositório ALVO e imprime a decisão. Não lança provider,
 * não muda estado, não escreve plano e não toca no runtime do orquestrador —
 * `--plan-file` e `--runtime-dir` só redirecionam os `HarnessPaths` do alvo.
 *
 * Exit codes: 0 caminho DIRECT decidido | 4 REVIEWED_REQUIRED.
 */
interface LifecycleRequestFile {
  readonly task_id: string;
  readonly intake: unknown;
  readonly inspection: unknown;
  readonly authorization_scope: unknown;
  readonly classification: DirectTaskClassification;
  readonly worker_runtime_budget_ms: number;
  readonly minimal_facts_source?: 'cached_inspection' | 'fresh_minimal_collection';
  /** Ausente, os critérios de M75 ficam `unknown` e o caminho vira REVIEWED. */
  readonly observed_taxonomy?: ObservedTaxonomyFacts;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const requestFile = args.options.get('request');
  const profileId = args.options.get('profile');
  if (!requestFile) fail('--request <arquivo.json> é obrigatório');
  if (!profileId) fail('--profile <id> é obrigatório');

  const repoRoot = args.options.get('repo') ?? process.cwd();
  const planFile = args.options.get('plan-file');
  const runtimeDir = args.options.get('runtime-dir');
  const paths = resolveHarnessPaths(repoRoot, {
    ...(planFile === undefined ? {} : { planFile }),
    ...(runtimeDir === undefined ? {} : { devDir: runtimeDir }),
  });

  const request = JSON.parse(await readFile(requestFile, 'utf8')) as LifecycleRequestFile;
  const profile = await loadProfile(paths.repoRoot, profileId);

  const result = planDirectLifecycle({
    taskId: request.task_id,
    intake: request.intake,
    inspection: request.inspection,
    authorizationScope: request.authorization_scope,
    classification: request.classification,
    ...(request.minimal_facts_source === undefined
      ? {}
      : { minimalFactsSource: request.minimal_facts_source }),
    ...(request.observed_taxonomy === undefined
      ? {}
      : { observedTaxonomy: request.observed_taxonomy }),
    profile,
    workerRuntimeBudgetMs: request.worker_runtime_budget_ms,
    // Dry-run não prova quota nem credencial: ambas são medidas no launch real.
    quotaAvailable: false,
    credentialProved: false,
  });

  if (result.outcome === 'REVIEWED_REQUIRED') {
    emit({
      status: 'REVIEWED_REQUIRED',
      dry_run: true,
      provider_called: false,
      reason: result.reason,
      plan_file: paths.planFile,
      runtime_dir: paths.devDir,
    });
    process.exit(4);
  }

  emit({
    status: 'PLANNED',
    dry_run: true,
    provider_called: false,
    plan_file: paths.planFile,
    runtime_dir: paths.devDir,
    lifecycle: result.plan,
  });
}

await runMain(main);
