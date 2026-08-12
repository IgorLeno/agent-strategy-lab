import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertAttemptRecoveryHead, type AttemptRecoveryHead } from '../../dev/lib/base-guard.js';
import { changedFiles, headSha, parentShas } from '../../dev/lib/git.js';
import {
  adoptMaintenance,
  adoptMaintenanceRange,
  type MaintenanceValidationRunner,
} from '../../dev/lib/maintenance.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import { writeMaintenanceRecord } from '../../dev/lib/records.js';
import type { MaintenanceCommit, MaintenanceRecord } from '../../dev/lib/schemas.js';
import {
  buildInitialState,
  ensureRuntimeDirs,
  readState,
  writeState,
} from '../../dev/lib/state.js';
import { commitAll, makeSandboxRepo, runGit, type Sandbox } from './helpers.js';

/**
 * Guarda de HEAD do encerramento de um attempt HISTÓRICO.
 *
 * O caso que não existia: o attempt nasceu na base A, e antes de alguém
 * arquivá-lo a manutenção auditada avançou a base autorizada até C. A diferença
 * entre A e C só é aceitável quando MaintenanceRecords adotados a explicam
 * inteira — descendência não prova nada, porque um descendente qualquer pode
 * carregar trabalho externo que ninguém validou.
 */

let sandbox: Sandbox;
let paths: HarnessPaths;
let loaded: LoadedPlan;
/** Base histórica do attempt: o `A` de todos os cenários deste arquivo. */
let base: string;

const passingValidations: MaintenanceValidationRunner = async (command) => ({
  argv: [...command.argv],
  exit_code: 0,
  timed_out: false,
  duration_ms: 1,
});

beforeEach(async () => {
  sandbox = await makeSandboxRepo();
  paths = resolveHarnessPaths(sandbox.root);
  loaded = await loadPlan(paths.planFile);
  await ensureRuntimeDirs(paths);
  base = await headSha(sandbox.root);
  await writeState(
    paths,
    buildInitialState(loaded.plan, loaded.planSha256, { baselineSha: base }),
  );
});

afterEach(async () => {
  await rm(sandbox.root, { recursive: true, force: true });
});

async function createCommit(file: string, contents: string, message: string): Promise<string> {
  await mkdir(path.dirname(path.join(sandbox.root, file)), { recursive: true });
  await writeFile(path.join(sandbox.root, file), contents, 'utf8');
  return commitAll(sandbox.root, message);
}

async function planSourceAtHead(): Promise<string> {
  return (await runGit(sandbox.root, ['show', 'HEAD:dev/plan.yaml'])).stdout.replace(/\n+$/, '');
}

async function authorize(sha: string): Promise<void> {
  await writeState(paths, { ...(await readState(paths)), authorized_head_sha: sha });
}

function guard(
  overrides: {
    readonly baseSha?: string;
    readonly authorizedHeadSha?: string | null;
    readonly allowPendingMaintenance?: boolean;
  } = {},
): Promise<AttemptRecoveryHead> {
  return assertAttemptRecoveryHead({
    paths,
    baseSha: overrides.baseSha ?? base,
    authorizedHeadSha:
      overrides.authorizedHeadSha === undefined ? base : overrides.authorizedHeadSha,
    allowPendingMaintenance: overrides.allowPendingMaintenance ?? false,
    label: 'dev-recover-infra',
  });
}

/** Guarda lendo o `authorized_head_sha` que o state realmente registra. */
async function guardAgainstState(): Promise<AttemptRecoveryHead> {
  return guard({ authorizedHeadSha: (await readState(paths)).authorized_head_sha });
}

function successfulResults(from: string, to: string) {
  return [
    ['pnpm', 'typecheck'],
    ['pnpm', 'build'],
    ['pnpm', 'test'],
    ['git', 'diff', '--check', `${from}..${to}`],
  ].map((argv) => ({ argv, exit_code: 0, timed_out: false, duration_ms: 1 }));
}

/** MaintenanceRecord construído a partir do Git REAL — a menos do que se adultere. */
async function recordFor(
  previous: string,
  shas: readonly string[],
  overrides: {
    readonly kind?: MaintenanceRecord['adoption_kind'];
    readonly changedFiles?: readonly string[];
  } = {},
): Promise<MaintenanceRecord> {
  const commits: MaintenanceCommit[] = [];
  for (const sha of shas) {
    commits.push({
      sha,
      parent_sha: (await parentShas(sandbox.root, sha))[0] as string,
      changed_files: overrides.changedFiles
        ? [...overrides.changedFiles]
        : await changedFiles(sandbox.root, sha),
    });
  }
  const adopted = shas.at(-1) as string;
  return {
    schema_version: 1,
    previous_authorized_head_sha: previous,
    adopted_head_sha: adopted,
    commits,
    changed_files: [...new Set(commits.flatMap((commit) => commit.changed_files))].sort(),
    validation_results: successfulResults(previous, adopted),
    working_tree_clean: true,
    bootstrap_range: false,
    reason: 'manutenção auditada',
    adopted_at: '2026-08-12T18:00:00.000Z',
    ...(overrides.kind ? { adoption_kind: overrides.kind } : {}),
  };
}

/** Faixa A → C adotada pela primitive oficial, com os gates simulados. */
async function adoptRange(): Promise<{ readonly middle: string; readonly target: string }> {
  const middle = await createCommit('docs/manutencao-um.md', 'primeiro\n', 'manutenção 1/2');
  const target = await createCommit('docs/manutencao-dois.md', 'segundo\n', 'manutenção 2/2');
  await adoptMaintenanceRange({
    paths,
    target,
    maxCommits: 3,
    reason: 'faixa auditada antes da recuperação',
    validationRunner: passingValidations,
    now: () => '2026-08-12T18:00:00.000Z',
  });
  return { middle, target };
}

describe('assertAttemptRecoveryHead sem manutenção', () => {
  it('A — HEAD, base do attempt e base autorizada no mesmo commit', async () => {
    const result = await guard();

    expect(result).toMatchObject({ headSha: base, mode: 'plain', adoptedChain: [] });
  });

  it('commit sobre a base sem manutenção adotada continua recusado', async () => {
    await createCommit('docs/solto.md', 'solto\n', 'commit não adotado');

    await expect(guard()).rejects.toThrow(/HEAD.*diverge do base_sha/i);
  });

  it('state sem base autorizada cai no contrato antigo', async () => {
    const result = await guard({ authorizedHeadSha: null });

    expect(result.mode).toBe('plain');
    expect(result.headSha).toBe(base);
  });
});

describe('assertAttemptRecoveryHead atravessando manutenção adotada', () => {
  it('C — maintenance_range adotada A → C libera a recuperação', async () => {
    const { target } = await adoptRange();

    const result = await guardAgainstState();

    expect(result.mode).toBe('adopted_maintenance');
    expect(result.headSha).toBe(target);
    expect(result.adoptedChain.map((record) => record.adopted_head_sha)).toEqual([target]);
    // A base histórica do attempt não é reescrita por este caminho.
    expect(result.adoptedChain[0]?.previous_authorized_head_sha).toBe(base);
  });

  it('C — dois records em sequência A → B → C também são cadeia completa', async () => {
    const first = await createCommit('docs/etapa-um.md', 'um\n', 'manutenção A→B');
    await adoptMaintenance({
      paths,
      reason: 'primeira manutenção',
      validationRunner: passingValidations,
      now: () => '2026-08-12T18:00:00.000Z',
    });
    const second = await createCommit('test/etapa-dois.test.ts', 'export {};\n', 'manutenção B→C');
    await adoptMaintenance({
      paths,
      reason: 'segunda manutenção',
      validationRunner: passingValidations,
      now: () => '2026-08-12T18:05:00.000Z',
    });

    const result = await guardAgainstState();

    expect(result.mode).toBe('adopted_maintenance');
    expect(result.headSha).toBe(second);
    expect(result.adoptedChain.map((record) => record.adopted_head_sha)).toEqual([first, second]);
  });

  it('BLOCKED — HEAD descendente sem MaintenanceRecord nenhum', async () => {
    const head = await createCommit('docs/sem-record.md', 'sem record\n', 'avanço não adotado');
    await authorize(head);

    await expect(guardAgainstState()).rejects.toThrow(/manutenção adotada não explica/i);
  });

  it('BLOCKED — cadeia incompleta: o record para em B e a base autorizada é C', async () => {
    const middle = await createCommit('docs/parcial-um.md', 'um\n', 'manutenção A→B');
    await writeMaintenanceRecord(paths, await recordFor(base, [middle]));
    const head = await createCommit('docs/parcial-dois.md', 'dois\n', 'B→C sem record');
    await authorize(head);

    await expect(guardAgainstState()).rejects.toThrow(/nenhum MaintenanceRecord adotado liga/i);
  });

  it('BLOCKED — commit externo entre a base e a base autorizada', async () => {
    const { target } = await adoptRange();
    const external = await createCommit('src/externo.ts', 'export {};\n', 'trabalho externo');
    await authorize(external);

    // Ancestralidade existe e o record A → C é válido: nada disso responde
    // pelo commit que entrou depois, fora do escopo de manutenção.
    expect(target).not.toBe(external);
    await expect(guardAgainstState()).rejects.toThrow(/nenhum MaintenanceRecord adotado liga/i);
  });

  it('BLOCKED — dois records saindo da mesma base são ambíguos', async () => {
    const head = await createCommit('docs/ramo-principal.md', 'principal\n', 'manutenção A→B');
    await writeMaintenanceRecord(paths, await recordFor(base, [head]));
    await runGit(sandbox.root, ['checkout', '-q', '-b', 'lateral', base]);
    const sibling = await createCommit('docs/ramo-lateral.md', 'lateral\n', 'manutenção A→B2');
    await writeMaintenanceRecord(paths, await recordFor(base, [sibling]));
    await runGit(sandbox.root, ['checkout', '-q', 'main']);
    await authorize(head);

    await expect(guardAgainstState()).rejects.toThrow(/ambíguos/i);
  });

  it('BLOCKED — record adulterado: changed_files diverge do commit', async () => {
    const head = await createCommit('docs/real.md', 'real\n', 'manutenção A→B');
    await writeMaintenanceRecord(
      paths,
      await recordFor(base, [head], { changedFiles: ['docs/inventado.md'] }),
    );
    await authorize(head);

    await expect(guardAgainstState()).rejects.toThrow(/changed_files do MaintenanceRecord diverge/i);
  });

  it('BLOCKED — plan_extension na cadeia, mesmo válida', async () => {
    const extended = `${await planSourceAtHead()}
  - id: T3
    title: terceira tarefa
    blocked_by: [T2]
    objective: criar src/three.txt
    acceptance: ['arquivo criado']
    validation:
      - argv: ['true']
        timeout_seconds: 30
`;
    const head = await createCommit('dev/plan.yaml', extended, 'plan extension append-only');
    await writeMaintenanceRecord(paths, await recordFor(base, [head], { kind: 'plan_extension' }));
    await authorize(head);

    // A recusa é de POLÍTICA: o record é válido e passaria pela verificação
    // contra o Git — atravessá-lo mudaria o plano sob um attempt histórico.
    await expect(guardAgainstState()).rejects.toThrow(
      /cadeia de manutenção contém plan_extension/i,
    );
  });

  it('BLOCKED — working tree suja', async () => {
    await adoptRange();
    await writeFile(path.join(sandbox.root, 'residuo.txt'), 'solto\n', 'utf8');

    await expect(guardAgainstState()).rejects.toThrow(/working tree suja/i);
  });

  it('BLOCKED — HEAD diverge do authorized_head_sha', async () => {
    const { middle, target } = await adoptRange();
    await runGit(sandbox.root, ['checkout', '-q', middle]);

    await expect(guard({ authorizedHeadSha: target })).rejects.toThrow(
      /HEAD.*diverge de authorized_head_sha/i,
    );
  });
});

describe('--allow-pending-maintenance continua como era', () => {
  it('B — exatamente um commit pendente sobre a base segue liberado', async () => {
    const pending = await createCommit('dev/conserto.ts', 'export {};\n', 'conserto pendente');

    const result = await guard({ allowPendingMaintenance: true });

    expect(result).toMatchObject({ headSha: pending, mode: 'pending_maintenance', adoptedChain: [] });
  });

  it('B — dois commits pendentes continuam recusados', async () => {
    await createCommit('dev/conserto-um.ts', 'export {};\n', 'conserto 1');
    await createCommit('dev/conserto-dois.ts', 'export {};\n', 'conserto 2');

    await expect(guard({ allowPendingMaintenance: true })).rejects.toThrow(
      /exatamente um commit; encontrados 2/i,
    );
  });

  it('a flag NÃO passa a atravessar manutenção adotada', async () => {
    await adoptRange();

    // O caminho da cadeia auditada exige base_sha == authorized_head_sha sob a
    // flag antiga: ela continua sendo apenas sobre manutenção PENDENTE.
    await expect(
      guard({
        authorizedHeadSha: (await readState(paths)).authorized_head_sha,
        allowPendingMaintenance: true,
      }),
    ).rejects.toThrow(/base_sha da tentativa diverge de authorized_head_sha/i);
  });
});