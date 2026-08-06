#!/usr/bin/env tsx
import { emit, parseArgs, runMain } from '../lib/cli.js';
import { diagnose } from '../lib/doctor.js';
import { resolveHarnessPaths } from '../lib/paths.js';
import { loadPlan } from '../lib/plan.js';

const DEFAULT_PROFILE = 'claude-build-worker-v2';

/**
 * Confere um perfil ANTES de gastar dinheiro: binário no PATH, flags que a CLI
 * instalada de fato reconhece, política de permissões versionada, modelo fixo
 * e cobertura dos comandos de validação do plano. Não lança worker nenhum.
 *
 * Exit codes: 0 nenhum FAIL | 3 pelo menos um FAIL.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolveHarnessPaths(args.options.get('repo') ?? process.cwd());
  const profileId = args.options.get('profile') ?? args.positionals[0] ?? DEFAULT_PROFILE;
  const loaded = await loadPlan(paths.planFile).catch(() => null);

  const report = await diagnose({ repoRoot: paths.repoRoot, profileId, loaded });
  emit(report);
  process.exit(report.ok ? 0 : 3);
}

await runMain(main);
