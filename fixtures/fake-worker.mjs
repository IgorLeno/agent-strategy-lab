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
 *   official-fail         SUCCESS + patch que falha a validation oficial (grep repaired)
 *   official-fail-until-escalation  falha enquanto houver menos de 2 attempts de
 *                                   validation arquivados; a partir do terceiro
 *                                   attempt (o escalado) escreve 'repaired'
 *   official-fail-then-repair  FIRST_PASS falha a validation; REPAIR escreve 'repaired'
 *   official-fail-then-worker-failure  FIRST_PASS falha a validation; REPAIR reporta FAILURE
 *   protocol-invalid-then-success  primeiro close tem metadata inválida; retry passa
 *   handoff-v2-invalid    escreve handoff v2 SEM what_i_did_not_check (protocolo inválido)
 *   incomplete-output-then-success  primeiro close omite report/handoff; retry passa
 *   incomplete-output-always  todos os closes omitem report/handoff
 *   repair-incomplete-then-success  FIRST_PASS falha; REPAIR omite artifacts uma vez
 *   infra-error  encerra com exit de launcher não recuperável
 *   dirty      commita e ainda deixa arquivo não rastreado na árvore
 *   out-of-scope  commita alterando dev/plan.yaml
 *   timeout    ignora SIGTERM e nunca termina
 *   stall      fala, fica MUDO por um intervalo longo, e então trabalha normalmente
 *   leak       deixa um descendente vivo depois de sair
 *
 * Role de reviewer (argv --agentlab-read-only), por AGENTLAB_FAKE_REVIEW:
 *   accept       (default) ACCEPT com cobertura derivada do review packet
 *   reject       REJECT com a mesma cobertura
 *   no-coverage  ACCEPT SEM coverage — o schema do record precisa recusar
 *   invalid      saída sem veredito estruturado
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

if (process.argv.slice(2).some((argument) => argument === '--help' || argument === '-h')) {
  console.log('fake-worker: uso interno do harness (packet -> commit -> report + handoff)');
  process.exit(0);
}

function promptObject(marker) {
  const source = process.argv.slice(2).find((token) => token.includes(marker));
  if (source === undefined) return null;
  const start = source.indexOf('{', source.indexOf(marker));
  if (start < 0) return null;
  for (let end = source.lastIndexOf('}'); end > start; end = source.lastIndexOf('}', end - 1)) {
    try {
      return JSON.parse(source.slice(start, end + 1));
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Overlay READ-ONLY estrutural (dev/lib/project-roles.ts). Chega por argv, não
 * por prompt: o fixture sai ANTES de qualquer escrita, commit ou validação, e
 * devolve exatamente um JSON do role solicitado.
 */
if (process.argv.slice(2).includes('--agentlab-read-only')) {
  const plannerPacket = promptObject('PLANNER PACKET');
  if (plannerPacket !== null) {
    const sourceAnchor = plannerPacket.source_anchors[0] ?? { area: 'project', path: 'README.md' };
    const validationCandidate = plannerPacket.inspection.validation_candidates[0];
    const validationArgv =
      validationCandidate === undefined ? ['true'] : validationCandidate.command.trim().split(/\s+/);
    console.log(
      JSON.stringify({
        schema_version: 1,
        tasks: [
          {
            schema_version: 1,
            task_id: 'T1',
            objective: plannerPacket.user_intent.requested_scope,
            blocked_by: [],
            taxonomy: {
              version: 1,
              task_class: 'feature',
              difficulty_declared: 'easy',
              complexity: 'local',
              ambiguity: 'low',
              verification: 'deterministic',
            },
            risk: 'low',
            acceptance: [...plannerPacket.user_intent.objectives],
            validation: [{ argv: validationArgv, timeout_seconds: 30 }],
            initial_files: [sourceAnchor.path],
            probable_files: [],
            context_scope: { areas: [sourceAnchor.area] },
            context_requirements: [
              { description: 'contexto observado pelo planner fake', source_anchor: sourceAnchor.path },
            ],
            environment_requirements: [],
            estimated_duration: { expected: 20_000, maximum: 60_000 },
            validation_budget: { expected: 1_000, maximum: 30_000 },
            resource_envelope: {
              duration_ms: { expected: 20_000, maximum: 60_000 },
              tokens: { expected: 30_000, maximum: 90_000 },
              changed_files: { expected: 1, maximum: 3 },
            },
          },
        ],
      }),
    );
    process.exit(0);
  }

  const requested = process.env.AGENTLAB_FAKE_REVIEW ?? 'accept';
  if (requested === 'invalid') {
    console.log('sem veredito estruturado');
    process.exit(0);
  }
  const decision = requested === 'reject' ? 'REJECT' : 'ACCEPT';
  // O packet do reviewer chega no prompt (prompt_delivery: argv). A cobertura
  // é derivada dele: arquivos e validações realmente listados, e cada item de
  // implementer_gaps endereçado uma vez. O modo 'no-coverage' omite tudo isso
  // de propósito — é o ACCEPT que o schema do record precisa recusar.
  const reviewPacket = promptObject('REVIEW PACKET');
  const coverage =
    requested === 'no-coverage'
      ? undefined
      : {
          files: [...(reviewPacket?.changed_files ?? [])],
          validations: (reviewPacket?.validation ?? []).map((command) => [...command.argv]),
          behaviors: ['acceptance declarado confrontado com a evidência oficial'],
          handoff_gaps: (reviewPacket?.implementer_gaps ?? []).map((gap) => ({
            gap,
            disposition: 'accepted_with_justification',
            note: 'lacuna coberta pela validação oficial deste candidate',
          })),
        };
  console.log(
    JSON.stringify({
      decision,
      reason: `fake reviewer read-only: ${decision === 'ACCEPT' ? 'evidência consistente com o acceptance declarado' : 'evidência insuficiente para aceitar a mudança'}`,
      ...(coverage === undefined ? {} : { coverage }),
    }),
  );
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

const taskId = process.env.AGENTLAB_TASK_ID;
const devDir = path.dirname(path.dirname(packetPath));

function hasArchivedAttempt(relativeRecord) {
  if (!taskId) return false;
  const taskRoot = path.join(devDir, 'failed-attempts', taskId);
  if (!existsSync(taskRoot)) return false;
  return readdirSync(taskRoot).some((attempt) => existsSync(path.join(taskRoot, attempt, relativeRecord)));
}

function archivedValidationFailures() {
  if (!taskId) return 0;
  const taskRoot = path.join(devDir, 'failed-attempts', taskId);
  if (!existsSync(taskRoot)) return 0;
  return readdirSync(taskRoot).filter((attempt) =>
    existsSync(path.join(taskRoot, attempt, 'validation-failed-attempt.json')),
  ).length;
}

function hasAbandonedAttempt() {
  if (!taskId) return false;
  const taskRoot = path.join(devDir, 'attempts', taskId);
  if (!existsSync(taskRoot)) return false;
  return readdirSync(taskRoot).some((entry) => /^\d+-abandoned\.json$/.test(entry));
}

if (mode === 'infra-error') {
  process.exit(125);
}

if (mode === 'timeout') {
  process.on('SIGTERM', () => {});
  process.on('SIGINT', () => {});
  setInterval(() => {}, 1000);
} else if (mode === 'stall') {
  // Um worker SAUDÁVEL que simplesmente fica mudo: fala, pensa em silêncio por
  // um intervalo longo, e termina o trabalho. É exatamente o caso que o stall
  // detector observacional precisa registrar SEM encerrar nada — silêncio não
  // prova travamento, e matar aqui destruiria trabalho legítimo.
  console.log('AGENTLAB_FAKE_STALL_BEGIN');
  const silenceMs = Number(process.env.AGENTLAB_FAKE_STALL_MS ?? '1500');
  setTimeout(main, silenceMs);
} else {
  main();
}

function git(args) {
  return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim();
}

function main() {
  console.log(`AGENTLAB_WORKER_CWD=${process.cwd()}`);
  const packet = JSON.parse(readFileSync(packetPath, 'utf8'));

  if (mode === 'leak') {
    // Descendente que sobrevive ao pai — alvo da verificação de sobreviventes.
    // 30s: tempo de sobra para ser detectado, curto o bastante para não deixar
    // processo pendurado na máquina depois da suíte.
    spawn('sleep', ['30'], { detached: true, stdio: 'ignore' }).unref();
  }

  let changedFiles = [];
  let candidateCommit = null;
  const repairAttempt = packet.previous_attempt_diagnostics != null;
  const protocolInvalidFirst =
    mode === 'protocol-invalid-then-success' &&
    !hasArchivedAttempt(path.join('protocol-invalid', 'protocol-invalid-attempt.json'));
  const incompleteWorkerOutput =
    taskId === 'T1' &&
    (mode === 'incomplete-output-always' ||
      (mode === 'incomplete-output-then-success' && !hasAbandonedAttempt()) ||
      (mode === 'repair-incomplete-then-success' && repairAttempt && !hasAbandonedAttempt()));
  const skipGit =
    mode === 'no-commit' ||
    mode === 'orchestrator-success' ||
    mode === 'handoff-v2-invalid' ||
    mode === 'official-fail' ||
    mode === 'official-fail-until-escalation' ||
    mode === 'official-fail-then-repair' ||
    mode === 'official-fail-then-worker-failure' ||
    mode === 'protocol-invalid-then-success' ||
    mode === 'incomplete-output-then-success' ||
    mode === 'incomplete-output-always' ||
    mode === 'repair-incomplete-then-success';

  if (mode === 'out-of-scope') {
    const planFile = path.join(repoRoot, 'dev', 'plan.yaml');
    writeFileSync(planFile, `${readFileSync(planFile, 'utf8')}\n# tocado pelo worker\n`);
    changedFiles = ['dev/plan.yaml'];
  } else if (mode !== 'no-commit') {
    const relative = path.join('src', `${packet.task_id.toLowerCase()}.txt`);
    mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    const contents =
      mode === 'official-fail'
        ? 'broken\n'
        : mode === 'official-fail-until-escalation'
          ? archivedValidationFailures() >= 2
            ? 'repaired\n'
            : 'broken\n'
          : mode === 'official-fail-then-repair' ||
            mode === 'official-fail-then-worker-failure' ||
            mode === 'repair-incomplete-then-success'
          ? repairAttempt
            ? mode === 'official-fail-then-repair' || mode === 'repair-incomplete-then-success'
              ? 'repaired\n'
              : 'broken\n'
            : 'broken\n'
          : `feito por ${packet.task_id}\n`;
    writeFileSync(path.join(repoRoot, relative), contents);
    changedFiles = [relative];
  }

  if (!skipGit) {
    git(['add', '-A']);
    git(['commit', '-q', '-m', `${packet.task_id}: ${packet.title}`]);
    candidateCommit = git(['rev-parse', 'HEAD']);
  }

  if (mode === 'dirty') {
    writeFileSync(path.join(repoRoot, 'src', 'nao-commitado.txt'), 'sujeira\n');
  }

  if (incompleteWorkerOutput) {
    process.exit(0);
  }

  const failed =
    mode === 'failure' || (mode === 'official-fail-then-worker-failure' && repairAttempt);
  const validations = packet.validation.map((command) => ({
    argv: command.argv,
    exit_code: failed ? 1 : 0,
    timed_out: false,
    duration_ms: 1,
  }));
  const reportedChangedFiles = protocolInvalidFirst
    ? [
        ...changedFiles,
        `.dev-inbox/${packet.task_id}/report.json`,
        `.dev-inbox/${packet.task_id}/handoff-draft.json`,
      ]
    : changedFiles;

  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        schema_version: 1,
        task_id: packet.task_id,
        self_reported_result: failed ? 'FAILURE' : 'SUCCESS',
        summary: `fake-worker modo ${mode}`,
        candidate_commit: candidateCommit,
        changed_files: reportedChangedFiles,
        validations,
        decisions: [],
        lessons: [],
        relevant_files: changedFiles.slice(0, 5),
      },
      null,
      2,
    ),
  );

  // Handoff v2 é o contrato corrente do worker: what_i_did_not_check é
  // OBRIGATÓRIO, e [] afirma positivamente que nada relevante ficou de fora.
  // O modo handoff-v2-invalid omite o campo de propósito, para exercitar o
  // caminho de protocolo inválido que já existe — sem recovery nova.
  const handoffV2 = {
    what_i_did_not_check: [],
    evidence: changedFiles
      .slice(0, 1)
      .map((file) => ({ kind: 'file', path: file, claim: `patch do modo ${mode}` })),
    confidence: failed ? 'baixa: o worker não produziu patch utilizável' : 'alta: patch determinístico do fixture',
  };
  if (mode === 'handoff-v2-invalid') delete handoffV2.what_i_did_not_check;

  writeFileSync(
    draftPath,
    JSON.stringify(
      {
        schema_version: 2,
        task_id: packet.task_id,
        result: failed ? 'FAIL' : 'PASS',
        changed_files: reportedChangedFiles,
        validations,
        decisions: [],
        lessons: [],
        next_relevant_files: changedFiles.slice(0, 5),
        ...handoffV2,
      },
      null,
      2,
    ),
  );

  process.exit(failed ? 1 : 0);
}
