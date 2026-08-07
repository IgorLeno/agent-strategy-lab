import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { canonicalSha256 } from '../../src/envelope/index.js';
import {
  appendLedgerEntry,
  buildSectionManifest,
  ledgerLineSha256,
  writeSectionManifest,
  type LedgerEntry,
} from '../../src/storage/index.js';

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-manifest-'));
  temporaryRoots.push(root);
  return root;
}

async function writeArtifact(sectionDir: string, relativePath: string, content: string): Promise<void> {
  const target = path.join(sectionDir, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function readLedger(runDir: string): Promise<{ lines: string[]; entries: LedgerEntry[] }> {
  const content = await readFile(path.join(runDir, 'ledger.jsonl'), 'utf8');
  const lines = content.split('\n').filter((line) => line !== '');
  return { lines, entries: lines.map((line) => JSON.parse(line) as LedgerEntry) };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe('section manifest', () => {
  it('lista cada artifact com caminho relativo, tamanho e sha256', async () => {
    const sectionDir = path.join(await temporaryRoot(), 'execution');
    await writeArtifact(sectionDir, 'execution-record.json', '{"status":"COMPLETED"}');
    await writeArtifact(sectionDir, 'changes/changes.patch', 'diff --git a/x b/x\n');

    const manifest = await buildSectionManifest(sectionDir, {
      section: 'execution',
      now: new Date(Date.UTC(2026, 7, 7, 12, 0, 0)),
    });

    expect(manifest.section).toBe('execution');
    expect(manifest.created_at).toBe('2026-08-07T12:00:00.000Z');
    expect(manifest.artifacts).toEqual([
      {
        path: 'changes/changes.patch',
        size_bytes: 19,
        sha256: sha256('diff --git a/x b/x\n'),
      },
      {
        path: 'execution-record.json',
        size_bytes: 22,
        sha256: sha256('{"status":"COMPLETED"}'),
      },
    ]);
    expect(manifest.digest_sha256).toBe(
      canonicalSha256({
        schema_version: 1,
        section: 'execution',
        artifacts: manifest.artifacts,
      }),
    );
  });

  it('produz o mesmo digest independente da ordem de criação dos arquivos', async () => {
    const root = await temporaryRoot();
    const files: ReadonlyArray<readonly [string, string]> = [
      ['zeta.log', 'zeta'],
      ['alpha/beta.json', '{"a":1}'],
      ['alpha/alpha.json', '{"b":2}'],
      ['events.jsonl', '{"seq":1}\n{"seq":2}\n'],
    ];

    const forwardDir = path.join(root, 'forward');
    for (const [relativePath, content] of files) {
      await writeArtifact(forwardDir, relativePath, content);
    }

    const reverseDir = path.join(root, 'reverse');
    for (const [relativePath, content] of [...files].reverse()) {
      await writeArtifact(reverseDir, relativePath, content);
    }

    const forward = await buildSectionManifest(forwardDir, { section: 'execution' });
    const reverse = await buildSectionManifest(reverseDir, { section: 'execution' });

    expect(forward.artifacts.map((artifact) => artifact.path)).toEqual([
      'alpha/alpha.json',
      'alpha/beta.json',
      'events.jsonl',
      'zeta.log',
    ]);
    expect(reverse.digest_sha256).toBe(forward.digest_sha256);
  });

  it('separa seções e detecta alteração de conteúdo válido no schema', async () => {
    const root = await temporaryRoot();
    const sectionDir = path.join(root, 'evaluations', 'ev-1');
    await writeArtifact(sectionDir, 'evaluation-record.json', '{"outcome":"PASS"}');

    const original = await buildSectionManifest(sectionDir, { section: 'evaluations/ev-1' });
    await writeArtifact(sectionDir, 'evaluation-record.json', '{"outcome":"FAIL"}');
    const tampered = await buildSectionManifest(sectionDir, { section: 'evaluations/ev-1' });

    expect(tampered.digest_sha256).not.toBe(original.digest_sha256);
    // Mesmo conteúdo em outra seção é outro digest: a seção entra no agregado.
    const otherSection = await buildSectionManifest(sectionDir, { section: 'evaluations/ev-2' });
    expect(otherSection.digest_sha256).not.toBe(tampered.digest_sha256);
  });

  it('escreve o manifest sem se incluir e recusa selar a mesma seção duas vezes', async () => {
    const sectionDir = path.join(await temporaryRoot(), 'scores', 'sc-1');
    await writeArtifact(sectionDir, 'score-record.json', '{"score":1}');

    const written = await writeSectionManifest(sectionDir, { section: 'scores/sc-1' });
    expect(written.manifestPath).toBe(path.join(sectionDir, 'manifest.json'));
    expect(written.manifest.artifacts.map((artifact) => artifact.path)).toEqual([
      'score-record.json',
    ]);

    const persisted = JSON.parse(await readFile(written.manifestPath, 'utf8')) as unknown;
    expect(persisted).toEqual(written.manifest);

    await expect(writeSectionManifest(sectionDir, { section: 'scores/sc-1' })).rejects.toThrow(
      'manifest da seção já existe: scores/sc-1',
    );

    // O manifest já escrito não vira artifact do próximo manifest.
    const rebuilt = await buildSectionManifest(sectionDir, { section: 'scores/sc-1' });
    expect(rebuilt.artifacts).toEqual(written.manifest.artifacts);
  });
});

describe('run ledger', () => {
  it('registra cada adição sem reescrever as entradas anteriores', async () => {
    const runDir = await temporaryRoot();
    const executionDir = path.join(runDir, 'execution');
    const evaluationDir = path.join(runDir, 'evaluations', 'ev-1');
    await writeArtifact(executionDir, 'execution-record.json', '{"status":"COMPLETED"}');
    await writeArtifact(evaluationDir, 'evaluation-record.json', '{"outcome":"PASS"}');

    const executionManifest = await buildSectionManifest(executionDir, { section: 'execution' });
    const first = await appendLedgerEntry(runDir, executionManifest, {
      now: new Date(Date.UTC(2026, 7, 7, 12, 0, 0)),
    });
    const afterFirst = await readLedger(runDir);

    const evaluationManifest = await buildSectionManifest(evaluationDir, {
      section: 'evaluations/ev-1',
    });
    const second = await appendLedgerEntry(runDir, evaluationManifest);
    const afterSecond = await readLedger(runDir);

    expect(first).toEqual({
      schema_version: 1,
      sequence: 1,
      section: 'execution',
      digest_sha256: executionManifest.digest_sha256,
      artifact_count: 1,
      appended_at: '2026-08-07T12:00:00.000Z',
      previous_entry_sha256: null,
    });
    expect(afterSecond.lines[0]).toBe(afterFirst.lines[0]);
    expect(afterSecond.entries).toEqual([first, second]);
    expect(second.sequence).toBe(2);
    expect(second.section).toBe('evaluations/ev-1');
    expect(second.previous_entry_sha256).toBe(ledgerLineSha256(afterFirst.lines[0] ?? ''));
  });

  it('encadeia appends concorrentes em sequência contínua', async () => {
    const runDir = await temporaryRoot();
    const sectionDir = path.join(runDir, 'execution');
    await writeArtifact(sectionDir, 'execution-record.json', '{"status":"COMPLETED"}');
    const manifest = await buildSectionManifest(sectionDir, { section: 'execution' });

    await Promise.all(
      Array.from({ length: 5 }, () => appendLedgerEntry(runDir, manifest)),
    );

    const { lines, entries } = await readLedger(runDir);
    expect(entries.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5]);
    for (const [index, entry] of entries.entries()) {
      const expectedPrevious = index === 0 ? null : ledgerLineSha256(lines[index - 1] ?? '');
      expect(entry.previous_entry_sha256).toBe(expectedPrevious);
    }
  });
});
