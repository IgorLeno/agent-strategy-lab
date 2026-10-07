import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * O renderer não importa `@asl/core` (plano, Fase 2): só fala com o main por
 * IPC tipado. Vale também para `src/shared`, que o renderer importa. Sem
 * Node e sem Electron ali: o renderer roda em sandbox.
 */
const SRC = path.resolve(import.meta.dirname, '..', 'src');
const IMPORT_SPECIFIER = /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;
const ALLOWED_PACKAGES = new Set(['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime']);

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
    }),
  );
  return nested.flat();
}

describe('fronteira do renderer', () => {
  it('renderer e shared importam só React e arquivos de renderer/shared', async () => {
    const roots = [path.join(SRC, 'renderer'), path.join(SRC, 'shared')];
    const violations: string[] = [];
    for (const root of roots) {
      for (const file of await sourceFiles(root)) {
        const text = await readFile(file, 'utf8');
        for (const match of text.matchAll(IMPORT_SPECIFIER)) {
          const specifier = match[1] ?? match[2] ?? match[3];
          if (specifier === undefined) continue;
          const where = `${path.relative(SRC, file)} -> ${specifier}`;
          if (specifier.startsWith('.')) {
            const target = path.resolve(path.dirname(file), specifier);
            if (!roots.some((allowed) => target.startsWith(allowed + path.sep))) violations.push(where);
          } else if (!ALLOWED_PACKAGES.has(specifier)) {
            violations.push(where);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('o teste enxerga violações', () => {
    const text = "import { PlanLoop } from '@asl/core';\nimport fs from 'node:fs';";
    const found = [...text.matchAll(IMPORT_SPECIFIER)].map((match) => match[1] ?? match[2] ?? match[3]);
    expect(found).toEqual(['@asl/core', 'node:fs']);
  });
});
