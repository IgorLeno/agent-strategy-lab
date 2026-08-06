/**
 * Carregamento e validação de estratégias: receitas declarativas versionadas
 * em `strategies/<nome>/<versão>/strategy.yaml`, fora de `src/`.
 *
 * Fronteira: estratégia é DADO versionado, não código. Nome e versão entram no
 * envelope de execução — trocar a receita sem trocar a versão faria dois runs
 * diferentes compartilharem o mesmo hash.
 *
 * Preenchido por M05.
 */
export {};
