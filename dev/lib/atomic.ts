import { mkdir, rename, writeFile } from 'node:fs/promises';
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

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}
