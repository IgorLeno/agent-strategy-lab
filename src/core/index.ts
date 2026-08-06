/**
 * Núcleo: vocabulário que todas as outras áreas importam — enums das três
 * dimensões (execução, avaliação, qualificação), tipos base e a hierarquia de
 * erros do lab.
 *
 * Fronteira: nada aqui faz I/O. Uma área de núcleo que lê disco vira
 * dependência circular de `storage` na primeira refatoração.
 *
 * Preenchido por M02.
 */
export { LAB_CORE_VERSION } from './version.js';
