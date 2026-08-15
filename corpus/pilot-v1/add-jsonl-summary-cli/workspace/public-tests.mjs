import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const cliPath = new URL('./src/summarize-runs.mjs', import.meta.url);

async function withInput(contents, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-jsonl-summary-'));
  const inputPath = path.join(root, 'runs.jsonl');
  try {
    await writeFile(inputPath, contents, 'utf8');
    return run(inputPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function invoke(args) {
  return spawnSync(process.execPath, [cliPath.pathname, ...args], { encoding: 'utf8' });
}

test('resume outcomes e ignora linhas vazias', async () => {
  const result = await withInput(
    '{"outcome":"SUCCESS"}\n\n{"outcome":"FAILURE"}\n{"outcome":"SUCCESS"}\n',
    (inputPath) => invoke([inputPath]),
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { total: 3, success: 2, failure: 1 });
});

test('falha de forma curta para JSON ou outcome inválido', async () => {
  for (const contents of ['not-json\n', '{"outcome":"SKIPPED"}\n']) {
    const result = await withInput(contents, (inputPath) => invoke([inputPath]));

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^erro: .+\n$/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  }
});

test('exige exatamente um argumento e reporta erro de leitura', () => {
  for (const args of [[], ['one', 'two'], ['/path/that/does/not/exist']]) {
    const result = invoke(args);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^erro: .+\n$/);
  }
});
