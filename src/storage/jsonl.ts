import { appendFile } from 'node:fs/promises';
import path from 'node:path';

const fileQueues = new Map<string, Promise<unknown>>();

/**
 * Serializa operações sobre o mesmo arquivo dentro deste processo, preservando
 * a ordem em que foram pedidas. Uma operação que falha não interrompe a fila.
 */
export function queueFileWrite<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const queueKey = path.resolve(filePath);
  const previous = fileQueues.get(queueKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);

  fileQueues.set(queueKey, current);
  const clearQueue = (): void => {
    if (fileQueues.get(queueKey) === current) {
      fileQueues.delete(queueKey);
    }
  };
  void current.then(clearQueue, clearQueue);

  return current;
}

/**
 * Acrescenta um valor como uma única linha JSON, preservando a ordem dos
 * appends concorrentes feitos por este processo para o mesmo arquivo.
 */
export async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return Promise.reject(new TypeError('valor não pode ser serializado como JSON'));
  }

  return queueFileWrite(filePath, () => appendFile(filePath, `${serialized}\n`, 'utf8'));
}
