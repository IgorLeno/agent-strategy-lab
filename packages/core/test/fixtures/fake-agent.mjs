// Agente falso dos testes do loop. Lê o prompt do stdin, guarda-o e executa a
// próxima ação de um roteiro JSON ($ASL_FAKE_SCRIPT), uma por chamada:
//   { "files": { "a.txt": "conteúdo" | null }, "exit": 0, "final": "nota",
//     "tokens": 10, "providerFailure": "mensagem", "sleepMs": 0 }
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const scriptPath = process.env.ASL_FAKE_SCRIPT;
const script = JSON.parse(readFileSync(scriptPath, 'utf8'));
const counterPath = `${scriptPath}.count`;
const index = existsSync(counterPath) ? Number(readFileSync(counterPath, 'utf8')) : 0;
writeFileSync(counterPath, String(index + 1));

const prompt = readFileSync(0, 'utf8');
const promptDir = `${scriptPath}.prompts`;
mkdirSync(promptDir, { recursive: true });
writeFileSync(path.join(promptDir, `${index}.txt`), `profile=${process.argv[2]}\ntag=${process.env.ASL_STEP_TAG}\n${prompt}`);

const action = script.calls[index] ?? { exit: 0, final: 'sem ação' };
if (action.sleepMs) await new Promise((resolve) => setTimeout(resolve, action.sleepMs));
for (const [file, content] of Object.entries(action.files ?? {})) {
  if (content === null) rmSync(file, { force: true });
  else {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
emit({ type: 'message', role: 'assistant', text: `chamada ${index}` });
if (action.tokens) emit({ type: 'tokens', total: action.tokens });
if (action.providerFailure) emit({ type: 'provider_failure', message: action.providerFailure });
if (action.final) emit({ type: 'final', text: action.final });
process.exit(action.exit ?? 0);
