/**
 * Descarte do clone efêmero e guarda de fronteira do repo-alvo.
 *
 * O clone existe para ser jogado fora, e o run que falha é justamente o que
 * mais tende a deixar lixo: o agente pode ter criado arquivos grandes, o
 * processo pode ter morrido no meio. Por isso o descarte é `finally`, não um
 * passo do caminho feliz.
 *
 * Descarte aqui significa "o diretório não está mais no disco", conferido
 * depois da remoção. `rm` que devolve sucesso sem ter removido nada — ou que
 * falha por permissão — não pode virar um run "limpo": clone sobrevivente
 * consome disco a cada run e ainda carrega a árvore do agente.
 *
 * A remoção é recursiva e forçada, então cada caminho é conferido antes: só é
 * descartado o que este módulo criou (prefixo do diretório temporário) e o que
 * está fora do repo-alvo. Um `DisposableClone` adulterado apontando para o
 * repositório do usuário apagaria o trabalho dele — a guarda existe para essa
 * chamada morrer antes do primeiro `unlink`.
 */

import type { Stats } from 'node:fs';
import { lstat, readlink, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  CLONE_DIRECTORY_PREFIX,
  createDisposableClone,
  isInside,
  resolveIntendedPath,
  type CreateDisposableCloneOptions,
  type DisposableClone,
} from './clone.js';

/**
 * Teto de saltos ao seguir symlink na guarda de escrita. Cadeia mais longa que
 * isso é recusada em vez de seguida: o objetivo é decidir onde a escrita cairia,
 * e ciclo de symlink não tem resposta.
 */
const MAX_SYMLINK_HOPS = 16;

/**
 * Cria o clone, entrega ao `run` e o descarta — inclusive quando o `run` falha.
 *
 * O erro do `run` é preservado: é ele que explica o run. Quando o descarte
 * também falha, os dois viajam juntos em um `AggregateError`, porque nenhum dos
 * dois pode ser engolido — o do `run` é o resultado do experimento, o do
 * descarte é lixo no disco que alguém precisa remover à mão.
 */
export async function withDisposableClone<T>(
  options: CreateDisposableCloneOptions,
  run: (clone: DisposableClone) => Promise<T>,
): Promise<T> {
  const clone = await createDisposableClone(options);

  let result: T;
  try {
    result = await run(clone);
  } catch (runError) {
    return disposeAfterFailure(clone, runError);
  }

  await disposeClone(clone);
  return result;
}

/**
 * Remove o clone e confirma no disco que ele sumiu.
 *
 * Idempotente: clone já descartado é o estado desejado, não erro. O que é erro
 * é o diretório continuar lá depois da tentativa — aí a causa original da
 * remoção, quando houve, viaja como `cause`.
 */
export async function disposeClone(clone: DisposableClone): Promise<void> {
  const clonePath = assertDisposablePath(clone);

  const entry = await lstatOrNull(clonePath);
  if (entry === null) return;
  // Diretório trocado por arquivo ou symlink no meio do run: não é mais o clone
  // que foi criado, e remover às cegas o que quer que tenha ficado no lugar é
  // exatamente o descuido que o resto deste módulo evita.
  if (!entry.isDirectory()) {
    throw new Error(`caminho do clone não é mais um diretório, descarte recusado: ${clonePath}`);
  }

  let removalError: unknown;
  try {
    await rm(clonePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch (error) {
    removalError = error;
  }

  if ((await lstatOrNull(clonePath)) !== null) {
    throw new Error(`clone não foi descartado, continua no disco: ${clonePath}`, {
      cause: removalError,
    });
  }
}

/**
 * Guarda de escrita: devolve o caminho resolvido quando ele cai dentro do clone
 * e recusa qualquer outro, o repo-alvo em primeiro lugar.
 *
 * Quem escreve durante o run — captura do bundle, logs, arquivos do agente —
 * passa o caminho por aqui antes de tocar no disco. É a única coisa que separa
 * "o agente estragou o descartável" de "o agente escreveu no repositório do
 * usuário", e um `..` ou um symlink bastam para a diferença.
 */
export async function assertWithinClone(clone: DisposableClone, target: string): Promise<string> {
  const resolved = await resolveWriteTarget(target);

  // Conferido antes da fronteira do clone só para dar a mensagem exata: o
  // repo-alvo nunca contém o clone, então esse caminho seria recusado de todo
  // jeito — mas recusado como "fora do clone", que esconde o que aconteceu.
  if (isInside(path.resolve(clone.sourceRepo), resolved)) {
    throw new Error(`escrita no repo-alvo recusada: ${target}`);
  }
  if (!isInside(path.resolve(clone.clonePath), resolved)) {
    throw new Error(`caminho fora do clone descartável: ${target}`);
  }
  return resolved;
}

async function disposeAfterFailure(clone: DisposableClone, runError: unknown): Promise<never> {
  try {
    await disposeClone(clone);
  } catch (disposalError) {
    throw new AggregateError(
      [runError, disposalError],
      `run falhou e o clone não pôde ser descartado: ${clone.clonePath}`,
    );
  }
  throw runError;
}

/**
 * Confere que o caminho pode ser removido recursivamente. Toda condição aqui
 * vale contra um `DisposableClone` que não veio de `createDisposableClone`.
 */
function assertDisposablePath(clone: DisposableClone): string {
  const clonePath = clone.clonePath;
  if (!path.isAbsolute(clonePath)) {
    throw new Error(`caminho do clone precisa ser absoluto para o descarte: ${clonePath}`);
  }
  // O prefixo é a assinatura de `mkdtemp` na criação: sem ele, o caminho não é
  // um clone deste módulo e nada garante que o conteúdo seja descartável.
  if (!path.basename(clonePath).startsWith(CLONE_DIRECTORY_PREFIX)) {
    throw new Error(`descarte recusado, caminho não é um clone descartável: ${clonePath}`);
  }
  if (isInside(path.resolve(clone.sourceRepo), clonePath)) {
    throw new Error(`descarte recusado, caminho está dentro do repo-alvo: ${clonePath}`);
  }
  return clonePath;
}

/**
 * Resolve `target` até o caminho que uma escrita realmente alcançaria.
 *
 * `resolveIntendedPath` sozinho não basta na ponta: ele resolve o trecho que
 * existe, e um symlink quebrado não existe para `access` — passaria por arquivo
 * novo dentro do clone mesmo apontando para dentro do repo-alvo, que é
 * exatamente onde a escrita cairia.
 */
async function resolveWriteTarget(target: string): Promise<string> {
  let current = path.resolve(target);
  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop += 1) {
    const link = await readlinkOrNull(current);
    if (link === null) return resolveIntendedPath(current);
    current = path.resolve(path.dirname(current), link);
  }
  throw new Error(`cadeia de symlinks longa demais para conferir a fronteira: ${target}`);
}

async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await lstat(target);
  } catch {
    return null;
  }
}

/** Alvo do symlink, ou null quando não existe ou não é symlink. */
async function readlinkOrNull(target: string): Promise<string | null> {
  try {
    return await readlink(target);
  } catch {
    return null;
  }
}
