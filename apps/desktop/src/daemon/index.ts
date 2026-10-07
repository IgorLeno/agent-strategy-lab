/**
 * Entrada do `utilityProcess`: lock de instância, `Daemon` e a ponte de
 * mensagens com o main. Diretório de dados vem de `ASL_DATA_DIR` (o main
 * passa o mesmo do `asl` CLI, `$XDG_DATA_HOME/asl`).
 *
 * `ASL_FAKE_AGENT` (caminho do fake-agent.mjs) troca o catálogo pelo agente
 * fake — só para o teste de UI, que não gasta quota.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import type { AdapterInvocation, InvocationRequest, ModelProfile } from '@asl/core';

import type { DaemonMessage, DaemonRequest } from '../shared/ipc.js';
import { Daemon } from './daemon.js';
import { acquireInstanceLock } from './instance-lock.js';

const port = process.parentPort;
const post = (message: DaemonMessage): void => port.postMessage(message);

function fakeAgent(): { catalog: readonly ModelProfile[]; invoke: (request: InvocationRequest) => AdapterInvocation } | null {
  const agent = process.env['ASL_FAKE_AGENT'];
  if (agent === undefined || agent === '') return null;
  const profile = (id: string, tier: ModelProfile['tier'], rank: number): ModelProfile => ({
    id,
    scaffold: 'fake',
    provider: 'none',
    model: id,
    effort: null,
    tier,
    cost_rank: rank,
  }) as ModelProfile;
  return {
    catalog: [profile('fake-economy', 'economy', 1), profile('fake-balanced', 'balanced', 1), profile('fake-frontier', 'frontier', 1)],
    invoke: (request) => ({
      // Dentro do Electron, `execPath` é o binário do app: roda como Node puro.
      argv: [process.execPath, agent, request.profile.id],
      env: {
        PATH: process.env['PATH'] ?? '',
        ELECTRON_RUN_AS_NODE: '1',
        ASL_FAKE_SCRIPT: process.env['ASL_FAKE_SCRIPT'] ?? '',
        ...request.extraEnv,
      },
      stdin: request.prompt,
    }),
  };
}

function main(): void {
  const dataDir = process.env['ASL_DATA_DIR'];
  if (dataDir === undefined || dataDir === '') {
    post({ kind: 'fatal', error: 'ASL_DATA_DIR ausente' });
    return;
  }
  // Primeiro uso: o diretório ainda não existe e o lock precisa dele.
  mkdirSync(dataDir, { recursive: true });
  const lock = acquireInstanceLock(path.join(dataDir, 'daemon.lock'));
  if (!lock.ok) {
    post({ kind: 'fatal', error: `outro daemon do ASL já está rodando (pid ${lock.owner.pid})` });
    return;
  }

  const fake = fakeAgent();
  const daemon = new Daemon({
    ledgerPath: process.env['ASL_LEDGER'] ?? path.join(dataDir, 'ledger.db'),
    projectsFile: path.join(dataDir, 'projects.json'),
    sourceEnv: process.env,
    emit: (event) => post({ kind: 'event', event }),
    ...(fake === null ? {} : fake),
  });

  let closing = false;
  port.on('message', (message: { data: DaemonRequest }) => {
    const request = message.data;
    if (request.kind === 'shutdown') {
      if (closing) return;
      closing = true;
      void daemon.shutdown().finally(() => {
        lock.release();
        process.exit(0);
      });
      return;
    }
    daemon.handle(request.command, request.args).then(
      (result) => post({ kind: 'response', id: request.id, ok: true, result }),
      (error: unknown) =>
        post({ kind: 'response', id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
  });
}

try {
  main();
} catch (error) {
  post({ kind: 'fatal', error: error instanceof Error ? error.message : String(error) });
}
