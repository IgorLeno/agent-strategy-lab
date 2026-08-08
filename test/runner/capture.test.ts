import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  captureProcess,
  ProcessCaptureError,
  ProcessSpawnError,
  STDERR_LOG_NAME,
  STDOUT_LOG_NAME,
} from '../../src/runner/index.js';

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-capture-test-'));
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

/** Espera uma condição virar verdadeira, sem prender o teste se ela nunca virar. */
async function waitFor(condition: () => Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`condição não ocorreu dentro do limite: ${description}`);
}

async function fileSize(target: string): Promise<number> {
  try {
    return (await stat(target)).size;
  } catch {
    return 0;
  }
}

/**
 * Fonte de um processo que emite `write`, espera o arquivo sentinela aparecer e
 * só então termina. É o que torna "escreveu antes de terminar" observável sem
 * depender de tempo: enquanto o teste não criar a sentinela, o processo vive.
 */
function heldOpenSource(write: string): string {
  return `${write}
const fs = require('node:fs');
const wait = () => { if (fs.existsSync(process.argv[1])) process.exit(0); setTimeout(wait, 10); };
wait();`;
}

describe('captureProcess', () => {
  it('persiste stdout e stderr em arquivos separados', async () => {
    const cwd = await temporaryRoot();

    const result = await captureProcess({
      argv: nodeArgv('process.stdout.write("saida\\n"); process.stderr.write("erro\\n")'),
      cwd,
      logDir: cwd,
    });

    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(await readFile(path.join(cwd, STDOUT_LOG_NAME), 'utf8')).toBe('saida\n');
    expect(await readFile(path.join(cwd, STDERR_LOG_NAME), 'utf8')).toBe('erro\n');
    expect(result.stdout).toEqual({ path: path.join(cwd, STDOUT_LOG_NAME), bytesWritten: 6 });
    expect(result.stderr).toEqual({ path: path.join(cwd, STDERR_LOG_NAME), bytesWritten: 5 });
  });

  it('cria o diretório de log quando ele ainda não existe', async () => {
    const cwd = await temporaryRoot();
    const logDir = path.join(cwd, 'execution', 'logs');

    await captureProcess({ argv: nodeArgv('process.stdout.write("ok\\n")'), cwd, logDir });

    expect(await readFile(path.join(logDir, STDOUT_LOG_NAME), 'utf8')).toBe('ok\n');
  });

  // O disco é a fronteira: o que for escrito cru fica cru, porque não existe
  // passagem de limpeza sobre `data/` depois.
  it('redige o secret antes de escrever, nos dois streams', async () => {
    const cwd = await temporaryRoot();
    const secret = `sk-ant-${'a'.repeat(40)}`;

    await captureProcess({
      argv: nodeArgv(
        'process.stdout.write("ANTHROPIC_API_KEY=" + process.argv[1] + "\\n");' +
          'process.stderr.write("auth falhou com " + process.argv[1] + "\\n")',
        secret,
      ),
      cwd,
      logDir: cwd,
    });

    const stdout = await readFile(path.join(cwd, STDOUT_LOG_NAME), 'utf8');
    const stderr = await readFile(path.join(cwd, STDERR_LOG_NAME), 'utf8');

    expect(stdout).not.toContain(secret);
    expect(stderr).not.toContain(secret);
    expect(stdout).toBe('ANTHROPIC_API_KEY=[REDACTED:anthropic-api-key]\n');
    expect(stderr).toBe('auth falhou com [REDACTED:anthropic-api-key]\n');
  });

  // Redigir por chunk deixaria os dois pedaços passarem: nenhum deles casa
  // sozinho com o formato do secret.
  it('redige o secret partido entre dois chunks', async () => {
    const cwd = await temporaryRoot();
    const half = 'b'.repeat(20);

    await captureProcess({
      argv: nodeArgv(
        `process.stdout.write("KEY=sk-ant-${half}");` +
          `setTimeout(() => process.stdout.write("${half}\\n"), 50)`,
      ),
      cwd,
      logDir: cwd,
    });

    const stdout = await readFile(path.join(cwd, STDOUT_LOG_NAME), 'utf8');
    expect(stdout).toBe('KEY=[REDACTED:anthropic-api-key]\n');
    expect(stdout).not.toContain(half);
  });

  // Um bloco PEM só casa inteiro. Sem segurar o texto a partir do BEGIN, cada
  // linha do corpo sairia sozinha e a chave iria crua para o disco.
  it('redige a chave privada que chega em linhas separadas', async () => {
    const cwd = await temporaryRoot();
    const body = 'MIIEowIBAAKCAQEAsecreta';

    await captureProcess({
      argv: nodeArgv(
        'process.stdout.write("antes\\n-----BEGIN RSA PRIVATE KEY-----\\n");' +
          `setTimeout(() => process.stdout.write("${body}\\n"), 30);` +
          'setTimeout(() => process.stdout.write("-----END RSA PRIVATE KEY-----\\ndepois\\n"), 60)',
      ),
      cwd,
      logDir: cwd,
    });

    const stdout = await readFile(path.join(cwd, STDOUT_LOG_NAME), 'utf8');
    expect(stdout).toBe('antes\n[REDACTED:private-key]\ndepois\n');
    expect(stdout).not.toContain(body);
  });

  it('persiste a linha parcial do fim do stream, sem perder bytes nem inventar \\n', async () => {
    const cwd = await temporaryRoot();

    const result = await captureProcess({
      argv: nodeArgv('process.stdout.write("linha\\nsem-quebra-no-fim")'),
      cwd,
      logDir: cwd,
    });

    expect(result.exitCode).toBe(0);
    expect(await readFile(path.join(cwd, STDOUT_LOG_NAME), 'utf8')).toBe(
      'linha\nsem-quebra-no-fim',
    );
  });

  it('não corrompe caractere multibyte partido entre dois chunks', async () => {
    const cwd = await temporaryRoot();

    await captureProcess({
      // O corte cai dentro dos 4 bytes do emoji: metade em cada chunk.
      argv: nodeArgv(
        'const buf = Buffer.from("héllo 🌍\\n", "utf8");' +
          'process.stdout.write(buf.subarray(0, 9));' +
          'setTimeout(() => process.stdout.write(buf.subarray(9)), 40)',
      ),
      cwd,
      logDir: cwd,
    });

    expect(await readFile(path.join(cwd, STDOUT_LOG_NAME), 'utf8')).toBe('héllo 🌍\n');
  });

  // Saída volumosa tem que estar no disco enquanto o processo ainda fala: juntar
  // tudo em memória perderia a evidência justamente no run que estourou.
  it('persiste saída volumosa antes de o processo terminar', async () => {
    const cwd = await temporaryRoot();
    const sentinel = path.join(cwd, 'pode-terminar');
    const stdoutPath = path.join(cwd, STDOUT_LOG_NAME);
    const lines = 1024;
    const line = `${'x'.repeat(1023)}\n`;

    const capture = captureProcess({
      argv: nodeArgv(
        heldOpenSource(
          `const linha = "x".repeat(1023) + "\\n";
for (let i = 0; i < ${lines}; i++) process.stdout.write(linha);`,
        ),
        sentinel,
      ),
      cwd,
      logDir: cwd,
    });

    await waitFor(
      async () => (await fileSize(stdoutPath)) >= lines * line.length,
      'stdout.log com a saída inteira antes do fim do processo',
    );
    expect(await exists(sentinel)).toBe(false);

    await writeFile(sentinel, '');
    const result = await capture;

    expect(result.exitCode).toBe(0);
    expect(result.stdout.bytesWritten).toBe(lines * line.length);
    expect(await readFile(stdoutPath, 'utf8')).toBe(line.repeat(lines));
  });

  // Uma linha sem fim transformaria "reter a linha em andamento" em "reter
  // tudo". O teto corta, e o corte não pode perder bytes.
  it('não segura em memória uma linha maior que o teto', async () => {
    const cwd = await temporaryRoot();
    const sentinel = path.join(cwd, 'pode-terminar');
    const stdoutPath = path.join(cwd, STDOUT_LOG_NAME);
    const payload = 'y'.repeat(64 * 1024);

    const capture = captureProcess({
      argv: nodeArgv(
        heldOpenSource(`process.stdout.write("y".repeat(${payload.length}));`),
        sentinel,
      ),
      cwd,
      logDir: cwd,
      maxPendingChars: 1024,
    });

    // Nenhum `\n` foi emitido: o que chegou ao disco chegou pelo corte forçado.
    await waitFor(
      async () => (await fileSize(stdoutPath)) > 0,
      'stdout.log com bytes de uma linha ainda não terminada',
    );
    expect(await exists(sentinel)).toBe(false);

    await writeFile(sentinel, '');
    await capture;

    expect(await readFile(stdoutPath, 'utf8')).toBe(payload);
  });

  it('reporta o exit code de falha e persiste o que o processo falou', async () => {
    const cwd = await temporaryRoot();

    const result = await captureProcess({
      // O exit espera a escrita: `process.exit` no meio de um write pendente
      // para pipe descarta o que ainda não saiu, e o teste mediria o Node.
      argv: nodeArgv('process.stderr.write("falhou\\n", () => process.exit(3))'),
      cwd,
      logDir: cwd,
    });

    expect(result.exitCode).toBe(3);
    expect(await readFile(path.join(cwd, STDERR_LOG_NAME), 'utf8')).toBe('falhou\n');
  });

  // Um run cuja saída não chegou ao disco não tem evidência, e isso não pode
  // sair daqui parecendo um processo que rodou bem.
  it('trata falha de escrita como erro de captura, não como desfecho do processo', async () => {
    const cwd = await temporaryRoot();
    // Destino ocupado por um diretório: o arquivo de log não abre.
    await mkdir(path.join(cwd, STDOUT_LOG_NAME));

    const error = await captureProcess({
      argv: nodeArgv('process.stdout.write("saida\\n")'),
      cwd,
      logDir: cwd,
    }).then(
      (result) => result,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(ProcessCaptureError);
    expect((error as ProcessCaptureError).path).toBe(path.join(cwd, STDOUT_LOG_NAME));
  });

  // Processo que não iniciou não produziu saída nenhuma. Um log vazio no lugar
  // seria evidência de um run que não aconteceu.
  it('trata comando inexistente como erro de infra, sem criar log', async () => {
    const cwd = await temporaryRoot();
    const argv = nodeArgv('process.exit(0)');
    argv[0] = path.join(cwd, 'binario-que-nao-existe');

    await expect(captureProcess({ argv, cwd, logDir: cwd })).rejects.toBeInstanceOf(
      ProcessSpawnError,
    );
    expect(await exists(path.join(cwd, STDOUT_LOG_NAME))).toBe(false);
    expect(await exists(path.join(cwd, STDERR_LOG_NAME))).toBe(false);
  });
});
