import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { REPO_ROOT } from './helpers.js';

it.skipIf(process.platform !== 'linux')('real CLI preserves terminal input and resumes progress after EOF', async () => {
  const { stdout } = await promisify(execFile)('python3', [
    'test/fixtures/lab-input/pty.py', process.execPath,
  ], { cwd: REPO_ROOT, timeout: 55_000 });
  const result = JSON.parse(stdout);
  expect(result.eof.byte_equal).toBe(true);
  expect(result.eof.received_bytes).toBeGreaterThan(15_000);
  expect(result.eof.redraws_during_input).toBe(0);
  expect(result.eof.progress_during_input).toBe(0);
  expect(result.eof.first_frame_appended).toBe(true);
  expect(result.eof.progress_after_eof).toBeGreaterThanOrEqual(2);
  expect(result.interrupt.terminal_restored).toBe(true);
  expect(result.unterminated).toEqual({ byte_equal: true, fresh_line: true });
  expect(result.pipe).toBe('byte_equal');
  expect(result.file).toBe('byte_equal');
}, 60_000);
