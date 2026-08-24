import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { buildPlannerPrompt } from '../../dev/lib/project-orchestrate.js';
import type { ProjectInspection } from '../../src/inspection/index.js';
import {
  compileIntakeFieldsDeterministic,
  createHumanInstruction,
  ProjectIntakeRequest,
  type ExecutionAuthorizationScope,
} from '../../src/intake/index.js';
import {
  MAX_PLANNER_PACKET_BYTES,
  buildPlannerPacket,
  type PlanningWorkerInvocation,
  type PlanningWorkerInvocationResult,
  type PlanningWorkerPort,
} from '../../src/planner/draft.js';
import { generateImplementationPlan } from '../../src/planner/generate.js';
import type { PlannedTask } from '../../src/planner/task.js';

const HEAD_SHA = 'b'.repeat(40);

/**
 * Corpo REALISTA e grande (>20k chars): objetivo, contexto, restrições,
 * evidências e checklist com salvaguardas negativas — o formato real das Run
 * Directives que quebraram o limite de 4000 do packet antigo.
 */
function longBody(): string {
  const section = [
    '## Contexto operacional',
    'O control plane deve orquestrar a correção sem micromanagement do worker.',
    'Evidence runtime: data/project-runs/self/e3b7cea8cfe5c555-facd91ca9a66.',
    'A validação oficial pertence ao orquestrador; o worker faz validação targeted.',
    'Não fazer force push. Não usar API key. Não fazer deploy em produção.',
    'Do not start Wave 2. Never delete evidence runtimes.',
    '```',
    'expected: worker_runtime_budget <= profile.timeout_seconds * 1000',
    'observed: 1996000ms > 1800000ms',
    '```',
  ].join('\n');
  const body = ['# Objective', 'Corrigir a fronteira de contrato do planner.', ''];
  while (body.join('\n').length < 21_000) body.push(section, '');
  return body.join('\n').trim();
}

function inspection(): ProjectInspection {
  return {
    schema_version: 1,
    repo_root: '/target',
    inspected_at: '2026-08-24T00:00:00.000Z',
    git: {
      known: true,
      value: { head_sha: HEAD_SHA, branch: 'main', dirty: false, remotes: [] },
      provenance: 'git',
    },
    stack: {
      known: true,
      value: { primary_ecosystem: 'node', ecosystems_detected: ['node'] },
      provenance: 'package.json',
    },
    package_manager: { known: true, value: 'pnpm', provenance: 'pnpm-lock.yaml' },
    build_system: { known: true, value: 'typescript', provenance: 'tsconfig.json' },
    directories: [{ path: 'src', role: 'source' }],
    tests: {
      known: true,
      value: { framework: 'vitest', test_directories: ['test'] },
      provenance: 'vitest.config.ts',
    },
    validation_command_candidates: [
      { name: 'typecheck', command: 'pnpm typecheck', source: 'package.json:scripts' },
    ],
    dependencies_state: {
      known: true,
      value: { lockfile_path: 'pnpm-lock.yaml', installed: true },
      provenance: 'node_modules',
    },
    required_tools: [{ name: 'node', reason: 'runtime', source: 'package.json:engines' }],
    required_services: [],
    filesystem_permissions: {
      known: true,
      value: { readable: true, writable: true },
      provenance: 'fs access',
    },
    feedback_sources: [],
    project_instructions: [{ path: 'AGENTS.md', scope: 'root', relevance: 'general' }],
    source_anchors: [{ area: 'planner', path: 'src/planner' }],
    relevant_files: ['src/planner/generate.ts'],
    risks: [],
  };
}

/** Reproduz o caminho REAL do produto: instrução -> compiler determinístico -> intake. */
function productIntake(body: string): ProjectIntakeRequest {
  const instruction = createHumanInstruction({
    raw_instruction: body,
    source: 'stdin',
    target_type: 'self',
    target_identity: '/target',
    base_sha: HEAD_SHA,
  });
  const fields = compileIntakeFieldsDeterministic(instruction);
  return ProjectIntakeRequest.parse({
    schema_version: 1,
    target_repo: { url: '/target' },
    base_revision: { sha: HEAD_SHA },
    user_request: body,
    objectives: fields.objectives,
    constraints: fields.constraints,
    exclusions: fields.exclusions,
    requested_scope: fields.requested_scope,
  });
}

function scopeOf(intake: ProjectIntakeRequest): ExecutionAuthorizationScope {
  return {
    schema_version: 1,
    requested_scope: intake.requested_scope,
    autonomous_execution_boundary: ['DISPOSABLE_LOCAL_WORKSPACE'],
    human_gated_capabilities: ['DESTRUCTIVE_ACTION'],
  };
}

function validTask(intake: ProjectIntakeRequest): PlannedTask {
  return {
    schema_version: 1,
    task_id: 'T1',
    objective: intake.requested_scope.summary,
    blocked_by: [],
    taxonomy: {
      version: 1,
      task_class: 'feature',
      difficulty_declared: 'medium',
      complexity: 'local',
      ambiguity: 'low',
      verification: 'deterministic',
    },
    risk: 'low',
    acceptance: [...intake.objectives],
    validation: [{ argv: ['pnpm', 'typecheck'], timeout_seconds: 300 }],
    initial_files: ['src/planner/generate.ts'],
    probable_files: [],
    context_scope: { areas: ['planner'] },
    context_requirements: [{ description: 'planner existente', source_anchor: 'src/planner' }],
    environment_requirements: [],
    estimated_duration: { expected: 600_000, maximum: 1_800_000 },
    validation_budget: { expected: 60_000, maximum: 300_000 },
    resource_envelope: {
      duration_ms: { expected: 600_000, maximum: 1_800_000 },
      tokens: { expected: 50_000, maximum: 150_000 },
      changed_files: { expected: 3, maximum: 8 },
    },
  };
}

class CapturingPlanner implements PlanningWorkerPort {
  readonly invocations: PlanningWorkerInvocation[] = [];

  constructor(private readonly intake: ProjectIntakeRequest) {}

  async invoke(invocation: PlanningWorkerInvocation): Promise<PlanningWorkerInvocationResult> {
    this.invocations.push(invocation);
    return {
      outcome: 'DRAFT_RETURNED',
      invocation_id: 'long-1',
      provider_id: 'fake',
      model: 'deterministic-test-double',
      draft: { schema_version: 1, tasks: [validTask(this.intake)] },
    };
  }
}

describe('instrução humana completa >20k chars atravessa intake -> packet -> planner', () => {
  it('sem 4k rejection, sem truncation, com byte equality na entrega ao planner', async () => {
    const body = longBody();
    expect(body.length).toBeGreaterThan(20_000);
    const intake = productIntake(body);
    const planner = new CapturingPlanner(intake);

    const result = await generateImplementationPlan({
      intake,
      inspection: inspection(),
      authorizationScope: scopeOf(intake),
      planningWorker: planner,
    });

    expect(result.outcome).toBe('AUTHORIZED');
    expect(planner.invocations).toHaveLength(1);
    const invocation = planner.invocations[0] as PlanningWorkerInvocation;

    // Byte equality — nada de substring: truncation silenciosa reprovaria aqui.
    expect(Buffer.from(invocation.human_instruction, 'utf8').equals(Buffer.from(body, 'utf8'))).toBe(true);

    // Packet continua bounded e amarrado à autoridade pelo hash.
    const packetBytes = Buffer.byteLength(JSON.stringify(invocation.packet), 'utf8');
    expect(packetBytes).toBeLessThanOrEqual(MAX_PLANNER_PACKET_BYTES);
    expect(invocation.packet.user_intent.instruction_sha256).toBe(
      createHash('sha256').update(body, 'utf8').digest('hex'),
    );
    // O corpo completo NÃO é duplicado dentro do packet: o final da instrução
    // (além do clip derivado de objectives) não aparece lá.
    expect(JSON.stringify(invocation.packet)).not.toContain(body.slice(-200));

    // O prompt entregue ao provider carrega a instrução completa verbatim.
    const prompt = buildPlannerPrompt(invocation);
    expect(prompt.includes(body)).toBe(true);
  });

  it('buildPlannerPacket permanece pequeno mesmo com instrução gigante', () => {
    const body = longBody();
    const intake = productIntake(body);
    const packet = buildPlannerPacket({
      packetId: 'c'.repeat(64),
      intake,
      inspection: inspection(),
      authorizationScope: scopeOf(intake),
    });
    expect(Buffer.byteLength(JSON.stringify(packet), 'utf8')).toBeLessThanOrEqual(MAX_PLANNER_PACKET_BYTES);
  });
});
