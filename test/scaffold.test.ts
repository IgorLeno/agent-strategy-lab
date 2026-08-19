import { existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LAB_CORE_VERSION } from '../src/core/version.js';

/**
 * Áreas do produto declaradas em docs/ARCHITECTURE.md. A lista é escrita à
 * mão de propósito: derivá-la do próprio diretório faria o teste concordar
 * com qualquer layout, inclusive com uma área apagada por engano.
 */
const AREAS = [
  'adapters',
  'billing',
  'cli',
  'core',
  'credentials',
  'envelope',
  'evaluator',
  'experiment',
  'inspection',
  'intake',
  'performance',
  'planner',
  'project',
  'reporting',
  'routing',
  'runner',
  'schemas',
  'scorer',
  'storage',
  'workspace',
  'strategies',
] as const;

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));

describe('scaffold', () => {
  it('expõe a versão do núcleo', () => {
    expect(LAB_CORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('tem um index.ts em cada área declarada', () => {
    const semIndex = AREAS.filter((area) => !existsSync(`${srcDir}${area}/index.ts`));
    expect(semIndex).toEqual([]);
  });

  it('não tem área em src/ fora da lista declarada', () => {
    const noDisco = readdirSync(srcDir).filter((entry) =>
      statSync(`${srcDir}${entry}`).isDirectory(),
    );
    expect(noDisco.sort()).toEqual([...AREAS].sort());
  });
});
