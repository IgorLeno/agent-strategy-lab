import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ProcessSpawnError, spawnProcess } from '../../src/runner/index.js';

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-spawn-test-'));
  temporaryRoots.push(root);
  return realpath(root);
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** argv de um node inline — o mesmo executável que roda os testes. */
function nodeArgv(source: string, ...args: string[]): string[] {
  return [process.execPath, '-e', source, ...args];
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

describe('spawnProcess', () => {
  it('reporta exit code de sucesso', async () => {
    const result = await spawnProcess({
      argv: nodeArgv('process.exit(0)'),
      cwd: await temporaryRoot(),
    });

    expect(result).toEqual({ exitCode: 0, signal: null });
  });

  it('reporta o exit code de falha, sem achatar para um genérico', async () => {
    const cwd = await temporaryRoot();

    const three = await spawnProcess({ argv: nodeArgv('process.exit(3)'), cwd });
    const fortyTwo = await spawnProcess({ argv: nodeArgv('process.exit(42)'), cwd });

    expect(three).toEqual({ exitCode: 3, signal: null });
    expect(fortyTwo).toEqual({ exitCode: 42, signal: null });
  });

  it('reporta o sinal e nenhum exit code quando o processo é morto', async () => {
    const result = await spawnProcess({
      argv: nodeArgv('process.kill(process.pid, "SIGKILL"); setTimeout(() => {}, 30000)'),
      cwd: await temporaryRoot(),
    });

    expect(result).toEqual({ exitCode: null, signal: 'SIGKILL' });
  });

  it('usa o ambiente informado como ambiente completo do processo', async () => {
    const result = await spawnProcess({
      argv: nodeArgv('process.exit(Number(process.env.LAB_EXIT ?? 1))'),
      cwd: await temporaryRoot(),
      env: { LAB_EXIT: '7' },
    });

    expect(result).toEqual({ exitCode: 7, signal: null });
  });

  it('roda no cwd informado', async () => {
    const cwd = await temporaryRoot();

    const result = await spawnProcess({
      argv: nodeArgv('require("node:fs").writeFileSync("cwd.txt", process.cwd())'),
      cwd,
    });

    expect(result).toEqual({ exitCode: 0, signal: null });
    expect(await readFile(path.join(cwd, 'cwd.txt'), 'utf8')).toBe(cwd);
  });

  // O Node emite `error` com ENOENT e logo depois `close` com `-2` — o errno
  // negado ocupando a posição do exit code. Um exit code é evidência sobre um
  // agente que rodou; comando que não existe não produziu nenhuma.
  it('trata comando inexistente como erro de infra, não como exit code', async () => {
    const argv = nodeArgv('process.exit(0)');
    argv[0] = path.join(await temporaryRoot(), 'binario-que-nao-existe');

    const error = await spawnProcess({ argv, cwd: await temporaryRoot() }).then(
      (result) => result,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(ProcessSpawnError);
    expect((error as ProcessSpawnError).code).toBe('ENOENT');
    expect((error as ProcessSpawnError).argv).toEqual(argv);
    // Nada que pareça um desfecho do processo: nem -2, nem 127, nem 0.
    expect(error).not.toHaveProperty('exitCode');
  });

  it('trata cwd inexistente como erro de infra', async () => {
    const cwd = path.join(await temporaryRoot(), 'diretorio-que-nao-existe');

    await expect(spawnProcess({ argv: nodeArgv('process.exit(0)'), cwd })).rejects.toBeInstanceOf(
      ProcessSpawnError,
    );
  });

  it('trata binário sem permissão de execução como erro de infra', async () => {
    const cwd = await temporaryRoot();
    const script = path.join(cwd, 'sem-permissao.sh');
    await writeFile(script, '#!/bin/sh\nexit 0\n', { encoding: 'utf8', mode: 0o644 });

    const error = await spawnProcess({ argv: [script], cwd }).then(
      (result) => result,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(ProcessSpawnError);
    expect((error as ProcessSpawnError).code).toBe('EACCES');
  });

  // O argumento carrega tudo o que um shell trataria como sintaxe. Ele precisa
  // chegar ao processo byte a byte: se algum caminho interpolasse em shell, o
  // conteúdo escrito seria outro e os arquivos da injeção existiriam.
  it('não interpola shell em nenhum caminho', async () => {
    const cwd = await temporaryRoot();
    const payload = '$(touch injetado.txt) `id` ; echo escapou > escapou.txt | cat & ${HOME} *';
    const captured = path.join(cwd, 'argumento.txt');

    const result = await spawnProcess({
      argv: nodeArgv(
        'require("node:fs").writeFileSync(process.argv[1], process.argv[2])',
        captured,
        payload,
      ),
      cwd,
    });

    expect(result).toEqual({ exitCode: 0, signal: null });
    expect(await readFile(captured, 'utf8')).toBe(payload);
    expect(await exists(path.join(cwd, 'injetado.txt'))).toBe(false);
    expect(await exists(path.join(cwd, 'escapou.txt'))).toBe(false);
  });

  it('recusa argv sem executável e argumento com byte nulo', async () => {
    const cwd = await temporaryRoot();

    expect(() => spawnProcess({ argv: [], cwd })).toThrow(TypeError);
    expect(() => spawnProcess({ argv: [''], cwd })).toThrow(TypeError);
    expect(() => spawnProcess({ argv: nodeArgv('process.exit(0)', 'a\0b'), cwd })).toThrow(
      TypeError,
    );
  });
});
