/**
 * Workspace efêmero do agente: clone descartável do repo-alvo no base SHA,
 * cleanup garantido e captura do resultado como change bundle.
 *
 * Fronteira: clone INDEPENDENTE, nunca linked worktree — worktree compartilha
 * objects, refs e config com o repositório do usuário, e o agente alcança tudo
 * isso. O repo-alvo original é protegido por guarda explícita.
 *
 * Preenchido por M18, M19 e M20.
 */
export {
  createDisposableClone,
  CLONE_DIRECTORY_PREFIX,
  WORKSPACE_BRANCH,
  type CreateDisposableCloneOptions,
  type DisposableClone,
} from './clone.js';
export { assertWithinClone, disposeClone, withDisposableClone } from './cleanup.js';
