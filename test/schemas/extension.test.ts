import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { canonicalSha256 } from '../../src/envelope/index.js';
import {
  ExtensionManifest,
  IncubationState,
  loadExtension,
} from '../../src/schemas/index.js';

const temporaryRoots: string[] = [];

async function temporaryExtension(
  manifestSource: string,
  incubationSource?: string,
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-extension-'));
  temporaryRoots.push(root);
  const directory = path.join(root, 'extensions', 'skill', 'reviewer', '1');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'extension.yaml'), manifestSource, 'utf8');
  if (incubationSource !== undefined) {
    await writeFile(path.join(directory, 'incubation.yaml'), incubationSource, 'utf8');
  }
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

const validManifest =
  'kind: skill\nname: reviewer\nversion: 1\ndescription: Revisa mudanças antes do merge.\n';

describe('ExtensionManifest', () => {
  it('parses a valid manifest', () => {
    const input: ExtensionManifest = {
      kind: 'skill',
      name: 'reviewer',
      version: 1,
      description: 'Revisa mudanças antes do merge.',
    };

    expect(ExtensionManifest.parse(input)).toEqual(input);
  });

  it.each([
    { kind: 'strategy', name: 'other name', version: 1, description: 'x' },
    { kind: 'strategy', name: 'reviewer', version: 0, description: 'x' },
    { kind: 'strategy', name: 'reviewer', version: 1, description: '   ' },
    { kind: 'unknown_kind', name: 'reviewer', version: 1, description: 'x' },
  ])('rejects an invalid manifest', (input) => {
    expect(ExtensionManifest.safeParse(input).success).toBe(false);
  });

  it('rejects a manifest carrying a lifecycle/status field', () => {
    const input = {
      kind: 'skill',
      name: 'reviewer',
      version: 1,
      description: 'Revisa mudanças antes do merge.',
      status: 'DISCOVERED',
    };

    expect(ExtensionManifest.safeParse(input).success).toBe(false);
  });
});

describe('IncubationState', () => {
  it('parses a valid state', () => {
    const input: IncubationState = {
      status: 'CANDIDATE',
      updated_at: '2026-08-12T00:00:00.000Z',
      kind: 'skill',
      name: 'reviewer',
      version: 1,
    };

    expect(IncubationState.parse(input)).toEqual(input);
  });

  it('rejects a status outside the enum', () => {
    const input = {
      status: 'RETIRED',
      updated_at: '2026-08-12T00:00:00.000Z',
      kind: 'skill',
      name: 'reviewer',
      version: 1,
    };

    expect(IncubationState.safeParse(input).success).toBe(false);
  });
});

describe('loadExtension', () => {
  it('loads a valid manifest with no incubation.yaml as DISCOVERED default, without writing to disk', async () => {
    const root = await temporaryExtension(validManifest);

    const extension = await loadExtension(root, 'skill', 'reviewer', 1);

    expect(extension.manifest).toEqual({
      kind: 'skill',
      name: 'reviewer',
      version: 1,
      description: 'Revisa mudanças antes do merge.',
    });
    expect(extension.incubation.status).toBe('DISCOVERED');
    expect(extension.incubation.kind).toBe('skill');
    expect(extension.incubation.name).toBe('reviewer');
    expect(extension.incubation.version).toBe(1);

    const incubationPath = path.join(
      root,
      'extensions',
      'skill',
      'reviewer',
      '1',
      'incubation.yaml',
    );
    expect(existsSync(incubationPath)).toBe(false);
  });

  it('loads a valid incubation.yaml alongside the manifest', async () => {
    const root = await temporaryExtension(
      validManifest,
      'status: SANDBOXED\nupdated_at: "2026-08-12T00:00:00.000Z"\nkind: skill\nname: reviewer\nversion: 1\n',
    );

    const extension = await loadExtension(root, 'skill', 'reviewer', 1);

    expect(extension.incubation).toEqual({
      status: 'SANDBOXED',
      updated_at: '2026-08-12T00:00:00.000Z',
      kind: 'skill',
      name: 'reviewer',
      version: 1,
    });
  });

  it('rejects a manifest whose declared identity differs from its path', async () => {
    const root = await temporaryExtension(
      'kind: skill\nname: other\nversion: 1\ndescription: x\n',
    );

    await expect(loadExtension(root, 'skill', 'reviewer', 1)).rejects.toThrow(
      /declara skill\/other@1, esperado skill\/reviewer@1/,
    );
  });

  it('rejects an incubation.yaml with a status outside the enum', async () => {
    const root = await temporaryExtension(
      validManifest,
      'status: RETIRED\nupdated_at: "2026-08-12T00:00:00.000Z"\nkind: skill\nname: reviewer\nversion: 1\n',
    );

    await expect(loadExtension(root, 'skill', 'reviewer', 1)).rejects.toThrow();
  });

  it('rejects an incubation.yaml whose identity differs from the manifest', async () => {
    const root = await temporaryExtension(
      validManifest,
      'status: CANDIDATE\nupdated_at: "2026-08-12T00:00:00.000Z"\nkind: skill\nname: other\nversion: 1\n',
    );

    await expect(loadExtension(root, 'skill', 'reviewer', 1)).rejects.toThrow(
      /declara skill\/other@1, esperado skill\/reviewer@1/,
    );
  });

  it('keeps the manifest canonical hash unchanged when incubation.yaml changes', async () => {
    const root = await temporaryExtension(
      validManifest,
      'status: CANDIDATE\nupdated_at: "2026-08-12T00:00:00.000Z"\nkind: skill\nname: reviewer\nversion: 1\n',
    );
    const before = await loadExtension(root, 'skill', 'reviewer', 1);
    const hashBefore = canonicalSha256(before.manifest);

    await writeFile(
      path.join(root, 'extensions', 'skill', 'reviewer', '1', 'incubation.yaml'),
      'status: BENCHMARKED\nupdated_at: "2026-08-12T01:00:00.000Z"\nkind: skill\nname: reviewer\nversion: 1\n',
      'utf8',
    );
    const after = await loadExtension(root, 'skill', 'reviewer', 1);
    const hashAfter = canonicalSha256(after.manifest);

    expect(hashAfter).toBe(hashBefore);
    expect(after.incubation.status).toBe('BENCHMARKED');
  });
});
