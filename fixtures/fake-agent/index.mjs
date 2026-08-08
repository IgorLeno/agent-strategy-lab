#!/usr/bin/env node
// Fake agent — existe para exercitar src/adapters/fake/ sem depender de
// nenhum provider real e sem gastar um tostão. Ao contrário de
// fixtures/fake-clis (que imita a CLI de um provider e cabe ao adapter
// traduzir), este processo já fala a INTERFACE INTERNA do lab: cada linha de
// stdout é um evento normalizado (ver src/adapters/events.ts), sem formato de
// provider no meio.
//
// Variante escolhida por argv[2], default `success`:
// - success (M25): execução completa e bem-sucedida.
// - failure (M26): execução completa, mas o agente relata a tarefa como falha.
// - timeout (M26): nunca termina por conta própria — existe para o SIGTERM/
//   SIGKILL do runner alcançar.
// - malformed-stream (M26): uma linha de stdout que não é o formato interno,
//   intercalada com eventos válidos — o adapter precisa sobreviver a ela.
// - child-process-leak (M26): spawna um descendente destacado (group próprio,
//   escapa do `-pgid` do runner) antes de também nunca terminar por conta
//   própria, para exercitar a verificação pid a pid do M24B.
import { spawn } from 'node:child_process';

const variant = process.argv[2] ?? 'success';

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

switch (variant) {
  case 'success': {
    emit({ type: 'message', role: 'assistant', text: 'Analisando a tarefa fake.' });
    emit({ type: 'tool_call', name: 'write_file', input: { path: 'fake-output.txt' } });
    emit({ type: 'tool_result', name: 'write_file', output: { ok: true } });
    emit({ type: 'result', outcome: 'success', tokens: 128, changed_files: 1 });
    process.exit(0);
    break;
  }

  case 'failure': {
    emit({ type: 'message', role: 'assistant', text: 'Tentando a tarefa fake e falhando nela.' });
    emit({ type: 'tool_call', name: 'run_tests', input: {} });
    emit({ type: 'tool_result', name: 'run_tests', output: { ok: false } });
    emit({ type: 'result', outcome: 'failure', tokens: 64, changed_files: 0 });
    process.exit(0);
    break;
  }

  case 'timeout': {
    emit({ type: 'message', role: 'assistant', text: 'Começando um trabalho que não termina.' });
    setInterval(() => {}, 1000);
    break;
  }

  case 'malformed-stream': {
    emit({ type: 'message', role: 'assistant', text: 'Antes da linha malformada.' });
    process.stdout.write('isto não é um evento da interface interna, nem JSON\n');
    emit({ type: 'result', outcome: 'success', tokens: 32, changed_files: 1 });
    process.exit(0);
    break;
  }

  case 'child-process-leak': {
    // `detached: true` faz o descendente liderar o próprio process group —
    // exatamente o mecanismo de `spawn.ts` para o processo do próprio run —,
    // então o `-pgid` que o runner manda ao alvo nunca o alcança.
    const grandchild = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => process.exit(0), 5000)'],
      { detached: true, stdio: 'ignore' },
    );
    grandchild.unref();
    emit({ type: 'message', role: 'assistant', text: 'Deixando um descendente para trás.' });
    setInterval(() => {}, 1000);
    break;
  }

  default: {
    process.stderr.write(`variante desconhecida do fake agent: ${variant}\n`);
    process.exit(1);
  }
}
