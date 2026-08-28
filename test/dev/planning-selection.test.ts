import { describe, expect, it } from 'vitest';

import {
  PLANNING_COLD_START_TOP_TIER_PROFILE_IDS,
  comparePlanningPreference,
  createPlanningFailoverPort,
  selectPlanningProfile,
  type PlanningPolicyContext,
  type PlanningProfileSnapshot,
} from '../../dev/lib/planning-selection.js';
import type { PlanningWorkerInvocation } from '../../src/planner/draft.js';

const OPUS = PLANNING_COLD_START_TOP_TIER_PROFILE_IDS[0];
const SOL = PLANNING_COLD_START_TOP_TIER_PROFILE_IDS[1];
const FLASH = 'opencode-go-deepseek-v4-flash-v1';
const PRO = 'opencode-go-deepseek-v4-pro-v1';
const OPENROUTER = 'opencode-openrouter-gemini-3.6-flash-api-v1';

const POLICY: PlanningPolicyContext = {
  allowed_providers: ['claude', 'codex', 'opencode'],
  allowed_billing_modes: ['subscription_only'],
  policy_profile_ids: [OPUS, SOL, FLASH, PRO],
};

function snapshot(
  overrides: Partial<PlanningProfileSnapshot> & Pick<PlanningProfileSnapshot, 'id'>,
): PlanningProfileSnapshot {
  return {
    agent: 'opencode',
    declared_provider: 'opencode_go',
    billing_mode: 'subscription_only',
    capability_rank: 0,
    capability_tier: 'intermediate',
    planner_compatible: true,
    credential_available: true,
    quota_available: true,
    ...overrides,
  };
}

const opus = snapshot({
  id: OPUS,
  agent: 'claude',
  declared_provider: null,
  capability_rank: 3,
  capability_tier: null,
});
const sol = snapshot({
  id: SOL,
  agent: 'codex',
  declared_provider: null,
  capability_rank: 2,
  capability_tier: null,
});
const flash = snapshot({
  id: FLASH,
  capability_rank: 4,
  capability_tier: 'economy',
});
const pro = snapshot({
  id: PRO,
  capability_rank: 5,
  capability_tier: 'intermediate',
});

const invocation = {
  schema_version: 1,
  role: 'READ_ONLY_PLANNER',
  workspace_access: 'READ_ONLY',
  packet: { packet_id: 'pkt' },
  human_instruction: 'planejar',
} as unknown as PlanningWorkerInvocation;

function draftFrom(profileId: string) {
  return {
    outcome: 'DRAFT_RETURNED' as const,
    invocation_id: profileId,
    provider_id: 'test',
    model: profileId,
    draft: { schema_version: 1, tasks: [] },
  };
}

describe('seleção de planner — política de PLANNING', () => {
  it('Opus e Sol disponíveis: um top-tier planeja, Opus primeiro no cold-start', () => {
    const selection = selectPlanningProfile({
      snapshots: [flash, sol, opus],
      policy: POLICY,
    });
    expect(selection.outcome).toBe('SELECTED');
    if (selection.outcome !== 'SELECTED') return;
    expect(selection.profile_id).toBe(OPUS);
    expect(selection.ranked_profile_ids[0]).toBe(OPUS);
    expect(selection.ranked_profile_ids[1]).toBe(SOL);
  });

  it('Opus EXHAUSTED: Sol planeja automaticamente', () => {
    const selection = selectPlanningProfile({
      snapshots: [{ ...opus, quota_available: false }, sol, pro],
      policy: POLICY,
    });
    expect(selection.outcome).toBe('SELECTED');
    if (selection.outcome !== 'SELECTED') return;
    expect(selection.profile_id).toBe(SOL);
  });

  it('Sol EXHAUSTED: Opus planeja automaticamente', () => {
    const selection = selectPlanningProfile({
      snapshots: [opus, { ...sol, quota_available: false }, pro],
      policy: POLICY,
    });
    expect(selection.outcome).toBe('SELECTED');
    if (selection.outcome !== 'SELECTED') return;
    expect(selection.profile_id).toBe(OPUS);
  });

  it('ambos EXHAUSTED: OpenCode Go planner-compatible mais capaz autorizado', () => {
    const selection = selectPlanningProfile({
      snapshots: [
        { ...opus, quota_available: false },
        { ...sol, quota_available: false },
        flash,
        pro,
      ],
      policy: POLICY,
    });
    expect(selection.outcome).toBe('SELECTED');
    if (selection.outcome !== 'SELECTED') return;
    expect(selection.profile_id).toBe(PRO);
    expect(selection.ranked_profile_ids).not.toContain(OPUS);
    expect(selection.ranked_profile_ids).not.toContain(SOL);
  });

  it('Flash economy não vence intermediate numa task de planning', () => {
    expect(comparePlanningPreference(flash, pro)).toBeGreaterThan(0);
    const selection = selectPlanningProfile({
      snapshots: [flash, pro],
      policy: POLICY,
    });
    expect(selection.outcome).toBe('SELECTED');
    if (selection.outcome !== 'SELECTED') return;
    expect(selection.profile_id).toBe(PRO);
  });

  it('quota UNKNOWN permanece elegível e não vira exhaustion', () => {
    const selection = selectPlanningProfile({
      snapshots: [{ ...opus, quota_available: null }, { ...sol, quota_available: false }],
      policy: POLICY,
    });
    expect(selection.outcome).toBe('SELECTED');
    if (selection.outcome !== 'SELECTED') return;
    expect(selection.profile_id).toBe(OPUS);
  });

  it('profile fora da authorization nunca entra, mesmo sendo top-tier', () => {
    const selection = selectPlanningProfile({
      snapshots: [opus, sol, flash],
      policy: {
        ...POLICY,
        policy_profile_ids: [FLASH],
        allowed_providers: ['opencode'],
      },
    });
    expect(selection.outcome).toBe('SELECTED');
    if (selection.outcome !== 'SELECTED') return;
    expect(selection.profile_id).toBe(FLASH);
    expect(selection.ranked_profile_ids).not.toContain(OPUS);
  });

  it('OpenRouter/API nunca entra por fallback implícito', () => {
    const openrouter = snapshot({
      id: OPENROUTER,
      agent: 'opencode',
      declared_provider: 'openrouter',
      billing_mode: 'api',
      capability_rank: 9,
      capability_tier: 'advanced',
    });
    const selection = selectPlanningProfile({
      snapshots: [
        { ...opus, quota_available: false },
        { ...sol, quota_available: false },
        pro,
        openrouter,
      ],
      policy: POLICY,
    });
    expect(selection.outcome).toBe('SELECTED');
    if (selection.outcome !== 'SELECTED') return;
    expect(selection.profile_id).toBe(PRO);
    expect(selection.ranked_profile_ids).not.toContain(OPENROUTER);
  });

  it('explicit planner profile é respeitado quando elegível', () => {
    const selection = selectPlanningProfile({
      snapshots: [opus, sol, flash],
      policy: POLICY,
      requested_profile_id: FLASH,
    });
    expect(selection.outcome).toBe('SELECTED');
    if (selection.outcome !== 'SELECTED') return;
    expect(selection.profile_id).toBe(FLASH);
    expect(selection.ranked_profile_ids).toEqual([FLASH]);
  });

  it('explicit planner fora da policy falha explicitamente, nunca é ignorado', () => {
    const selection = selectPlanningProfile({
      snapshots: [opus, sol],
      policy: POLICY,
      requested_profile_id: OPENROUTER,
    });
    expect(selection.outcome).toBe('EXPLICIT_NOT_IN_POLICY');
    if (selection.outcome !== 'EXPLICIT_NOT_IN_POLICY') return;
    expect(selection.profile_id).toBe(OPENROUTER);
    expect(selection.reason).toContain('não pertence');
  });

  it('explicit planner EXHAUSTED falha explicitamente em vez de failover silencioso', () => {
    const selection = selectPlanningProfile({
      snapshots: [{ ...opus, quota_available: false }, sol],
      policy: POLICY,
      requested_profile_id: OPUS,
    });
    expect(selection.outcome).toBe('EXPLICIT_INELIGIBLE');
    if (selection.outcome !== 'EXPLICIT_INELIGIBLE') return;
    expect(selection.reason).toContain('EXHAUSTED');
  });

  it('ausência de top-tier não vira recusa se outro planner suficiente está autorizado', () => {
    const selection = selectPlanningProfile({
      snapshots: [pro, flash],
      policy: {
        ...POLICY,
        policy_profile_ids: [PRO, FLASH],
        allowed_providers: ['opencode'],
      },
    });
    expect(selection.outcome).toBe('SELECTED');
    if (selection.outcome !== 'SELECTED') return;
    expect(selection.profile_id).toBe(PRO);
  });

  it('história comparável de planning supera o cold-start', () => {
    const selection = selectPlanningProfile({
      snapshots: [opus, sol],
      policy: POLICY,
      history: [
        { profile_id: OPUS, comparable_n: 3, quality: 0.4 },
        { profile_id: SOL, comparable_n: 3, quality: 0.9 },
      ],
    });
    expect(selection.outcome).toBe('SELECTED');
    if (selection.outcome !== 'SELECTED') return;
    expect(selection.profile_id).toBe(SOL);
  });
});

describe('failover de invocação do planner', () => {
  it('INFRA no primeiro top-tier tenta o próximo elegível', async () => {
    const seen: string[] = [];
    const port = createPlanningFailoverPort({
      ranked_profile_ids: [OPUS, SOL],
      invokeWith: async (profileId) => {
        seen.push(profileId);
        if (profileId === OPUS) {
          return {
            outcome: 'INVOCATION_FAILED',
            invocation_id: profileId,
            provider_id: 'claude',
            model: profileId,
            failure: {
              code: 'PROVIDER_INVOCATION_FAILED',
              message: 'Unexpected server error',
              retryable: true,
            },
          };
        }
        return draftFrom(profileId);
      },
    });
    const result = await port.invoke(invocation);
    expect(seen).toEqual([OPUS, SOL]);
    expect(result.outcome).toBe('DRAFT_RETURNED');
    if (result.outcome !== 'DRAFT_RETURNED') return;
    expect(result.model).toBe(SOL);
  });

  it('draft ilegível não dispara failover', async () => {
    const seen: string[] = [];
    const port = createPlanningFailoverPort({
      ranked_profile_ids: [OPUS, SOL],
      invokeWith: async (profileId) => {
        seen.push(profileId);
        return {
          outcome: 'INVOCATION_FAILED',
          invocation_id: profileId,
          provider_id: 'claude',
          model: profileId,
          failure: {
            code: 'DRAFT_NOT_PARSEABLE',
            message: 'não é JSON',
            retryable: false,
          },
        };
      },
    });
    const result = await port.invoke(invocation);
    expect(seen).toEqual([OPUS]);
    expect(result.outcome).toBe('INVOCATION_FAILED');
    if (result.outcome !== 'INVOCATION_FAILED') return;
    expect(result.failure.code).toBe('DRAFT_NOT_PARSEABLE');
  });
});
