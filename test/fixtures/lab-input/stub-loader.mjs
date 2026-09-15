import { registerHooks } from 'node:module';

// Replace the execution boundary, never the stdin reader or UI under test.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '../lib/lab.js' && context.parentURL?.endsWith('/dev/cli/lab.ts')) {
      return { url: new URL('./submit-stub.mjs', import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
