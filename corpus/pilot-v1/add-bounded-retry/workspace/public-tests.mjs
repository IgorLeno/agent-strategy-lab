import assert from 'node:assert/strict';
import test from 'node:test';

import { withBoundedRetry } from './src/bounded-retry.mjs';

test('repete falhas elegíveis até o primeiro sucesso', async () => {
  const attempts = [];
  const transient = new Error('transient');

  const result = await withBoundedRetry(
    async (attempt) => {
      attempts.push(attempt);
      if (attempt < 3) throw transient;
      return 'ok';
    },
    { maxAttempts: 3, shouldRetry: (error) => error === transient },
  );

  assert.equal(result, 'ok');
  assert.deepEqual(attempts, [1, 2, 3]);
});

test('não repete uma falha não elegível', async () => {
  const fatal = new Error('fatal');
  let calls = 0;

  await assert.rejects(
    withBoundedRetry(
      async () => {
        calls += 1;
        throw fatal;
      },
      { maxAttempts: 4, shouldRetry: () => false },
    ),
    (error) => error === fatal,
  );
  assert.equal(calls, 1);
});

test('lança o último erro ao esgotar o limite', async () => {
  const errors = [new Error('first'), new Error('last')];

  await assert.rejects(
    withBoundedRetry(
      async (attempt) => {
        throw errors[attempt - 1];
      },
      { maxAttempts: 2, shouldRetry: () => true },
    ),
    (error) => error === errors[1],
  );
});

test('rejeita maxAttempts inválido antes de chamar a operação', async () => {
  let called = false;

  await assert.rejects(
    withBoundedRetry(
      async () => {
        called = true;
      },
      { maxAttempts: 0, shouldRetry: () => true },
    ),
    TypeError,
  );
  assert.equal(called, false);
});
