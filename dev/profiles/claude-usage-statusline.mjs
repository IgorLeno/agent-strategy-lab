import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return;

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  const projectDir =
    input?.workspace?.project_dir ??
    input?.workspace?.current_dir ??
    input?.cwd;

  if (typeof projectDir !== 'string' || projectDir.length === 0) return;

  let taskId = null;
  let attempt = null;

  try {
    const state = JSON.parse(
      await readFile(path.join(projectDir, '.dev', 'state.json'), 'utf8'),
    );

    const active = Array.isArray(state.tasks)
      ? state.tasks.find(
          (task) =>
            task?.status === 'RUNNING' ||
            task?.phase === 'FINALIZING',
        )
      : null;

    if (active) {
      taskId = typeof active.id === 'string' ? active.id : null;
      attempt = Number.isInteger(active.attempts)
        ? active.attempts
        : null;
    }
  } catch {
    // Probe observacional: ausência de state nunca pode afetar o worker.
  }

  const taskSegment = taskId ?? 'unassigned';
  const attemptSegment =
    attempt === null ? 'attempt-unknown' : `attempt-${attempt}`;

  const dir = path.join(
    projectDir,
    '.dev',
    'usage-probe',
    taskSegment,
    attemptSegment,
  );

  await mkdir(dir, { recursive: true });

  const record = {
    schema_version: 1,
    source: 'claude_statusline',
    captured_at: new Date().toISOString(),

    task_id: taskId,
    attempt,

    session_id:
      typeof input.session_id === 'string'
        ? input.session_id
        : null,

    claude_code_version:
      typeof input.version === 'string'
        ? input.version
        : null,

    model: input.model ?? null,
    effort: input.effort ?? null,

    rate_limits: input.rate_limits ?? null,

    cost: input.cost ?? null,

    context_window:
      input.context_window == null
        ? null
        : {
            total_input_tokens:
              input.context_window.total_input_tokens ?? null,
            total_output_tokens:
              input.context_window.total_output_tokens ?? null,
            used_percentage:
              input.context_window.used_percentage ?? null,
          },
  };

  await appendFile(
    path.join(dir, 'claude-statusline.jsonl'),
    `${JSON.stringify(record)}\n`,
    'utf8',
  );
}

/*
 * Instrumentação nunca deve interferir na execução do worker.
 * Qualquer falha do probe é deliberadamente não-fatal.
 */
main().catch(() => {});
