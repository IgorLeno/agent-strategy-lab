import { describe, expect, it } from 'vitest';

import { parseEnvDump, resolveShellEnv } from '../src/main/shell-env.js';

describe('ambiente do shell de login', () => {
  it('extrai env -0 entre marcadores e ignora ruído do rc', () => {
    const dump = 'motd do rc\n__ASL_SHELL_ENV__PATH=/a:/b\0MULTI=x\ny=z\0__ASL_SHELL_ENV__prompt';
    expect(parseEnvDump(dump)).toEqual({ PATH: '/a:/b', MULTI: 'x\ny=z' });
  });

  it('sem marcadores = null', () => {
    expect(parseEnvDump('nada')).toBeNull();
  });

  it('shell inexistente cai no fallback com aviso', async () => {
    const result = await resolveShellEnv({ SHELL: '/nao/existe', PATH: '/x' });
    expect(result.env).toEqual({ SHELL: '/nao/existe', PATH: '/x' });
    expect(result.warning).toMatch(/indisponível/);
  });

  it('shell real devolve PATH', async () => {
    const result = await resolveShellEnv({ ...process.env, SHELL: '/bin/sh' });
    expect(result.warning).toBeNull();
    expect(result.env['PATH']).toBeTruthy();
  });
});
