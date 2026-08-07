import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalJson } from '../../dev/lib/canonical.js';
import {
  commitTree,
  git,
  headSha,
  parsePorcelainV1Z,
  patchFingerprint,
  restoreStagedFiles,
  stageFiles,
  stagedFiles,
  workingTreeFiles,
  workingTreeSnapshot,
  writeTree,
} from '../../dev/lib/git.js';
import { runGit } from './helpers.js';

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(path.join(os.tmpdir(), 'agentlab-git-'));
  await runGit(repoRoot, ['init', '-q']);
  await runGit(repoRoot, ['config', 'user.name', 'Harness Test']);
  await runGit(repoRoot, ['config', 'user.email', 'harness-test@example.invalid']);
  await writeFile(path.join(repoRoot, 'base.txt'), 'base\n');
  await runGit(repoRoot, ['add', '--', 'base.txt']);
  await runGit(repoRoot, ['commit', '-q', '-m', 'base']);
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

describe('porcelain v1 -z', () => {
  it('preserva espaços e consome o segundo path de rename/copy', () => {
    expect(
      parsePorcelainV1Z(
        '?? new file.txt\0R  renamed file.txt\0old file.txt\0C  copied file.txt\0source file.txt\0',
      ),
    ).toEqual([
      { status: '??', path: 'new file.txt', originalPath: null },
      { status: 'R ', path: 'renamed file.txt', originalPath: 'old file.txt' },
      { status: 'C ', path: 'copied file.txt', originalPath: 'source file.txt' },
    ]);
  });

  it('descobre modified, added, deleted, untracked e os dois lados de rename', async () => {
    await writeFile(path.join(repoRoot, 'modified.txt'), 'antes\n');
    await writeFile(path.join(repoRoot, 'deleted.txt'), 'apagar\n');
    await writeFile(path.join(repoRoot, 'old name.txt'), 'renomear\n');
    await runGit(repoRoot, ['add', '--', 'modified.txt', 'deleted.txt', 'old name.txt']);
    await runGit(repoRoot, ['commit', '-q', '-m', 'tracked']);

    await writeFile(path.join(repoRoot, 'modified.txt'), 'depois\n');
    await unlink(path.join(repoRoot, 'deleted.txt'));
    await rename(path.join(repoRoot, 'old name.txt'), path.join(repoRoot, 'new name.txt'));
    await runGit(repoRoot, ['add', '--', 'old name.txt', 'new name.txt']);
    await writeFile(path.join(repoRoot, 'added.txt'), 'added\n');
    await runGit(repoRoot, ['add', '--', 'added.txt']);
    await writeFile(path.join(repoRoot, 'untracked file.txt'), 'untracked\n');

    const snapshot = await workingTreeSnapshot(repoRoot);
    expect(snapshot.find((entry) => entry.status.includes('R'))).toMatchObject({
      path: 'new name.txt',
      originalPath: 'old name.txt',
    });
    expect(await workingTreeFiles(repoRoot)).toEqual([
      'added.txt',
      'deleted.txt',
      'modified.txt',
      'new name.txt',
      'old name.txt',
      'untracked file.txt',
    ]);
  });
});

describe('patch fingerprint e index staged', () => {
  it('muda quando o conteúdo muda sem mudar o conjunto de paths', async () => {
    await writeFile(path.join(repoRoot, 'new.txt'), 'primeiro\n');
    const beforeFiles = await workingTreeFiles(repoRoot);
    const before = await patchFingerprint(repoRoot);

    await writeFile(path.join(repoRoot, 'new.txt'), 'segundo\n');

    expect(await workingTreeFiles(repoRoot)).toEqual(beforeFiles);
    expect(await patchFingerprint(repoRoot)).not.toBe(before);
  });

  it('representa deleção com conteúdo null no payload canônico', async () => {
    await writeFile(path.join(repoRoot, 'deleted.txt'), 'conteúdo\n');
    await runGit(repoRoot, ['add', '--', 'deleted.txt']);
    await runGit(repoRoot, ['commit', '-q', '-m', 'deleted fixture']);
    await unlink(path.join(repoRoot, 'deleted.txt'));

    const payload = canonicalJson([
      {
        status: ' D',
        path: 'deleted.txt',
        original_path: null,
        current_content_sha256: null,
      },
    ]);
    const expected = createHash('sha256').update(payload).digest('hex');
    expect(await patchFingerprint(repoRoot)).toBe(expected);
  });

  it('cached diff-check cobre arquivo novo e restaura só o index', async () => {
    const file = 'new whitespace.txt';
    const content = 'linha com espaço   \n';
    await writeFile(path.join(repoRoot, file), content);

    await stageFiles(repoRoot, [file]);
    const diffCheck = await git(repoRoot, ['diff', '--cached', '--check']);
    expect(diffCheck.exitCode).not.toBe(0);

    await restoreStagedFiles(repoRoot, [file]);
    expect(await stagedFiles(repoRoot)).toEqual([]);
    expect(await readFile(path.join(repoRoot, file), 'utf8')).toBe(content);
    expect(await workingTreeFiles(repoRoot)).toEqual([file]);
  });

  it('compara a tree staged com a tree de um commit', async () => {
    const base = await headSha(repoRoot);
    expect(await writeTree(repoRoot)).toBe(await commitTree(repoRoot, base));

    await writeFile(path.join(repoRoot, 'next.txt'), 'next\n');
    await stageFiles(repoRoot, ['next.txt']);
    expect(await writeTree(repoRoot)).not.toBe(await commitTree(repoRoot, base));
  });
});
