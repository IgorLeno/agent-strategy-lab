#!/usr/bin/env node
// Fake agent — existe para exercitar src/adapters/fake/ sem depender de
// nenhum provider real e sem gastar um tostão. Ao contrário de
// fixtures/fake-clis (que imita a CLI de um provider e cabe ao adapter
// traduzir), este processo já fala a INTERFACE INTERNA do lab: cada linha de
// stdout é um evento normalizado (ver src/adapters/events.ts), sem formato de
// provider no meio.
//
// Variante success (M25): reporta uma execução completa e bem-sucedida.
const events = [
  { type: 'message', role: 'assistant', text: 'Analisando a tarefa fake.' },
  { type: 'tool_call', name: 'write_file', input: { path: 'fake-output.txt' } },
  { type: 'tool_result', name: 'write_file', output: { ok: true } },
  { type: 'result', outcome: 'success', tokens: 128, changed_files: 1 },
];

for (const event of events) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

process.exit(0);
