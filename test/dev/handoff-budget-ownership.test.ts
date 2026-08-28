import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ADVISORY_HANDOFF_DRAFT_BYTES,
  ADVISORY_TASK_PACKET_BYTES,
  byteSize,
  isHandoffRecordV2,
  parseHandoffDraft,
  parseHandoffRecord,
  parseTaskPacket,
  sealHandoff,
} from '../../dev/lib/schemas.js';
import { readHandoff, writeHandoff } from '../../dev/lib/records.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { ensureRuntimeDirs } from '../../dev/lib/state.js';

/**
 * Regressão da run real `semi-imperium-real-01`, tarefa
 * `semiimperium_domain_persistence`: draft de 4002 bytes selado num record de
 * 4318 bytes, e `BudgetExceededError` escapando no control plane DEPOIS que o
 * worker já tinha entregue trabalho válido e commitado.
 *
 * A fronteira que estes testes fixam é de PROPRIEDADE, não de tamanho: o draft
 * é payload do worker e o record é selado pelo orquestrador, que substitui
 * `changed_files`/`validations` por fato autoritativo e acrescenta
 * `accepted_commit`/`sealed_at`. O record cresce por conta do selo, e nenhum
 * dos dois é rejeitado por isso.
 *
 * Os 4 KiB e os 12 KiB citados aqui são ALVOS ADVISÓRIOS — telemetria, não
 * gate. Um segundo incidente real (task 04, `crest_selection_workflow`)
 * provou que o teto sobrevivente no draft também era bottleneck artificial;
 * a semântica nova vive em `artifact-size-advisory.test.ts`.
 */

const SEALED_AT = '2026-08-26T14:18:39.204Z';
const ACCEPTED = '3c4e7b1aa125591eb4e6998b2a27d73e01349576';

/** Os 10 arquivos reais do commit aceito da tarefa 02. */
const AUTHORITATIVE_CHANGED_FILES = [
  'CHANGELOG.md',
  'src/semi_imperium/domain/__init__.py',
  'src/semi_imperium/domain/configuration.py',
  'src/semi_imperium/domain/enums.py',
  'src/semi_imperium/domain/hashing.py',
  'src/semi_imperium/domain/identity.py',
  'src/semi_imperium/domain/records.py',
  'src/semi_imperium/persistence.py',
  'tests/unit/semi_imperium/__init__.py',
  'tests/unit/semi_imperium/test_persistence.py',
];

/** A validação oficial que o orquestrador executou — o worker declarou `[]`. */
const AUTHORITATIVE_VALIDATIONS = [
  {
    argv: ['pytest', 'tests/unit/semi_imperium/test_persistence.py', '-q'],
    exit_code: 0,
    timed_out: false,
    duration_ms: 4197,
  },
  { argv: ['git', 'diff', '--cached', '--check'], exit_code: 0, timed_out: false, duration_ms: 12 },
];

/**
 * O draft REAL que o worker da tarefa 02 escreveu, byte a byte (4002 bytes).
 * Vendorizado em vez de aproximado: a regressão só prova o que precisa provar
 * se o payload do worker for exatamente o que ele entregou. Repare que
 * `validations` é `[]` — validação oficial nunca foi dele.
 */
const REAL_WORKER_DRAFT = {
      "schema_version": 2,
      "task_id": "semiimperium_domain_persistence",
      "result": "PASS",
      "changed_files": [
        "CHANGELOG.md",
        "src/semi_imperium/domain/__init__.py",
        "src/semi_imperium/domain/configuration.py",
        "src/semi_imperium/domain/enums.py",
        "src/semi_imperium/domain/hashing.py",
        "src/semi_imperium/domain/identity.py",
        "src/semi_imperium/domain/records.py",
        "src/semi_imperium/persistence.py",
        "tests/unit/semi_imperium/__init__.py",
        "tests/unit/semi_imperium/test_persistence.py"
      ],
      "validations": [],
      "decisions": [
        "Calculations are stored under calculations/<molecule_id>/<signature_digest>/<calculation_id>.json; reuse lookup is a directory listing, per-run listing walks the tree. No secondary index to desync.",
        "Signature covers CREST search, conformer selection, MOPAC Hamiltonian/keywords/SCF and verification policy; threads/timeouts/paths excluded on purpose.",
        "InChIKey kept out of molecule_id (optional provenance) so RDKit builds without InChI yield identical ids.",
        "Saddle is a result state, reusable by default; VERIFIED_ONLY_REUSABLE_STATES for callers needing a proven minimum.",
        "Ids and run signatures recomputed on read; mismatches raise instead of silently redirecting reuse."
      ],
      "lessons": [
        "Sandbox denied python/pytest/poetry entirely; no execution evidence could be produced worker-side.",
        "Followed existing conventions: atomic write pattern from grimperium/runs/persistence.py, to_dict/from_dict from grimperium/calculation/contracts."
      ],
      "next_relevant_files": [
        "src/semi_imperium/domain/configuration.py",
        "src/semi_imperium/domain/records.py",
        "src/semi_imperium/persistence.py",
        "tests/unit/semi_imperium/test_persistence.py",
        "src/semi_imperium/app.py"
      ],
      "what_i_did_not_check": [
        "Nothing was executed: pytest tests/unit/semi_imperium/test_persistence.py never ran (python/pytest/poetry denied by the sandbox), so all test outcomes are unverified.",
        "black/ruff/mypy --strict were not run; formatting and strict typing of the new modules are unverified.",
        "The RDKit-dependent test (MolecularIdentity.from_smiles) was never executed; canonical SMILES and MolToInchiKey behaviour in this environment is assumed, not observed.",
        "Importing grimperium.crest_pm7.config pulls the whole crest_pm7 package (rdkit/pandas); that import chain was not exercised from the new test module.",
        "No wiring into the Semi-Imperium CLI/app was attempted; the domain and store are standalone and unused by app.py so far."
      ],
      "evidence": [
        {
          "kind": "file",
          "path": "src/semi_imperium/domain/configuration.py",
          "lines": "296-345",
          "claim": "from_pm7_config reads Grimperium's PM7Config and drops execution-only fields, keeping CREST, selection, MOPAC and verification in the signature."
        },
        {
          "kind": "file",
          "path": "src/semi_imperium/domain/enums.py",
          "lines": "14-105",
          "claim": "Pending, running, verified, unverified, saddle and failed are explicit enum members, as are the six verification outcomes."
        },
        {
          "kind": "file",
          "path": "src/semi_imperium/domain/enums.py",
          "lines": "175-205",
          "claim": "COHERENT_VERIFICATION_OUTCOMES pins which verification verdicts each state may carry."
        },
        {
          "kind": "file",
          "path": "src/semi_imperium/persistence.py",
          "lines": "143-200",
          "claim": "Calculations are addressed by reuse key and terminal records cannot be rewritten with a different state or verdict."
        },
        {
          "kind": "file",
          "path": "src/semi_imperium/domain/records.py",
          "lines": "256-290",
          "claim": "calculation_id is derived from run + molecule + signature and mismatches are rejected; reuse_key is molecule_id/signature digest."
        }
      ],
      "open_questions": [
        "Should the CALCULATE flow in semi_imperium/app.py consult SemiImperiumStore.find_reusable before dispatching work, and where should the store root live (repo runs/ vs a semi-imperium-specific directory)?",
        "Is 'saddle' reusable by default the policy the project wants, or should a saddle always force a re-run under a stricter conformer search?"
      ],
      "confidence": "The design and code were reviewed line by line against the acceptance criteria, but with zero commands executable in this sandbox I cannot claim the test file passes."
    } as const;

function realDraft(overrides: Record<string, unknown> = {}) {
  return { ...REAL_WORKER_DRAFT, ...overrides };
}

/** Os fatos que SÓ o orquestrador origina — a fonte do crescimento. */
const SEALING_FACTS = {
  task_id: 'semiimperium_domain_persistence',
  result: 'PASS' as const,
  changed_files: AUTHORITATIVE_CHANGED_FILES,
  validations: AUTHORITATIVE_VALIDATIONS,
  accepted_commit: ACCEPTED,
  sealed_at: SEALED_AT,
};

describe('propriedade do budget de handoff (regressão semi-imperium-real-01)', () => {
  it('um draft válido abaixo de 4 KiB sela num record acima de 4 KiB, e isso é legítimo', () => {
    const draft = parseHandoffDraft(realDraft());
    // O worker cumpriu o contrato dele.
    expect(byteSize(draft)).toBeLessThanOrEqual(ADVISORY_HANDOFF_DRAFT_BYTES);

    expect(byteSize(draft)).toBe(4002); // o número exato da run real

    const record = sealHandoff(draft, SEALING_FACTS);

    // ...e mesmo assim o record selado passa do teto do worker, com o tamanho
    // exato que apareceu na mensagem de erro da run real.
    expect(byteSize(record)).toBe(4318);
    expect(byteSize(record)).toBeGreaterThan(ADVISORY_HANDOFF_DRAFT_BYTES);

    // O control plane precisa aceitá-lo: era exatamente aqui que a run real
    // morria com BudgetExceededError.
    expect(() => parseHandoffRecord(record)).not.toThrow();
    const parsed = parseHandoffRecord(record);
    expect(parsed.accepted_commit).toBe(ACCEPTED);
    expect(parsed.result).toBe('PASS');
  });

  it('o excesso vem do selo autoritativo, não de um draft inválido', () => {
    const draft = parseHandoffDraft(realDraft());
    const draftBytes = byteSize(draft);

    // Mesmo selo, porém com os fatos que o worker de fato declarou: sem a
    // validação oficial e sem o commit aceito, o record caberia no teto.
    const withoutAuthority = sealHandoff(draft, { ...SEALING_FACTS, validations: [] });

    const sealed = sealHandoff(draft, SEALING_FACTS);

    // O crescimento se decompõe inteiramente em fato do orquestrador:
    //   +99  accepted_commit + sealed_at (campos que só existem no record)
    //   +216 as duas validações oficiais que o worker declarou como []
    const sealingFieldsGrowth = byteSize(withoutAuthority) - draftBytes;
    const officialValidationGrowth = byteSize(sealed) - byteSize(withoutAuthority);

    expect(sealingFieldsGrowth).toBeGreaterThan(0);
    expect(officialValidationGrowth).toBeGreaterThan(0);
    expect(draftBytes + sealingFieldsGrowth + officialValidationGrowth).toBe(byteSize(sealed));

    // E o draft, sozinho, nunca passou do teto: o worker não contribuiu com
    // um byte do excesso.
    expect(draftBytes).toBeLessThanOrEqual(ADVISORY_HANDOFF_DRAFT_BYTES);
    expect(byteSize(sealed)).toBeGreaterThan(ADVISORY_HANDOFF_DRAFT_BYTES);
  });

  it('nenhum campo de evidência é truncado no selo', () => {
    const draft = parseHandoffDraft(realDraft());
    const record = parseHandoffRecord(sealHandoff(draft, SEALING_FACTS));
    if (!isHandoffRecordV2(record)) throw new Error('record v2 esperado');

    expect(record.changed_files).toEqual(AUTHORITATIVE_CHANGED_FILES);
    expect(record.validations).toEqual(AUTHORITATIVE_VALIDATIONS);
    expect(record.decisions).toHaveLength(5);
    expect(record.lessons).toHaveLength(2);
    expect(record.next_relevant_files).toHaveLength(5);
    expect(record.evidence).toEqual(REAL_WORKER_DRAFT.evidence);
    expect(record.open_questions).toEqual(REAL_WORKER_DRAFT.open_questions);
    expect(record.what_i_did_not_check).toEqual(REAL_WORKER_DRAFT.what_i_did_not_check);
    expect(record.confidence).toBe(REAL_WORKER_DRAFT.confidence);
    expect(record.sealed_at).toBe(SEALED_AT);
    // As cinco lacunas reconhecidas pelo worker sobrevivem inteiras: nenhuma
    // delas é candidata a truncamento para caber num teto.
    expect(record.what_i_did_not_check).toHaveLength(5);
  });

  it('sela e preserva 51 arquivos reais junto com 21 validações oficiais', () => {
    const changedFiles = Array.from(
      { length: 51 },
      (_, index) => `src/semi_imperium/large-candidate/file-${index}.py`,
    );
    const validations = Array.from({ length: 21 }, (_, index) => ({
      argv: ['pytest', `tests/official/validation-${index}.py`, '-q'],
      exit_code: 0,
      timed_out: false,
      duration_ms: 100 + index,
    }));

    const record = parseHandoffRecord(
      sealHandoff(parseHandoffDraft(realDraft()), {
        ...SEALING_FACTS,
        changed_files: changedFiles,
        validations,
      }),
    );

    expect(record.changed_files).toEqual(changedFiles);
    expect(record.changed_files).toHaveLength(51);
    expect(record.validations).toEqual(validations);
    expect(record.validations).toHaveLength(21);
  });
});

describe('o draft do worker é validado por schema, não por tamanho', () => {
  it('draft acima do alvo advisório de 4 KiB é aceito', () => {
    const inflated = realDraft({
      decisions: Array.from({ length: 5 }, () => 'decisão deliberadamente longa '.repeat(30)),
    });
    expect(byteSize(inflated)).toBeGreaterThan(ADVISORY_HANDOFF_DRAFT_BYTES);
    expect(parseHandoffDraft(inflated).result).toBe('PASS');
  });

  it('draft v1 abaixo do budget continua aceito', () => {
    const v1 = {
      schema_version: 1,
      task_id: 'M01',
      result: 'PASS',
      changed_files: ['src/core/index.ts'],
      validations: [{ argv: ['pnpm', 'typecheck'], exit_code: 0, timed_out: false, duration_ms: 1200 }],
      decisions: ['ESM puro, sem CJS'],
      lessons: [],
      next_relevant_files: ['src/core/index.ts'],
    };
    expect(byteSize(v1)).toBeLessThanOrEqual(ADVISORY_HANDOFF_DRAFT_BYTES);
    const parsed = parseHandoffDraft(v1);
    expect(parsed.schema_version).toBe(1);
    // Draft v1 sela record v1 — compatibilidade histórica intacta.
    expect(sealHandoff(parsed, SEALING_FACTS).schema_version).toBe(1);
  });

  it('draft v2 realista continua abaixo do alvo advisório', () => {
    expect(byteSize(realDraft())).toBeLessThanOrEqual(ADVISORY_HANDOFF_DRAFT_BYTES);
  });
});

describe('remover o teto do record não afrouxa o schema', () => {
  const sealedBase = () => sealHandoff(parseHandoffDraft(realDraft()), SEALING_FACTS);

  it('record sem accepted_commit continua falhando', () => {
    const { accepted_commit: _drop, ...missing } = sealedBase() as Record<string, unknown>;
    expect(() => parseHandoffRecord(missing)).toThrow();
  });

  it('record com accepted_commit fora do formato SHA continua falhando', () => {
    expect(() => parseHandoffRecord({ ...sealedBase(), accepted_commit: 'nao-e-sha' })).toThrow();
  });

  it('record com sealed_at fora de ISO continua falhando', () => {
    expect(() => parseHandoffRecord({ ...sealedBase(), sealed_at: 'ontem' })).toThrow();
  });

  it('record com campo desconhecido continua falhando (strict)', () => {
    expect(() => parseHandoffRecord({ ...sealedBase(), campo_inventado: 1 })).toThrow();
  });

  it('record v2 sem what_i_did_not_check continua falhando', () => {
    const { what_i_did_not_check: _drop, ...missing } = sealedBase() as Record<string, unknown>;
    expect(() => parseHandoffRecord(missing)).toThrow();
  });

  it('record acima do limite semântico de decisões continua falhando', () => {
    expect(() =>
      parseHandoffRecord({ ...sealedBase(), decisions: ['a', 'b', 'c', 'd', 'e', 'f'] }),
    ).toThrow();
  });
});

describe('o TaskPacket é a entrada estruturada do worker, e a estrutura é a fronteira', () => {
  function packetWith(previousHandoff: unknown) {
    return {
      schema_version: 1,
      task_id: 'M02',
      title: 'Tarefa seguinte',
      objective: 'Consumir o handoff anterior.',
      base_sha: ACCEPTED,
      initial_files: ['package.json'],
      acceptance: Array.from(
        { length: 12 },
        (_, index) => `critério de aceitação ${index}: comportamento observável verificado por teste`,
      ),
      validation: [{ argv: ['pnpm', 'typecheck'], timeout_seconds: 300 }],
      constraints: Array.from(
        { length: 30 },
        (_, index) => `restrição ${index}: o worker não altera contrato fora do escopo da tarefa`,
      ),
      previous_handoff: previousHandoff,
      generated_at: SEALED_AT,
    };
  }

  it('um packet com o handoff selado real continua cabendo no alvo advisório', () => {
    const packet = parseTaskPacket(packetWith(sealedRecordForPacket()));
    expect(byteSize(packet)).toBeLessThanOrEqual(ADVISORY_TASK_PACKET_BYTES);
  });

  it('um packet cujo previous_handoff passa de 12 KiB é aceito', () => {
    // Handoff durável legítimo, porém grande: 50 arquivos e 20 validações
    // oficiais — tudo dentro do schema, tudo fato do orquestrador.
    const huge = sealHandoff(parseHandoffDraft(realDraft()), {
      ...SEALING_FACTS,
      changed_files: Array.from(
        { length: 50 },
        (_, index) => `src/semi_imperium/dominio/modulo-com-nome-bastante-longo-${index}.py`,
      ),
      validations: Array.from({ length: 20 }, (_, index) => ({
        argv: ['pytest', `tests/unit/semi_imperium/test_modulo_${index}.py`, '-q', '--maxfail=1'],
        exit_code: 0,
        timed_out: false,
        duration_ms: 1000 + index,
      })),
    });

    // O record em si é válido — é maior que o teto do worker e isso é legítimo.
    expect(() => parseHandoffRecord(huge)).not.toThrow();
    expect(byteSize(huge)).toBeGreaterThan(ADVISORY_HANDOFF_DRAFT_BYTES);

    // O mesmo packet sem o handoff cabe — logo é o previous_handoff, e só
    // ele, que estoura o teto.
    expect(() => parseTaskPacket(packetWith(null))).not.toThrow();

    // E o packet que o carrega também: o previous_handoff é fato autoritativo
    // do orquestrador sobre a tarefa anterior, e passar do alvo advisório não
    // é motivo para o Lab recusar o contexto que ele mesmo produziu.
    const packet = packetWith(huge);
    expect(byteSize(packet)).toBeGreaterThan(ADVISORY_TASK_PACKET_BYTES);
    expect(parseTaskPacket(packet).task_id).toBe('M02');
  });

  it('packet grande continua rejeitando campo não declarado', () => {
    const huge = sealHandoff(parseHandoffDraft(realDraft()), {
      ...SEALING_FACTS,
      changed_files: Array.from(
        { length: 50 },
        (_, index) => `src/semi_imperium/dominio/modulo-com-nome-bastante-longo-${index}.py`,
      ),
    });
    expect(() =>
      parseTaskPacket({ ...packetWith(huge), transcript: 'conversa anterior' }),
    ).toThrow();
  });

  function sealedRecordForPacket() {
    return sealHandoff(parseHandoffDraft(realDraft()), SEALING_FACTS);
  }
});

describe('o record selado acima do alvo advisório do draft é persistível', () => {
  let root: string;
  let paths: HarnessPaths;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'handoff-budget-'));
    paths = resolveHarnessPaths(root);
    await ensureRuntimeDirs(paths);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('grava e relê o record de 4318 bytes sem perder um campo', async () => {
    // `writeHandoff` revalida antes de gravar e `readHandoff` revalida ao ler:
    // era num desses dois pontos que a run real morria.
    const sealed = sealHandoff(parseHandoffDraft(realDraft()), SEALING_FACTS);
    expect(byteSize(sealed)).toBeGreaterThan(ADVISORY_HANDOFF_DRAFT_BYTES);

    await writeHandoff(paths, sealed);
    const roundTripped = await readHandoff(paths, SEALING_FACTS.task_id);

    expect(roundTripped).toEqual(sealed);
    expect(byteSize(roundTripped)).toBe(4318);
  });
});
