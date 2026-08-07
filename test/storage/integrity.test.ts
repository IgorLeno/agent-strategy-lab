import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildSectionManifest,
  createRunDirectory,
  finalizeExecution,
  sealEvaluation,
  sealScore,
  verifyRunIntegrity,
  writeSectionManifest,
  type IntegrityViolationKind,
  type RunDirectory,
  type RunIntegrityReport,
  type SectionManifest,
} from '../../src/storage/index.js';

const EVENTS_JSONL = '{"seq":1,"type":"START"}\n{"seq":2,"type":"END"}\n';

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-integrity-'));
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

/** Run com `execution/` selada — o estado mínimo que a verificação deve aprovar. */
async function sealedRun(): Promise<RunDirectory> {
  const run = await createRunDirectory({ labRoot: await temporaryRoot() });
  await writeArtifact(run.executionDir, 'execution-record.json', '{"status":"COMPLETED"}');
  await writeArtifact(run.executionDir, 'events.jsonl', EVENTS_JSONL);
  await writeArtifact(run.executionDir, 'changes/changes.patch', 'diff --git a/x b/x\n');
  await finalizeExecution(run.runDir);
  return run;
}

function kinds(report: RunIntegrityReport): IntegrityViolationKind[] {
  return report.violations.map((entry) => entry.kind);
}

function artifacts(report: RunIntegrityReport): (string | null)[] {
  return report.violations.map((entry) => entry.artifact);
}

async function readLedgerLines(runDir: string): Promise<string[]> {
  const content = await readFile(path.join(runDir, 'ledger.jsonl'), 'utf8');
  return content.split('\n').filter((line) => line !== '');
}

async function writeLedgerLines(runDir: string, lines: readonly string[]): Promise<void> {
  await writeFile(path.join(runDir, 'ledger.jsonl'), `${lines.join('\n')}\n`, 'utf8');
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe('verificação de integridade', () => {
  it('aprova um run selado que ninguém tocou', async () => {
    const run = await sealedRun();
    await writeArtifact(
      path.join(run.runDir, 'evaluations', 'ev-1'),
      'evaluation-record.json',
      '{"outcome":"PASS"}',
    );
    await sealEvaluation(run.runDir, 'ev-1');

    const report = await verifyRunIntegrity(run.runDir);

    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.sections).toEqual(['execution', 'evaluations/ev-1']);
    expect(report.verifiedArtifacts).toBe(4);
  });

  it('detecta alteração de um valor que continua válido no schema', async () => {
    const run = await sealedRun();

    // Continua um execution-record bem formado — só o valor mudou.
    await writeArtifact(run.executionDir, 'execution-record.json', '{"status":"CRASHED!"}');

    const report = await verifyRunIntegrity(run.runDir);

    expect(report.ok).toBe(false);
    expect(kinds(report)).toEqual(['ARTIFACT_MODIFIED']);
    expect(report.violations[0]).toMatchObject({
      section: 'execution',
      artifact: 'execution-record.json',
    });
  });

  it('detecta remoção de um artifact listado', async () => {
    const run = await sealedRun();

    await rm(path.join(run.executionDir, 'changes', 'changes.patch'));

    const report = await verifyRunIntegrity(run.runDir);

    expect(report.ok).toBe(false);
    expect(kinds(report)).toEqual(['ARTIFACT_MISSING']);
    expect(artifacts(report)).toEqual(['changes/changes.patch']);
  });

  it('detecta reordenação de linhas do events.jsonl, que preserva o tamanho', async () => {
    const run = await sealedRun();
    const eventsPath = path.join(run.executionDir, 'events.jsonl');
    const sizeBefore = (await stat(eventsPath)).size;

    const reordered = EVENTS_JSONL.split('\n').filter((line) => line !== '').reverse();
    await writeFile(eventsPath, `${reordered.join('\n')}\n`, 'utf8');

    // O tamanho não mudou: só o sha256 do conteúdo denuncia a reordenação.
    expect((await stat(eventsPath)).size).toBe(sizeBefore);

    const report = await verifyRunIntegrity(run.runDir);

    expect(report.ok).toBe(false);
    expect(kinds(report)).toEqual(['ARTIFACT_MODIFIED']);
    expect(artifacts(report)).toEqual(['events.jsonl']);
  });

  it('detecta manifest reescrito para acobertar o artifact alterado', async () => {
    const run = await sealedRun();
    const manifestPath = path.join(run.executionDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as SectionManifest;

    // Adulteração completa: novo conteúdo, novo sha no manifest e digest
    // recalculado — coerente consigo mesmo, mas não com o ledger.
    await writeArtifact(run.executionDir, 'events.jsonl', '{"seq":1,"type":"START"}\n');
    const rebuilt = await forgeManifest(run.executionDir, manifest);
    await writeFile(manifestPath, `${JSON.stringify(rebuilt, null, 2)}\n`, 'utf8');

    const report = await verifyRunIntegrity(run.runDir);

    expect(report.ok).toBe(false);
    expect(kinds(report)).toEqual(['LEDGER_MANIFEST_MISMATCH']);
  });

  it('detecta manifest cujo digest não corresponde aos artifacts que ele declara', async () => {
    const run = await sealedRun();
    const manifestPath = path.join(run.executionDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as SectionManifest;

    const tampered = {
      ...manifest,
      artifacts: manifest.artifacts.filter((artifact) => artifact.path !== 'events.jsonl'),
    };
    await writeFile(manifestPath, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');

    const report = await verifyRunIntegrity(run.runDir);

    expect(report.ok).toBe(false);
    // O digest antigo não bate com a lista encurtada, o ledger não bate com o
    // manifest, e o arquivo removido da lista continua no disco.
    expect(kinds(report)).toEqual([
      'MANIFEST_DIGEST_MISMATCH',
      'LEDGER_MANIFEST_MISMATCH',
      'ARTIFACT_UNEXPECTED',
    ]);
  });

  it('detecta edição de uma entrada antiga do ledger', async () => {
    const run = await sealedRun();
    await writeArtifact(
      path.join(run.runDir, 'evaluations', 'ev-1'),
      'evaluation-record.json',
      '{"outcome":"PASS"}',
    );
    await sealEvaluation(run.runDir, 'ev-1');
    await writeArtifact(path.join(run.runDir, 'scores', 'sc-1'), 'score-record.json', '{"score":1}');
    await sealScore(run.runDir, 'sc-1');

    const lines = await readLedgerLines(run.runDir);
    const first = JSON.parse(lines[0] ?? '') as { appended_at: string };
    // Edição mínima e plausível na primeira entrada: só o carimbo de tempo.
    await writeLedgerLines(run.runDir, [
      JSON.stringify({ ...first, appended_at: '2000-01-01T00:00:00.000Z' }),
      ...lines.slice(1),
    ]);

    const report = await verifyRunIntegrity(run.runDir);

    expect(report.ok).toBe(false);
    // A entrada 2 encadeia o sha da linha 1 original, que já não existe.
    expect(kinds(report)).toEqual(['LEDGER_CHAIN_BROKEN']);
    expect(report.violations[0]).toMatchObject({ section: 'evaluations/ev-1' });
  });

  it('detecta remoção da última entrada do ledger junto com sua seção órfã', async () => {
    const run = await sealedRun();
    await writeArtifact(
      path.join(run.runDir, 'evaluations', 'ev-1'),
      'evaluation-record.json',
      '{"outcome":"FAIL"}',
    );
    await sealEvaluation(run.runDir, 'ev-1');

    const lines = await readLedgerLines(run.runDir);
    await writeLedgerLines(run.runDir, lines.slice(0, 1));

    const report = await verifyRunIntegrity(run.runDir);

    expect(report.ok).toBe(false);
    expect(kinds(report)).toEqual(['SECTION_UNRECORDED']);
    expect(report.violations[0]).toMatchObject({ section: 'evaluations/ev-1' });
  });

  it('detecta seção selada que nunca chegou ao ledger', async () => {
    const run = await sealedRun();
    const scoreDir = path.join(run.runDir, 'scores', 'sc-1');
    await writeArtifact(scoreDir, 'score-record.json', '{"score":0.5}');

    // Exatamente o estado de uma falha entre escrever o manifest e registrar.
    await writeSectionManifest(scoreDir, { section: 'scores/sc-1' });

    const report = await verifyRunIntegrity(run.runDir);

    expect(report.ok).toBe(false);
    expect(kinds(report)).toEqual(['SECTION_UNRECORDED']);
    expect(report.sections).toEqual(['execution']);
  });

  it('detecta seção registrada que sumiu do run', async () => {
    const run = await sealedRun();

    await rm(run.executionDir, { recursive: true });

    const report = await verifyRunIntegrity(run.runDir);

    expect(kinds(report)).toEqual(['SECTION_MISSING']);
    expect(report.verifiedArtifacts).toBe(0);
  });

  it('recusa um ledger ausente ou com linha inválida em vez de lançar', async () => {
    const semLedger = await createRunDirectory({ labRoot: await temporaryRoot() });
    const semLedgerReport = await verifyRunIntegrity(semLedger.runDir);
    expect(kinds(semLedgerReport)).toEqual(['LEDGER_MISSING']);
    expect(semLedgerReport.sections).toEqual([]);

    const run = await sealedRun();
    await writeLedgerLines(run.runDir, ['{"schema_version":1,"sequence":']);

    const report = await verifyRunIntegrity(run.runDir);
    expect(kinds(report)).toEqual(['LEDGER_ENTRY_INVALID', 'SECTION_UNRECORDED']);
  });
});

/** Manifest recalculado a partir do disco, como faria quem adultera o run. */
async function forgeManifest(
  sectionDir: string,
  previous: SectionManifest,
): Promise<SectionManifest> {
  const rebuilt = await buildSectionManifest(sectionDir, { section: previous.section });
  return { ...rebuilt, created_at: previous.created_at };
}
