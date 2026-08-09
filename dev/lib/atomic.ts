import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Escrita atômica: arquivo temporário no MESMO diretório e `rename`, que em
 * POSIX é atômico dentro do filesystem. Um crash no meio deixa o arquivo
 * anterior intacto, nunca um JSON pela metade — records lidos como evidência
 * não podem ter estado intermediário observável.
 *
 * O sufixo carrega o pid: dois processos escrevendo o mesmo destino não
 * corrompem o temporário um do outro (quem chega por último vence o rename,
 * e é o lock do harness que decide que isso não aconteça).
 */
export async function writeFileAtomic(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, contents, 'utf8');
  await rename(temporary, file);
}

/**
 * Bytes EXATOS que qualquer publicação JSON do harness grava. Quem precisa
 * hashear um record antes de escrevê-lo — ou provar que dois caminhos de
 * escrita produziram o mesmo arquivo — tem que derivar o hash daqui, não de
 * uma segunda serialização parecida.
 */
export function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, jsonBytes(value).toString('utf8'));
}

/** Publicação append-only: replay só é válido quando os bytes são idênticos. */
export async function writeFileOnce(file: string, bytes: Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  try {
    const existing = await readFile(file);
    if (existing.equals(bytes)) return;
    throw new Error(`artifact append-only diverge: ${file}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, bytes, { flag: 'wx' });
  try {
    await link(temporary, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await readFile(file);
    if (!existing.equals(bytes)) throw new Error(`artifact append-only diverge: ${file}`);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function writeJsonOnce(file: string, value: unknown): Promise<void> {
  await writeFileOnce(file, jsonBytes(value));
}
