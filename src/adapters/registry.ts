/**
 * Registro de `ProviderAdapter`s por identificador de cli (`AgentProfile.cli`).
 * `resolveAdapter` é a única forma de ir de uma string de perfil até um
 * adapter — cli desconhecida falha explicitamente, nomeando o que está
 * registrado, em vez de deixar quem chama descobrir via `undefined`.
 */
import { fakeAdapter } from './fake/index.js';
import type { ProviderAdapter } from './contract.js';

const ADAPTERS: readonly ProviderAdapter[] = [fakeAdapter];

const REGISTRY = new Map<string, ProviderAdapter>(
  ADAPTERS.map((adapter) => [adapter.identity.name, adapter]),
);

export function resolveAdapter(cli: string): ProviderAdapter {
  const adapter = REGISTRY.get(cli);
  if (adapter === undefined) {
    const known = [...REGISTRY.keys()].sort().join(', ');
    throw new Error(`adapter desconhecido para cli "${cli}" — adapters registrados: ${known}`);
  }
  return adapter;
}
