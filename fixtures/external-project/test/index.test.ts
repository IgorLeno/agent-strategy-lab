import { describe, expect, it } from 'vitest';

import { greet } from '../src/index.js';

describe('greet', () => {
  it('cumprimenta pelo nome', () => {
    expect(greet('lab')).toBe('hello, lab');
  });
});
