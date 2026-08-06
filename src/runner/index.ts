/**
 * Runner de processo do produto: spawn por argv (sem shell), captura
 * incremental de stdout/stderr, timeout com escalada de sinal e auditoria de
 * sobreviventes.
 *
 * Fronteira: este é o runner do `agentlab`. O launcher do harness de sessões
 * descartáveis (`dev/`) é outro código e não deve ser reusado aqui.
 *
 * Sinais vão ao process group, não ao pid: matar só o pai deixa descendente
 * vivo mexendo no workspace. Cleanup não confirmado é INFRA_ERROR, nunca
 * COMPLETED silencioso.
 *
 * Preenchido por M21, M22, M23, M24A e M24B.
 */
export {};
