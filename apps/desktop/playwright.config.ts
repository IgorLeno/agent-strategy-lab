import { defineConfig } from '@playwright/test';

// Teste de UI do app Electron com o agente fake (não gasta quota).
// Pré-requisito: `pnpm build` (o teste abre `out/`).
export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: 'list',
  outputDir: 'test-results',
});
