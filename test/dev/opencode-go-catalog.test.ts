/**
 * Os seis profiles OpenCode Go atuais contra o catálogo local (`opencode models`).
 * Igualdade EXATA do model id. Nenhuma inferência, nenhuma API paga.
 */
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import { loadProfileFromCatalog } from '../../dev/lib/profile.js';
import { REPO_ROOT } from './helpers.js';

const run = promisify(execFile);

const GO_PROFILE_PREFIX = 'opencode-go-';

type ModelStatus = 'AVAILABLE' | 'STALE MODEL ID' | 'INVALID PROFILE';

async function listedModels(): Promise<string[] | null> {
  try {
    const { stdout } = await run('opencode', ['models'], { timeout: 30_000 });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return null;
  }
}

describe('catálogo local dos seis profiles OpenCode Go', () => {
  it('cada model id pinado existe por igualdade exata em `opencode models`', async () => {
    const listed = await listedModels();
    if (listed === null) {
      console.warn('opencode não instalado: catálogo Go não verificado nesta máquina');
      return;
    }
    const catalog = new Set(listed);
    const files = (await readdir(path.join(REPO_ROOT, 'dev', 'profiles')))
      .filter((entry) => entry.startsWith(GO_PROFILE_PREFIX) && entry.endsWith('.yaml'))
      .sort();
    expect(files).toHaveLength(6);

    const report: { id: string; model: string; status: ModelStatus }[] = [];
    for (const file of files) {
      const id = file.slice(0, -'.yaml'.length);
      try {
        const profile = await loadProfileFromCatalog(REPO_ROOT, id);
        const model = profile.argv[profile.argv.indexOf('--model') + 1];
        if (typeof model !== 'string' || model.length === 0) {
          report.push({ id, model: '', status: 'INVALID PROFILE' });
          continue;
        }
        report.push({
          id,
          model,
          status: catalog.has(model) ? 'AVAILABLE' : 'STALE MODEL ID',
        });
      } catch {
        report.push({ id, model: '', status: 'INVALID PROFILE' });
      }
    }

    expect(report.map((entry) => entry.status)).toEqual(Array(6).fill('AVAILABLE'));
    expect(report.map((entry) => entry.model).every((model) => catalog.has(model))).toBe(true);
  }, 60_000);
});
