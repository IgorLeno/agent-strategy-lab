import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createRunDirectory,
  finalizeExecution,
  ledgerLineSha256,
  sealEvaluation,
  sealScore,
  sealSection,
  type LedgerEntry,
  type RunDirectory,
} from '../../src/storage/index.js';

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-finalize-'));
  temporaryRoots.push(root);
  return root;
}

async function writeArtifact(
  sectionDir: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const target = path.join(sectionDir, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

/** Run com `execution/` já povoado, pronto para ser selado. */
async function runWithExecution(): Promise<RunDirectory> {
  const run = await createRunDirectory({ labRoot: await temporaryRoot() });
  await writeArtifact(run.executionDir, 'execution-record.json', '{"status":"COMPLETED"}');
  await writeArtifact(run.executionDir, 'events.jsonl', '{"seq":1}\n{"seq":2}\n');
  await writeArtifact(run.executionDir, 'changes/changes.patch', 'diff --git a/x b/x\n');
  return run;
}

async function readLedger(runDir: string): Promise<{ lines: string[]; entries: LedgerEntry[] }> {
  const content = await readFile(path.join(runDir, 'ledger.jsonl'), 'utf8');
  const lines = content.split('\n').filter((line) => line !== '');
  return { lines, entries: lines.map((line) => JSON.parse(line) as LedgerEntry) };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe('finalização da execução', () => {
  it('sela execution com manifest próprio e uma entrada no ledger', async () => {
    const run = await runWithExecution();

    const sealed = await finalizeExecution(run.runDir, {
      now: new Date(Date.UTC(2026, 7, 7, 12, 0, 0)),
    });

    expect(sealed.section).toBe('execution');
    expect(sealed.manifestPath).toBe(path.join(run.executionDir, 'manifest.json'));
    expect(sealed.manifest.artifacts.map((artifact) => artifact.path)).toEqual([
      'changes/changes.patch',
      'events.jsonl',
      'execution-record.json',
    ]);

    const persisted = JSON.parse(await readFile(sealed.manifestPath, 'utf8')) as unknown;
    expect(persisted).toEqual(sealed.manifest);

    const { entries } = await readLedger(run.runDir);
    expect(entries).toEqual([
      {
        schema_version: 1,
        sequence: 1,
        section: 'execution',
        digest_sha256: sealed.manifest.digest_sha256,
        artifact_count: 3,
        appended_at: '2026-08-07T12:00:00.000Z',
        previous_entry_sha256: null,
      },
    ]);
    expect(sealed.ledgerEntry).toEqual(entries[0]);

    // Nenhum manifest na raiz do run: a prova mora dentro de cada seção.
    expect((await readdir(run.runDir)).sort()).toEqual([
      'execution',
      'ledger.jsonl',
      'metadata.json',
    ]);
  });

  it('recusa selar a mesma execução duas vezes sem tocar no que já foi selado', async () => {
    const run = await runWithExecution();
    const sealed = await finalizeExecution(run.runDir);
    const manifestAfterFirst = await readFile(sealed.manifestPath, 'utf8');
    const ledgerAfterFirst = await readFile(path.join(run.runDir, 'ledger.jsonl'), 'utf8');

    await expect(finalizeExecution(run.runDir)).rejects.toThrow(
      'manifest da seção já existe: execution',
    );

    // A segunda tentativa para antes do ledger: nada foi acrescentado.
    await expect(readFile(sealed.manifestPath, 'utf8')).resolves.toBe(manifestAfterFirst);
    await expect(readFile(path.join(run.runDir, 'ledger.jsonl'), 'utf8')).resolves.toBe(
      ledgerAfterFirst,
    );
  });

  it('adiciona evaluation depois da execução selada sem tocar em execution/manifest.json', async () => {
    const run = await runWithExecution();
    const execution = await finalizeExecution(run.runDir);
    const executionManifestBefore = await readFile(execution.manifestPath, 'utf8');
    const { lines: linesAfterExecution } = await readLedger(run.runDir);

    const evaluationDir = path.join(run.runDir, 'evaluations', 'ev-1');
    await writeArtifact(evaluationDir, 'evaluation-record.json', '{"outcome":"PASS"}');
    const evaluation = await sealEvaluation(run.runDir, 'ev-1');

    expect(evaluation.section).toBe('evaluations/ev-1');
    expect(evaluation.manifestPath).toBe(path.join(evaluationDir, 'manifest.json'));

    // A execução selada continua byte a byte como estava.
    await expect(readFile(execution.manifestPath, 'utf8')).resolves.toBe(executionManifestBefore);

    const { lines, entries } = await readLedger(run.runDir);
    expect(lines[0]).toBe(linesAfterExecution[0]);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      sequence: 2,
      section: 'evaluations/ev-1',
      digest_sha256: evaluation.manifest.digest_sha256,
      artifact_count: 1,
      previous_entry_sha256: ledgerLineSha256(linesAfterExecution[0] ?? ''),
    });
  });

  it('mantém o ledger logicamente append-only a cada seção adicionada', async () => {
    const run = await runWithExecution();
    await writeArtifact(
      path.join(run.runDir, 'evaluations', 'ev-1'),
      'evaluation-record.json',
      '{"outcome":"PASS"}',
    );
    await writeArtifact(
      path.join(run.runDir, 'scores', 'sc-1'),
      'score-record.json',
      '{"score":0.5}',
    );

    const snapshots: string[][] = [];
    await finalizeExecution(run.runDir);
    snapshots.push((await readLedger(run.runDir)).lines);
    await sealEvaluation(run.runDir, 'ev-1');
    snapshots.push((await readLedger(run.runDir)).lines);
    await sealScore(run.runDir, 'sc-1');
    snapshots.push((await readLedger(run.runDir)).lines);

    // Cada estado do ledger é prefixo exato do estado seguinte.
    for (const [index, snapshot] of snapshots.entries()) {
      expect(snapshot).toHaveLength(index + 1);
      expect((snapshots.at(-1) ?? []).slice(0, snapshot.length)).toEqual(snapshot);
    }

    const { lines, entries } = snapshotOf(snapshots.at(-1) ?? []);
    expect(entries.map((entry) => entry.section)).toEqual([
      'execution',
      'evaluations/ev-1',
      'scores/sc-1',
    ]);
    expect(entries.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    for (const [index, entry] of entries.entries()) {
      expect(entry.previous_entry_sha256).toBe(
        index === 0 ? null : ledgerLineSha256(lines[index - 1] ?? ''),
      );
    }
  });

  it('falha explicitamente em seção inexistente, id inválido ou caminho fora do run', async () => {
    const run = await runWithExecution();

    await expect(sealEvaluation(run.runDir, 'ev-1')).rejects.toThrow(
      'seção não existe no run: evaluations/ev-1',
    );
    await expect(sealEvaluation(run.runDir, '../escape')).rejects.toThrow(
      'evaluationId deve ser alfanumérico',
    );
    await expect(sealScore(run.runDir, 'sc/1')).rejects.toThrow(
      'scoreId deve ser alfanumérico',
    );
    await expect(sealSection(run.runDir, '../outro-run')).rejects.toThrow(
      'seção inválida: ../outro-run',
    );

    // Um arquivo não é uma seção selável.
    await expect(sealSection(run.runDir, 'metadata.json')).rejects.toThrow(
      'seção não é um diretório: metadata.json',
    );

    // Nenhuma falha criou ledger.
    await expect(readFile(path.join(run.runDir, 'ledger.jsonl'), 'utf8')).rejects.toThrow(
      'ENOENT',
    );
  });
});

function snapshotOf(lines: string[]): { lines: string[]; entries: LedgerEntry[] } {
  return { lines, entries: lines.map((line) => JSON.parse(line) as LedgerEntry) };
}
