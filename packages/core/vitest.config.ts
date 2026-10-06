import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // E2E do loop sobe processos e git de verdade; 5 s padrão é pouco sob carga.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
