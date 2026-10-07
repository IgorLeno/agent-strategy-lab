import type { AslBridge } from '../../shared/ipc';

declare global {
  interface Window {
    readonly asl: AslBridge;
  }
}
