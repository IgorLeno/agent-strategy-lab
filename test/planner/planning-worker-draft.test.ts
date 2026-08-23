import { describe, expect, it } from 'vitest';

import type { ProjectInspection } from '../../src/inspection/index.js';
import type { ExecutionAuthorizationScope, ProjectIntakeRequest } from '../../src/intake/index.js';
import {
  MAX_PLANNER_PACKET_BYTES,
  PlannerPacket,
  PlanningWorkerInvocation,
  buildPlannerPacket,
  normalizeUntrustedPlanDraft,
} from '../../src/planner/draft.js';

const HEAD_SHA = 'b'.repeat(40);
const PACKET_ID = 'c'.repeat(64);

function intake(constraints: string[] = ['preservar API']): ProjectIntakeRequest {
  return {
    schema_version: 1,
    target_repo: { url: 'https://example.test/repo.git' },
    base_revision: { sha: HEAD_SHA },
    user_request: 'Planejar mudanca local',
    objectives: ['Mudanca validada'],
    constraints,
    exclusions: ['deploy'],
    requested_scope: { summary: 'Mudanca local' },
  };
}

const authorization: ExecutionAuthorizationScope = {
  schema_version: 1,
  requested_scope: { summary: 'Mudanca local' },
  autonomous_execution_boundary: ['DETERMINISTIC_VALIDATION'],
  human_gated_capabilities: ['EXTERNAL_SIDE_EFFECT'],
};

function inspection(): ProjectInspection {
  return {
    schema_version: 1,
    repo_root: '/repo',
    inspected_at: '2026-08-19T00:00:00.000Z',
    git: {
      known: true,
      value: { head_sha: HEAD_SHA, branch: 'main', dirty: false, remotes: [] },
      provenance: 'git',
    },
    stack: {
      known: true,
      value: { primary_ecosystem: 'node', ecosystems_detected: ['node'] },
      provenance: 'manifest',
    },
    package_manager: { known: true, value: 'pnpm', provenance: 'lockfile' },
    build_system: { known: true, value: 'typescript', provenance: 'tsconfig' },
    directories: [],
    tests: {
      known: true,
      value: { framework: 'vitest', test_directories: ['test'] },
      provenance: 'config',
    },
    validation_command_candidates: [
      { name: 'typecheck', command: 'pnpm typecheck', source: 'package.json' },
    ],
    dependencies_state: {
      known: true,
      value: { lockfile_path: 'pnpm-lock.yaml', installed: true },
      provenance: 'fs',
    },
    required_tools: [],
    required_services: [],
    filesystem_permissions: {
      known: true,
      value: { readable: true, writable: true },
      provenance: 'fs',
    },
    feedback_sources: [],
    project_instructions: [{ path: 'AGENTS.md', scope: 'root', relevance: 'general' }],
    source_anchors: [{ area: 'planner', path: 'src/planner' }],
    relevant_files: ['src/planner/task.ts'],
    risks: ['working tree pode estar dirty'],
  };
}

describe('PlannerPacket e porta provider-agnostic', () => {
  it('carrega somente fatos derivados, anchors e contrato protegido dentro do byte budget', () => {
    const packet = buildPlannerPacket({
      packetId: PACKET_ID,
      intake: intake(),
      inspection: inspection(),
      authorizationScope: authorization,
    });
    expect(PlannerPacket.parse(packet)).toEqual(packet);
    expect(Buffer.byteLength(JSON.stringify(packet))).toBeLessThanOrEqual(MAX_PLANNER_PACKET_BYTES);
    expect(packet.source_anchors).toEqual(
      expect.arrayContaining([
        { area: 'planner', path: 'src/planner' },
        { area: 'project_instruction', path: 'AGENTS.md' },
        { area: 'relevant_file', path: 'src/planner/task.ts' },
      ]),
    );
    expect(packet).not.toHaveProperty('transcript');
    expect(packet).not.toHaveProperty('documentation');
    expect(packet.planning_contract).toMatchObject({
      worker_role: 'READ_ONLY_PLANNER',
      output_trust: 'UNTRUSTED_DRAFT',
      routing_policy: { owner: 'CONTROL_PLANE' },
    });
  });

  it('recusa packet acima do limite em vez de truncar constraints', () => {
    expect(() =>
      buildPlannerPacket({
        packetId: PACKET_ID,
        intake: intake(Array.from({ length: 20 }, (_, index) => `${index}-${'x'.repeat(900)}`)),
        inspection: inspection(),
        authorizationScope: authorization,
      }),
    ).toThrow(/excede o limite/);
  });

  it('exige read-only no contrato de invocacao', () => {
    const packet = buildPlannerPacket({
      packetId: PACKET_ID,
      intake: intake(),
      inspection: inspection(),
      authorizationScope: authorization,
    });
    expect(
      PlanningWorkerInvocation.safeParse({
        schema_version: 1,
        role: 'READ_ONLY_PLANNER',
        workspace_access: 'READ_WRITE',
        packet,
      }).success,
    ).toBe(false);
  });
});

describe('normalizeUntrustedPlanDraft', () => {
  it.each([
    'plan_policy',
    'acceptance_contract',
    'routing_policy',
    'safety_boundaries',
    'authorization_scope',
    'authorized_state',
  ])('recusa tentativa do worker de incluir campo protegido %s', (protectedField) => {
    const result = normalizeUntrustedPlanDraft({
      schema_version: 1,
      tasks: [{}],
      [protectedField]: {},
    });
    expect(result.outcome).toBe('INVALID_DRAFT');
    if (result.outcome !== 'INVALID_DRAFT') throw new Error('unreachable');
    expect(result.issues.some((issue) => issue.message.includes(protectedField))).toBe(true);
  });

  it('recusa a forma "intuitiva" que um modelo produziria: nenhum mapeamento heurístico existe', () => {
    const result = normalizeUntrustedPlanDraft({
      schema_version: 1,
      tasks: [
        {
          id: 'T1',
          title: 'Inicializar aplicação React/TypeScript',
          depends_on: [],
          intent: 'bootstrap do projeto',
        },
      ],
    });
    expect(result.outcome).toBe('INVALID_DRAFT');
    if (result.outcome !== 'INVALID_DRAFT') throw new Error('unreachable');
    const messages = result.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join(' ');
    expect(messages).toContain('task_id');
    expect(messages).toContain('objective');
  });

  it('recusa task incompleta sem inserir defaults silenciosos', () => {
    const raw = { schema_version: 1, tasks: [{ schema_version: 1, task_id: 'T1' }] };
    const snapshot = structuredClone(raw);
    const result = normalizeUntrustedPlanDraft(raw);
    expect(result.outcome).toBe('INVALID_DRAFT');
    expect(raw).toEqual(snapshot);
  });
});
