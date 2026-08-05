import { describe, expect, it } from 'vitest';
import { LAB_CORE_VERSION } from '../src/core/version.js';

describe('scaffold', () => {
  it('expõe a versão do núcleo', () => {
    expect(LAB_CORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
