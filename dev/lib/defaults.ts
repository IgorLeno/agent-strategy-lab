/**
 * Perfil padrão de TODO comando que pode gastar: um só lugar, para que não
 * exista um default de API esquecido em algum CLI. A política é assinatura, e
 * perfil de cobrança por API nunca é fallback automático — precisa ser pedido
 * pelo nome e autorizado à mão.
 */
export const DEFAULT_WORKER_PROFILE_ID = 'claude-build-worker-subscription-v1';
