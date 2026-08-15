import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeTags } from './src/normalize-tags.mjs';

test('normaliza, descarta vazias e remove duplicatas em ordem estável', () => {
  assert.deepEqual(
    normalizeTags(['  Node ', 'TEST', 'node', '   ', 'Test', 'cli']),
    ['node', 'test', 'cli'],
  );
});

test('não altera o array de entrada', () => {
  const input = [' A ', 'B'];

  normalizeTags(input);

  assert.deepEqual(input, [' A ', 'B']);
});
