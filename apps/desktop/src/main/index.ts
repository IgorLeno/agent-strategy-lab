/**
 * Processo main: janela, ponte renderer ↔ daemon e ações nativas
 * (diálogo de pasta, abrir arquivo no editor). Não toca loop, Git nem
 * ledger — isso é do daemon no `utilityProcess` (Q4).
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, dialog, ipcMain, shell, utilityProcess, type UtilityProcess } from 'electron';

import {
  IPC_EVENT,
  IPC_INVOKE,
  type CommandName,
  type DaemonMessage,
  type DaemonRequest,
  type MainCommands,
} from '../shared/ipc.js';
import { resolveShellEnv } from './shell-env.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Mesmo diretório do `asl` CLI: um ledger só para app e terminal. */
const dataDir =
  process.env['ASL_DATA_DIR'] ??
  path.join(process.env['XDG_DATA_HOME'] ?? path.join(os.homedir(), '.local', 'share'), 'asl');

const warnings: string[] = [];
let window: BrowserWindow | null = null;
let daemon: UtilityProcess | null = null;
let daemonExited = false;
let quitting = false;
let nextId = 1;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

const MAIN_COMMANDS: ReadonlySet<string> = new Set<keyof MainCommands>(['pickDirectory', 'openPath', 'getAppInfo']);

function fatal(message: string): void {
  dialog.showErrorBox('Agent Strategy Lab', message);
  app.exit(1);
}

function startDaemon(env: NodeJS.ProcessEnv): void {
  const child = utilityProcess.fork(path.join(here, 'daemon.js'), [], {
    serviceName: 'asl-daemon',
    env: { ...env, ASL_DATA_DIR: dataDir },
    stdio: 'inherit',
  });
  child.on('message', (message: DaemonMessage) => {
    if (message.kind === 'response') {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.ok) waiter?.resolve(message.result);
      else waiter?.reject(new Error(message.error));
    } else if (message.kind === 'event') {
      window?.webContents.send(IPC_EVENT, message.event);
    } else {
      fatal(message.error);
    }
  });
  child.on('exit', (code) => {
    daemonExited = true;
    for (const waiter of pending.values()) waiter.reject(new Error('daemon encerrado'));
    pending.clear();
    if (!quitting) fatal(`o daemon terminou inesperadamente (código ${code})`);
  });
  daemon = child;
}

function callDaemon(command: CommandName, args: unknown): Promise<unknown> {
  if (daemon === null || daemonExited) return Promise.reject(new Error('daemon indisponível'));
  const id = nextId++;
  const request: DaemonRequest = { kind: 'request', id, command, args };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    daemon?.postMessage(request);
  });
}

async function mainCommand(command: keyof MainCommands, args: Record<string, unknown>): Promise<unknown> {
  switch (command) {
    case 'pickDirectory': {
      const options = { title: 'Adicionar projeto (repositório Git)', properties: ['openDirectory' as const] };
      const result = window === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(window, options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    }
    case 'openPath': {
      const target = args['path'];
      if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error('caminho inválido');
      const error = await shell.openPath(target);
      if (error !== '') throw new Error(error);
      return null;
    }
    case 'getAppInfo':
      return { warnings, dataDir };
  }
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'Agent Strategy Lab',
    backgroundColor: '#16161a',
    webPreferences: {
      preload: path.join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // O renderer só mostra a própria UI: nada de navegar ou abrir janelas.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (!app.isPackaged && devUrl !== undefined) void window.loadURL(devUrl);
  else void window.loadFile(path.join(here, '../renderer/index.html'));
  window.on('closed', () => {
    window = null;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window === null) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  ipcMain.handle(IPC_INVOKE, async (event, command: unknown, args: unknown) => {
    // Só a janela do app fala com o daemon.
    if (window === null || event.sender !== window.webContents) throw new Error('remetente desconhecido');
    if (typeof command !== 'string') throw new Error('comando inválido');
    const input = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
    if (MAIN_COMMANDS.has(command)) return mainCommand(command as keyof MainCommands, input);
    return callDaemon(command as CommandName, input);
  });

  void app.whenReady().then(async () => {
    const shellEnv = await resolveShellEnv(process.env);
    if (shellEnv.warning !== null) warnings.push(shellEnv.warning);
    // Variáveis ASL_* do processo (testes, overrides) valem sobre as do shell.
    const asl = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('ASL_')));
    startDaemon({ ...shellEnv.env, ...asl });
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', (event) => {
    if (quitting || daemon === null || daemonExited) return;
    // Espera o daemon marcar steps em curso como interrompidos e soltar o lock.
    event.preventDefault();
    quitting = true;
    const child = daemon;
    const force = setTimeout(() => child.kill(), 10_000);
    child.once('exit', () => {
      clearTimeout(force);
      app.quit();
    });
    child.postMessage({ kind: 'shutdown' } satisfies DaemonRequest);
  });
}

