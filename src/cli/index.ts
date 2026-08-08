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

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const [command] = argv;

  if (command === 'doctor') {
    const report = await runDoctor();
    printDoctorReport(report);
    return report.ok ? 0 : 1;
  }

  process.stderr.write(`comando desconhecido: ${command ?? '(nenhum)'}\nUso: agentlab doctor\n`);
  return 1;
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
