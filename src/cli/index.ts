#!/usr/bin/env node
/**
 * CLI `agentlab`: doctor, init, task create, run, evaluate, score e report.
 *
 * Fronteira: a CLI só orquestra as outras áreas. Regra de negócio que nasce
 * aqui fica inacessível para teste que não passe por processo — e teste de
 * processo é caro o bastante para desincentivar cobertura.
 *
 * Preenchido por M32–M38.
 */
import { runDoctor, type DoctorReport } from './doctor.js';
import { runInit } from './init.js';

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;

  if (command === 'doctor') {
    const report = await runDoctor();
    printDoctorReport(report);
    return report.ok ? 0 : 1;
  }

  if (command === 'init') {
    return runInitCommand(rest);
  }

  process.stderr.write(`comando desconhecido: ${command ?? '(nenhum)'}\nUso: agentlab doctor | agentlab init --repo <caminho> [--force]\n`);
  return 1;
}

async function runInitCommand(args: readonly string[]): Promise<number> {
  const repo = readFlagValue(args, '--repo');
  if (repo === undefined) {
    process.stderr.write('init: --repo <caminho> é obrigatório\n');
    return 1;
  }
  const force = args.includes('--force');

  const result = await runInit({ repo, force });
  if (!result.created) {
    process.stdout.write(`init: ${result.path} já existe, nada foi alterado (use --force para sobrescrever)\n`);
    return 0;
  }
  process.stdout.write(`init: ${result.path} criado\n`);
  return 0;
}

function readFlagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) {
    return undefined;
  }
  return args[index + 1];
}

function printDoctorReport(report: DoctorReport): void {
  for (const check of report.checks) {
    process.stdout.write(`[${check.status}] ${check.name}: ${check.detail}\n`);
  }
  process.stdout.write(report.ok ? 'doctor: ok\n' : 'doctor: problemas bloqueantes encontrados\n');
}

const isDirectExecution = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isDirectExecution) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
