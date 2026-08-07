import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveHarnessPaths } from '../../dev/lib/paths.js';
import {
  runOfficialValidation,
  writeValidationArtifactOnce,
} from '../../dev/lib/validation-evidence.js';
import { makeTempDevDir } from './helpers.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('official validation evidence', () => {
  it('preserva streams exatos, hashes, bytes e metadata sem output bruto', async () => {
    const devDir = await makeTempDevDir();
    roots.push(devDir);
    const paths = resolveHarnessPaths(devDir);
    const command = {
      argv: [
        'bash',
        '-c',
        'printf %s "$TEST_STDOUT"; printf %s "$TEST_STDERR" >&2',
      ],
      timeout_seconds: 30,
    };

    const execution = await runOfficialValidation({
      paths,
      taskId: 'M03B',
      attempt: 1,
      command,
      env: { ...process.env, TEST_STDOUT: 'saída\n', TEST_STDERR: 'erro\n' },
    });

    const stdout = Buffer.from('saída\n');
    const stderr = Buffer.from('erro\n');
    expect(execution.result.argv).toEqual(command.argv);
    expect(execution.result.exit_code).toBe(0);
    expect(execution.evidence).toMatchObject({
      sequence: 1,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: stdout.byteLength,
      stderr_bytes: stderr.byteLength,
      stdout_path: 'validation-logs/M03B/attempt-1/0001.stdout.log',
      stderr_path: 'validation-logs/M03B/attempt-1/0001.stderr.log',
    });
    expect(
      await readFile(path.join(paths.devDir, execution.evidence.stdout_path)),
    ).toEqual(stdout);
    expect(
      await readFile(path.join(paths.devDir, execution.evidence.stderr_path)),
    ).toEqual(stderr);

    const metadataFile = path.join(
      paths.validationLogsDir,
      'M03B',
      'attempt-1',
      '0001.json',
    );
    const metadataText = await readFile(metadataFile, 'utf8');
    expect(JSON.parse(metadataText)).toEqual(execution.evidence);
    expect(metadataText).not.toContain('saída');
    expect(metadataText).not.toContain('erro\\n');
  });

  it('usa sequência monotônica sem sobrescrever artifacts existentes', async () => {
    const devDir = await makeTempDevDir();
    roots.push(devDir);
    const paths = resolveHarnessPaths(devDir);
    const input = {
      paths,
      taskId: 'T1',
      attempt: 2,
      command: {
        argv: ['printf', 'x'],
        timeout_seconds: 30,
      },
    };

    const first = await runOfficialValidation(input);
    const second = await runOfficialValidation(input);

    expect(first.result.exit_code).toBe(0);
    expect(second.result.exit_code).toBe(0);
    expect(first.evidence.sequence).toBe(1);
    expect(second.evidence.sequence).toBe(2);
    expect(await readFile(path.join(paths.devDir, first.evidence.stdout_path), 'utf8')).toBe('x');
  });

  it('recusa overwrite divergente e aceita replay byte-idêntico', async () => {
    const devDir = await makeTempDevDir();
    roots.push(devDir);
    const file = path.join(devDir, 'immutable.log');

    await writeValidationArtifactOnce(file, Buffer.from('original'));
    await expect(writeValidationArtifactOnce(file, Buffer.from('original'))).resolves.toBeUndefined();
    await expect(writeValidationArtifactOnce(file, Buffer.from('alterado'))).rejects.toThrow(
      /append-only|diverge/i,
    );
    expect(await readFile(file, 'utf8')).toBe('original');
  });
});
