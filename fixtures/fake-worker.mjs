#!/usr/bin/env node
/**
 * Worker falso: fala o protocolo do harness (packet -> commit -> report +
 * handoff draft -> encerra), sem depender de nenhum provider real.
 *
 * Modo por AGENTLAB_FAKE_MODE:
 *   success    (default) trabalha, commita, reporta SUCCESS
 *   failure    trabalha, commita, reporta FAILURE
 *   no-commit  reporta SUCCESS sem criar commit
 *   orchestrator-success  produz patch e SUCCESS com candidate null, sem tocar no Git
 *   dirty      commita e ainda deixa arquivo não rastreado na árvore
 *   out-of-scope  commita alterando dev/plan.yaml
 *   timeout    ignora SIGTERM e nunca termina
 *   leak       deixa um descendente vivo depois de sair
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

if (process.argv.slice(2).some((argument) => argument === '--help' || argument === '-h')) {
  console.log('fake-worker: uso interno do harness (packet -> commit -> report + handoff)');
  process.exit(0);
}

const mode = process.env.AGENTLAB_FAKE_MODE ?? 'success';
const repoRoot = process.env.AGENTLAB_REPO_ROOT;
const packetPath = process.env.AGENTLAB_TASK_PACKET_PATH;
const reportPath = process.env.AGENTLAB_REPORT_PATH;
const draftPath = process.env.AGENTLAB_HANDOFF_DRAFT_PATH;

if (!repoRoot || !packetPath || !reportPath || !draftPath) {
  console.error('fake-worker: ambiente incompleto');
  process.exit(2);
}

if (mode === 'timeout') {
  process.on('SIGTERM', () => {});
  process.on('SIGINT', () => {});
  setInterval(() => {}, 1000);
} else {
  main();
}

function git(args) {
  return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim();
}

function main() {
  const packet = JSON.parse(readFileSync(packetPath, 'utf8'));

  if (mode === 'leak') {
    // Descendente que sobrevive ao pai — alvo da verificação de sobreviventes.
    // 30s: tempo de sobra para ser detectado, curto o bastante para não deixar
    // processo pendurado na máquina depois da suíte.
    spawn('sleep', ['30'], { detached: true, stdio: 'ignore' }).unref();
  }

  let changedFiles = [];
  let candidateCommit = null;

  if (mode === 'out-of-scope') {
    const planFile = path.join(repoRoot, 'dev', 'plan.yaml');
    writeFileSync(planFile, `${readFileSync(planFile, 'utf8')}\n# tocado pelo worker\n`);
    changedFiles = ['dev/plan.yaml'];
  } else if (mode !== 'no-commit') {
    const relative = path.join('src', `${packet.task_id.toLowerCase()}.txt`);
    mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    writeFileSync(path.join(repoRoot, relative), `feito por ${packet.task_id}\n`);
    changedFiles = [relative];
  }

  if (mode !== 'no-commit' && mode !== 'orchestrator-success') {
    git(['add', '-A']);
    git(['commit', '-q', '-m', `${packet.task_id}: ${packet.title}`]);
    candidateCommit = git(['rev-parse', 'HEAD']);
  }

  if (mode === 'dirty') {
    writeFileSync(path.join(repoRoot, 'src', 'nao-commitado.txt'), 'sujeira\n');
  }

  const failed = mode === 'failure';
  const validations = packet.validation.map((command) => ({
    argv: command.argv,
    exit_code: failed ? 1 : 0,
    timed_out: false,
    duration_ms: 1,
  }));

  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        schema_version: 1,
        task_id: packet.task_id,
        self_reported_result: failed ? 'FAILURE' : 'SUCCESS',
        summary: `fake-worker modo ${mode}`,
        candidate_commit: candidateCommit,
        changed_files: changedFiles,
        validations,
        decisions: [],
        lessons: [],
        relevant_files: changedFiles.slice(0, 5),
      },
      null,
      2,
    ),
  );

  writeFileSync(
    draftPath,
    JSON.stringify(
      {
        schema_version: 1,
        task_id: packet.task_id,
        result: failed ? 'FAIL' : 'PASS',
        changed_files: changedFiles,
        validations,
        decisions: [],
        lessons: [],
        next_relevant_files: changedFiles.slice(0, 5),
      },
      null,
      2,
    ),
  );

  process.exit(failed ? 1 : 0);
}
