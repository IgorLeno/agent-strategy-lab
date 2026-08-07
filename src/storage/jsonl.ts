import { appendFile } from 'node:fs/promises';
import path from 'node:path';

const appendQueues = new Map<string, Promise<void>>();

/**
 * Acrescenta um valor como uma única linha JSON, preservando a ordem dos
 * appends concorrentes feitos por este processo para o mesmo arquivo.
 */
export async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return Promise.reject(new TypeError('valor não pode ser serializado como JSON'));
  }

  const queueKey = path.resolve(filePath);
  const previous = appendQueues.get(queueKey) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => appendFile(filePath, `${serialized}\n`, 'utf8'));

  appendQueues.set(queueKey, current);
  const clearQueue = (): void => {
    if (appendQueues.get(queueKey) === current) {
      appendQueues.delete(queueKey);
    }
  };
  void current.then(clearQueue, clearQueue);

  return current;
}
