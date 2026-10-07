import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

// Tudo (inclusive @asl/core, que é TS do workspace) entra no bundle: as
// dependências ficam em devDependencies e o pacote não leva node_modules.
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          daemon: resolve(import.meta.dirname, 'src/daemon/index.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      // Preload com `sandbox: true` precisa ser CommonJS.
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    build: {
      rollupOptions: { input: { index: resolve(import.meta.dirname, 'src/renderer/index.html') } },
    },
    plugins: [react()],
  },
});
