import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTask } from '../../dev/lib/close.js';
import { headSha } from '../../dev/lib/git.js';
import { buildTaskPacket } from '../../dev/lib/packet.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import {
  ensureTaskInbox,
  handoffDraftPath,
  readCompletion,
  readHandoff,
  reportPath,
  writePacket,
} from '../../dev/lib/records.js';
import {
  buildInitialState,
  ensureRuntimeDirs,
  getTaskState,
  readState,
  withTaskState,
  writeState,
} from '../../dev/lib/state.js';
import { commitAll, makeSandboxRepo, type Sandbox } from './helpers.js';
import {
  ADVISORY_HANDOFF_DRAFT_BYTES,
  ADVISORY_TASK_PACKET_BYTES,
  artifactSizeAdvisory,
  byteSize,
  measureProtocolArtifacts,
  parseHandoffDraft,
  parseHandoffRecord,
  parseTaskPacket,
  sealHandoff,
  type TaskPacket,
} from '../../dev/lib/schemas.js';

/**
 * TAMANHO NÃO É AUTORIDADE DE EXECUÇÃO.
 *
 * Regressão do segundo incidente real de `semi-imperium-real-01`. A task 04
 * (`crest_selection_workflow`) rodou ~18m54s sob Claude Opus 5 high, passou
 * pela validação oficial, teve o candidate commitado em `be5ff5a` — e então o
 * lifecycle morreu com
 *
 *   BudgetExceededError: HandoffDraft excede o budget: 4438 bytes > 4096 bytes
 *
 * Não havia limite REAL do lado de fora: nem quota, nem janela de contexto,
 * nem memória. Era o Lab recusando o próprio trabalho válido por um número que
 * ele inventou. Este arquivo fixa a semântica nova: o schema estrito decide, a
 * régua só observa.
 *
 * O draft abaixo é o arquivo REAL da run, byte a byte — 4438 bytes canônicos.
 */
const REAL_TASK_04_DRAFT =
{
    "schema_version": 2,
    "task_id": "crest_selection_workflow",
    "result": "PASS",
    "changed_files": [
      "CHANGELOG.md",
      "pyproject.toml",
      "src/semi_imperium/conformers/__init__.py",
      "src/semi_imperium/conformers/backends.py",
      "src/semi_imperium/conformers/confpass.py",
      "src/semi_imperium/conformers/crest.py",
      "src/semi_imperium/conformers/ensemble.py",
      "src/semi_imperium/conformers/initial_structure.py",
      "src/semi_imperium/conformers/selection.py",
      "src/semi_imperium/conformers/structures.py",
      "src/semi_imperium/conformers/workflow.py",
      "src/semi_imperium/domain/__init__.py",
      "src/semi_imperium/domain/configuration.py",
      "src/semi_imperium/domain/enums.py",
      "tests/unit/semi_imperium/test_conformer_selection.py",
      "tests/unit/semi_imperium/test_persistence.py"
    ],
    "validations": [],
    "decisions": [
      "ConformerSelectionStrategy lives in domain/enums.py so configuration.py does not depend on the conformers application layer.",
      "ConformerSelectionSettings.subset_size renamed to top_n, default strategy is crest_energy_top_n with top_n=10, SIGNATURE_VERSION bumped 1 -> 2; the single existing reference in test_persistence.py was updated.",
      "SelectionResult rejects the PAS tag inside `evidence` at construction time, making 'PAS is advisory only' an invariant instead of a convention.",
      "XYZ/SDF handling is pure Python and RDKit is imported lazily, so importing semi_imperium.conformers needs no chemistry stack.",
      "The CONFPASS JSON report schema is documented as this adapter's own boundary contract, not a verified CONFPASS guarantee."
    ],
    "lessons": [
      "Non-read-only Bash was denied in this sandbox, so no gate could be run worker-side.",
      "packet.initial_files referenced src/semi_imperium/domain/models.py, which does not exist; the real module is domain/records.py."
    ],
    "next_relevant_files": [
      "src/semi_imperium/conformers/workflow.py",
      "src/semi_imperium/conformers/selection.py",
      "src/semi_imperium/conformers/confpass.py",
      "src/semi_imperium/domain/configuration.py",
      "tests/unit/semi_imperium/test_conformer_selection.py"
    ],
    "what_i_did_not_check": [
      "Nothing was executed: pytest, mypy --strict, ruff and black were all blocked by permission denial in this sandbox.",
      "Whether the SIGNATURE_VERSION bump and top_n rename break any consumer outside src/semi_imperium and tests/unit/semi_imperium (grep found none, but nothing was run).",
      "The RDKit path in initial_structure.py (embedding, kekulization, template atom-order parity with build()) was never exercised.",
      "Real CREST/CONFPASS argv and output formats against actual binaries; both adapters were only reasoned about, not run.",
      "Black formatting compliance of the new files was hand-approximated, not verified."
    ],
    "evidence": [
      {
        "kind": "file",
        "path": "src/semi_imperium/domain/configuration.py",
        "lines": "36-75",
        "claim": "ConformerSearchSettings carries no Hamiltonian field and gained an explicit `enabled` flag that participates in the signature."
      },
      {
        "kind": "file",
        "path": "src/semi_imperium/domain/configuration.py",
        "lines": "110-160",
        "claim": "ConformerSelectionSettings defaults to CREST_ENERGY_TOP_N with top_n=10 and validates the bound."
      },
      {
        "kind": "file",
        "path": "src/semi_imperium/conformers/selection.py",
        "lines": "86-125",
        "claim": "SelectionResult refuses to record the PAS completeness tag as scientific evidence."
      },
      {
        "kind": "file",
        "path": "src/semi_imperium/conformers/selection.py",
        "lines": "199-260",
        "claim": "CONFPASS prioritization receives the whole ensemble and only then applies the top_n bound."
      },
      {
        "kind": "file",
        "path": "src/semi_imperium/conformers/workflow.py",
        "lines": "121-135",
        "claim": "A disabled conformer search falls back to the initial-3D-structure route instead of failing."
      },
      {
        "kind": "file",
        "path": "src/semi_imperium/conformers/structures.py",
        "lines": "234-300",
        "claim": "XYZ-to-SDF adaptation preserves order, coordinates, connectivity and provenance, failing rather than reordering atoms."
      },
      {
        "kind": "file",
        "path": "src/semi_imperium/conformers/backends.py",
        "lines": "70-175",
        "claim": "CREST, CONFPASS and initial-structure generation are all reached through protocols, enabling test doubles."
      }
    ],
    "open_questions": [
      "Should the real CONFPASS CLI contract replace this adapter's assumed JSON report schema once the tool is available?",
      "Should EffectiveConfiguration.from_pm7_config map PM7Config.max_conformers onto the selection top_n instead of leaving them independent?"
    ],
    "confidence": "The design and the acceptance mapping are solid, but since no command could run here I cannot claim the tests actually pass."
  };

const ACCEPTED = 'be5ff5a76517c3d13477087db560db5cd87246e3';
const SEALED_AT = '2026-08-27T14:00:47.912Z';

function realDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...structuredClone(REAL_TASK_04_DRAFT), ...overrides };
}

/** Um draft estruturalmente válido de tamanho arbitrário, dentro do schema. */
function draftOfRoughly(repetitions: number): Record<string, unknown> {
  return realDraft({
    decisions: Array.from({ length: 5 }, (_, index) =>
      `decisão ${index}: ${'texto estruturado e legítimo do worker '.repeat(repetitions)}`,
    ),
    open_questions: Array.from({ length: 5 }, (_, index) =>
      `pergunta ${index}: ${'contexto que o próximo worker precisa '.repeat(repetitions)}`,
    ),
  });
}

function packetWith(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    task_id: 'mopac_minimum_workflow',
    title: 'Tarefa seguinte',
    objective: 'Consumir o handoff anterior.',
    base_sha: ACCEPTED,
    initial_files: ['pyproject.toml'],
    acceptance: ['critério observável verificado por teste'],
    validation: [{ argv: ['pytest', '-q'], timeout_seconds: 300 }],
    constraints: ['não altera contrato fora do escopo'],
    previous_handoff: null,
    generated_at: SEALED_AT,
    ...overrides,
  };
}

/** Packet estruturalmente válido de tamanho arbitrário. */
function packetOfRoughly(constraintCount: number): Record<string, unknown> {
  return packetWith({
    constraints: Array.from(
      { length: constraintCount },
      (_, index) => `restrição ${index}: ${'texto declarado e legítimo do plano '.repeat(4)}`,
    ),
  });
}

describe('HandoffDraft — o byte budget não decide mais execução', () => {
  it('o draft REAL de 4438 bytes que matou a task 04 agora é aceito', () => {
    expect(byteSize(parseHandoffDraft(realDraft()))).toBe(4438);

    const parsed = parseHandoffDraft(realDraft());
    expect(parsed.task_id).toBe('crest_selection_workflow');
    expect(parsed.result).toBe('PASS');
    // 4438 > 4096: exatamente a comparação que abortava o lifecycle.
    expect(byteSize(parsed)).toBeGreaterThan(ADVISORY_HANDOFF_DRAFT_BYTES);
  });

  it('não existe teto substituto: um draft MUITO maior também é aceito', () => {
    const large = draftOfRoughly(40);
    expect(byteSize(large)).toBeGreaterThan(ADVISORY_HANDOFF_DRAFT_BYTES * 4);
    expect(parseHandoffDraft(large).task_id).toBe('crest_selection_workflow');

    const enormous = draftOfRoughly(400);
    expect(byteSize(enormous)).toBeGreaterThan(ADVISORY_HANDOFF_DRAFT_BYTES * 30);
    expect(parseHandoffDraft(enormous).task_id).toBe('crest_selection_workflow');
  });

  it('draft malformado continua falhando', () => {
    expect(() => parseHandoffDraft(realDraft({ result: 'TALVEZ' }))).toThrow();
    expect(() => parseHandoffDraft(realDraft({ schema_version: 99 }))).toThrow();
    const { task_id: _drop, ...missing } = realDraft();
    expect(() => parseHandoffDraft(missing)).toThrow();
  });

  it('campo desconhecido continua rejeitado, inclusive num draft enorme', () => {
    expect(() => parseHandoffDraft(realDraft({ campo_inventado: 1 }))).toThrow();
    expect(() =>
      parseHandoffDraft({ ...draftOfRoughly(400), campo_inventado: 1 }),
    ).toThrow();
  });

  it('remover o teto NÃO abriu canal de transcript', () => {
    for (const smuggled of [
      { transcript: 'turno 1: ...\nturno 2: ...' },
      { conversation: [{ role: 'user', content: 'oi' }] },
      { raw_stdout: 'saída inteira do pytest' },
      { diff: '--- a/x\n+++ b/x' },
    ]) {
      expect(() => parseHandoffDraft(realDraft(smuggled))).toThrow();
      // E tampouco cabe num draft grande: o schema é a fronteira, não o tamanho.
      expect(() => parseHandoffDraft({ ...draftOfRoughly(400), ...smuggled })).toThrow();
    }
  });

  it('o draft real sela num record válido, e o record continua sem teto', () => {
    const sealed = sealHandoff(parseHandoffDraft(realDraft()), {
      task_id: 'crest_selection_workflow',
      result: 'PASS',
      // Os fatos AUTORITATIVOS reais do attempt 1 da task 04.
      changed_files: REAL_TASK_04_DRAFT.changed_files,
      validations: [
        {
          argv: ['pytest', 'tests/unit/semi_imperium/test_conformer_selection.py', '-q'],
          exit_code: 0,
          timed_out: false,
          duration_ms: 2931,
        },
        { argv: ['git', 'diff', '--cached', '--check'], exit_code: 0, timed_out: false, duration_ms: 18 },
      ],
      accepted_commit: ACCEPTED,
      sealed_at: SEALED_AT,
    });
    const record = parseHandoffRecord(sealed);
    expect(record.accepted_commit).toBe(ACCEPTED);
    expect(byteSize(record)).toBeGreaterThan(ADVISORY_HANDOFF_DRAFT_BYTES);
    expect(() => parseHandoffRecord({ ...sealed, campo_inventado: 1 })).toThrow();
  });
});

describe('TaskPacket — o byte budget não decide mais execução', () => {
  it('packet válido acima do alvo advisório de 12 KiB é aceito', () => {
    const packet = packetOfRoughly(120);
    expect(byteSize(packet)).toBeGreaterThan(ADVISORY_TASK_PACKET_BYTES);
    expect(parseTaskPacket(packet).task_id).toBe('mopac_minimum_workflow');
  });

  it('não existe teto substituto: um packet MUITO maior também é aceito', () => {
    const enormous = packetOfRoughly(4_000);
    expect(byteSize(enormous)).toBeGreaterThan(ADVISORY_TASK_PACKET_BYTES * 30);
    expect(parseTaskPacket(enormous).task_id).toBe('mopac_minimum_workflow');
  });

  it('packet malformado continua falhando', () => {
    expect(() => parseTaskPacket(packetWith({ base_sha: 'nao-e-sha' }))).toThrow();
    expect(() => parseTaskPacket(packetWith({ validation: [{ argv: [], timeout_seconds: 1 }] }))).toThrow();
    const { objective: _drop, ...missing } = packetWith();
    expect(() => parseTaskPacket(missing)).toThrow();
  });

  it('campo desconhecido e transcript continuam rejeitados em packet enorme', () => {
    for (const smuggled of [
      { transcript: 'conversa anterior' },
      { conversation_state: { turns: 42 } },
      { credentials: { api_key: 'sk-fake' } },
    ]) {
      expect(() => parseTaskPacket({ ...packetOfRoughly(4_000), ...smuggled })).toThrow();
    }
  });
});

describe('tamanho vira telemetria, não veredito', () => {
  it('artifactSizeAdvisory mede e rotula sem lançar', () => {
    const draft = parseHandoffDraft(realDraft());
    const measured = artifactSizeAdvisory(draft, ADVISORY_HANDOFF_DRAFT_BYTES);
    expect(measured.bytes).toBe(4438);
    expect(measured.advisory_threshold_bytes).toBe(ADVISORY_HANDOFF_DRAFT_BYTES);
    expect(measured.advisory_threshold_exceeded).toBe(true);
  });

  it('measureProtocolArtifacts registra os dois artifacts do fechamento', () => {
    const packet = parseTaskPacket(packetWith()) as TaskPacket;
    const draft = parseHandoffDraft(realDraft());
    const telemetry = measureProtocolArtifacts(packet, draft);

    expect(telemetry.handoff_draft_bytes).toBe(4438);
    expect(telemetry.task_packet_bytes).toBe(byteSize(packet));
    expect(telemetry.advisory_threshold_exceeded).toBe(true);
  });

  it('draft ausente é ausência, nunca zero bytes', () => {
    const packet = parseTaskPacket(packetWith()) as TaskPacket;
    const telemetry = measureProtocolArtifacts(packet, null);
    expect(telemetry.handoff_draft_bytes).toBeNull();
    expect(telemetry.advisory_threshold_exceeded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// O incidente real não foi um parser recusando um objeto — foi o LIFECYCLE
// abortando depois do trabalho aceito. Provar a correção exige fechar a tarefa
// de ponta a ponta com um draft acima do alvo advisório.
// ---------------------------------------------------------------------------

describe('lifecycle — um draft acima do alvo advisório fecha a tarefa', () => {
  let sandbox: Sandbox;
  let paths: HarnessPaths;
  let loaded: LoadedPlan;

  beforeEach(async () => {
    sandbox = await makeSandboxRepo();
    paths = resolveHarnessPaths(sandbox.root);
    loaded = await loadPlan(paths.planFile);
    await ensureRuntimeDirs(paths);
    await writeState(paths, buildInitialState(loaded.plan, loaded.planSha256));
  });

  afterEach(async () => {
    await rm(sandbox.root, { recursive: true, force: true });
  });

  /** Draft v2 estruturalmente válido, deliberadamente acima de 4 KiB. */
  function oversizedDraft(taskId: string, changedFiles: readonly string[]): unknown {
    return {
      ...structuredClone(REAL_TASK_04_DRAFT),
      task_id: taskId,
      changed_files: [...changedFiles],
      validations: [],
      decisions: Array.from(
        { length: 5 },
        (_, index) => `decisão ${index}: ${'fato estruturado que o próximo worker precisa '.repeat(20)}`,
      ),
    };
  }

  it('closeTask promove PASS e registra o excesso como telemetria, não como veredito', async () => {
    const baseSha = await headSha(paths.repoRoot);
    const task = loaded.byId.get('T1')!;
    await writePacket(paths, buildTaskPacket({ task, baseSha, previousHandoff: null }));
    const initial = await readState(paths);
    await writeState(
      paths,
      withTaskState(initial, 'T1', {
        status: 'RUNNING',
        phase: 'FINALIZING',
        base_sha: baseSha,
        attempts: 1,
        started_at: new Date().toISOString(),
      }),
    );

    await mkdir(path.join(sandbox.root, 'src'), { recursive: true });
    await writeFile(path.join(sandbox.root, 'src/one.txt'), 'conteúdo\n', 'utf8');
    const candidate = await commitAll(sandbox.root, 'trabalho da T1');

    await ensureTaskInbox(paths, 'T1');
    await writeFile(
      reportPath(paths, 'T1'),
      JSON.stringify({
        schema_version: 1,
        task_id: 'T1',
        self_reported_result: 'SUCCESS',
        summary: 'trabalho concluído',
        candidate_commit: candidate,
        changed_files: ['src/one.txt'],
        validations: [{ argv: ['true'], exit_code: 0, timed_out: false, duration_ms: 5 }],
        decisions: [],
        lessons: [],
        relevant_files: [],
      }),
      'utf8',
    );
    const draft = oversizedDraft('T1', ['src/one.txt']);
    await writeFile(handoffDraftPath(paths, 'T1'), JSON.stringify(draft), 'utf8');
    // O tamanho que, antes desta correção, encerrava o lifecycle aqui.
    expect(byteSize(draft)).toBeGreaterThan(ADVISORY_HANDOFF_DRAFT_BYTES);

    const result = await closeTask({ paths, loaded, taskId: 'T1' });

    // 1. O trabalho válido é aceito — nada morre por tamanho.
    expect(result.kind).toBe('PASS');
    expect(result.completion?.status).toBe('PASS');
    expect(result.completion?.orchestrator_evidence.accepted_commit).toBe(candidate);
    expect(getTaskState(await readState(paths), 'T1').status).toBe('PASS');

    // 2. O record selado é persistido e relido, sem truncar nada.
    const sealed = await readHandoff(paths, 'T1');
    expect(sealed?.accepted_commit).toBe(candidate);
    expect(byteSize(sealed)).toBeGreaterThan(ADVISORY_HANDOFF_DRAFT_BYTES);

    // 3. O excesso vira telemetria no CompletionRecord — rótulo, não veredito.
    const persisted = await readCompletion(paths, 'T1');
    const bytes = persisted?.protocol_artifact_bytes;
    expect(bytes?.advisory_threshold_exceeded).toBe(true);
    // A telemetria mede o draft COMO PERSISTIDO, isto é, depois da
    // normalização de opinião — não o objeto cru de teste. Medir o cru
    // reportaria bytes que nunca existiram em disco.
    expect(bytes?.handoff_draft_bytes).toBe(byteSize(parseHandoffDraft(draft)));
    expect(bytes?.advisory_handoff_draft_threshold_bytes).toBe(ADVISORY_HANDOFF_DRAFT_BYTES);
    expect(bytes?.task_packet_bytes).toBeGreaterThan(0);
    // E o rótulo convive com PASS: excedido não é reprovado.
    expect(persisted?.status).toBe('PASS');
  }, 60_000);

  it('draft dentro do alvo fecha igual, com o rótulo em false', async () => {
    const baseSha = await headSha(paths.repoRoot);
    const task = loaded.byId.get('T1')!;
    await writePacket(paths, buildTaskPacket({ task, baseSha, previousHandoff: null }));
    const initial = await readState(paths);
    await writeState(
      paths,
      withTaskState(initial, 'T1', {
        status: 'RUNNING',
        phase: 'FINALIZING',
        base_sha: baseSha,
        attempts: 1,
        started_at: new Date().toISOString(),
      }),
    );

    await mkdir(path.join(sandbox.root, 'src'), { recursive: true });
    await writeFile(path.join(sandbox.root, 'src/one.txt'), 'conteúdo\n', 'utf8');
    const candidate = await commitAll(sandbox.root, 'trabalho da T1');

    await ensureTaskInbox(paths, 'T1');
    await writeFile(
      reportPath(paths, 'T1'),
      JSON.stringify({
        schema_version: 1,
        task_id: 'T1',
        self_reported_result: 'SUCCESS',
        summary: 'trabalho concluído',
        candidate_commit: candidate,
        changed_files: ['src/one.txt'],
        validations: [{ argv: ['true'], exit_code: 0, timed_out: false, duration_ms: 5 }],
        decisions: [],
        lessons: [],
        relevant_files: [],
      }),
      'utf8',
    );
    const small = {
      schema_version: 1,
      task_id: 'T1',
      result: 'PASS',
      changed_files: ['src/one.txt'],
      validations: [],
      decisions: [],
      lessons: [],
      next_relevant_files: [],
    };
    await writeFile(handoffDraftPath(paths, 'T1'), JSON.stringify(small), 'utf8');
    expect(byteSize(small)).toBeLessThanOrEqual(ADVISORY_HANDOFF_DRAFT_BYTES);

    const result = await closeTask({ paths, loaded, taskId: 'T1' });

    expect(result.kind).toBe('PASS');
    const persisted = await readCompletion(paths, 'T1');
    expect(persisted?.protocol_artifact_bytes?.advisory_threshold_exceeded).toBe(false);
    expect(persisted?.protocol_artifact_bytes?.handoff_draft_bytes).toBe(byteSize(small));
  }, 60_000);
});
