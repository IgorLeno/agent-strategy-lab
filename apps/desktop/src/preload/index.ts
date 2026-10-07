/**
 * Ponte tipada: o renderer (sandbox, sem Node) só enxerga `window.asl`.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import { IPC_EVENT, IPC_INVOKE, type AslBridge, type DaemonEvent } from '../shared/ipc.js';

const bridge: AslBridge = {
  invoke: (command, args) => ipcRenderer.invoke(IPC_INVOKE, command, args),
  onEvent: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: DaemonEvent): void => listener(payload);
    ipcRenderer.on(IPC_EVENT, handler);
    return () => {
      ipcRenderer.removeListener(IPC_EVENT, handler);
    };
  },
};

contextBridge.exposeInMainWorld('asl', bridge);
