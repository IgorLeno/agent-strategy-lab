import { describe, expect, it } from 'vitest';

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  PLANNING_COLD_START_TOP_TIER_PROFILE_IDS,
  comparePlanningPreference,
  createPlanningFailoverPort,
  rankPlanningCandidates,
  selectPlanningProfile,
  type PlanningPolicyContext,
  type PlanningProfileSnapshot,
} from '../../dev/lib/planning-selection.js';
import { REPO_ROOT } from './helpers.js';
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

  it('role capability UNKNOWN não afirma planner-compatible; quota UNKNOWN não bloqueia', () => {
    const unknownRole = snapshot({
      id: PRO,
      planner_compatible: null,
      quota_available: true,
    });
    const unknownQuota = snapshot({
      ...opus,
      quota_available: null,
    });
    const unknownRoleSelection = selectPlanningProfile({
      snapshots: [unknownRole],
      policy: { ...POLICY, policy_profile_ids: [PRO], allowed_providers: ['opencode'] },
    });
    expect(unknownRoleSelection.outcome).toBe('NONE_ELIGIBLE');
    if (unknownRoleSelection.outcome !== 'NONE_ELIGIBLE') return;
    expect(unknownRoleSelection.reason).toMatch(/planner-compatible|UNKNOWN|não foi provad/i);

    const unknownQuotaSelection = selectPlanningProfile({
      snapshots: [unknownQuota, { ...sol, quota_available: false }],
      policy: POLICY,
    });
    expect(unknownQuotaSelection.outcome).toBe('SELECTED');
    if (unknownQuotaSelection.outcome !== 'SELECTED') return;
    expect(unknownQuotaSelection.profile_id).toBe(OPUS);
  });

  it('role capability FALSE é inelegível mesmo com quota UNKNOWN', () => {
    const selection = selectPlanningProfile({
      snapshots: [
        snapshot({ id: PRO, planner_compatible: false, quota_available: null }),
      ],
      policy: { ...POLICY, policy_profile_ids: [PRO], allowed_providers: ['opencode'] },
    });
    expect(selection.outcome).toBe('NONE_ELIGIBLE');
  });

  it('ranking de planning é ordem total transitiva entre pelo menos três profiles', () => {
    const ranked = rankPlanningCandidates([flash, pro, sol, opus]);
    const again = rankPlanningCandidates([...ranked].reverse());
    expect(ranked.map((entry) => entry.id)).toEqual(again.map((entry) => entry.id));
    expect(ranked.map((entry) => entry.id)).toEqual([OPUS, SOL, PRO, FLASH]);
    for (let i = 0; i < ranked.length; i += 1) {
      for (let j = i + 1; j < ranked.length; j += 1) {
        expect(comparePlanningPreference(ranked[i] as PlanningProfileSnapshot, ranked[j] as PlanningProfileSnapshot)).toBeLessThan(0);
      }
    }
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

  it('PLANNING_LAUNCH_HUMAN_REQUIRED não chama o próximo planner elegível', async () => {
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
              code: 'PLANNING_LAUNCH_HUMAN_REQUIRED',
              message: 'credencial não provada',
              retryable: false,
            },
          };
        }
        return draftFrom(profileId);
      },
    });
    const result = await port.invoke(invocation);
    expect(seen).toEqual([OPUS]);
    expect(result.outcome).toBe('INVOCATION_FAILED');
    if (result.outcome !== 'INVOCATION_FAILED') return;
    expect(result.failure.code).toBe('PLANNING_LAUNCH_HUMAN_REQUIRED');
  });

  it('BILLING_PREFLIGHT_REFUSED não atravessa autorização por fallback', async () => {
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
              code: 'BILLING_PREFLIGHT_REFUSED',
              message: 'api key detectada',
              retryable: false,
            },
          };
        }
        return draftFrom(profileId);
      },
    });
    const result = await port.invoke(invocation);
    expect(seen).toEqual([OPUS]);
    expect(result.outcome).toBe('INVOCATION_FAILED');
    if (result.outcome !== 'INVOCATION_FAILED') return;
    expect(result.failure.code).toBe('BILLING_PREFLIGHT_REFUSED');
  });

  it('quota EXHAUSTED tipada tenta o próximo profile elegível', async () => {
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
              code: 'PLANNING_QUOTA_EXHAUSTED',
              message: 'pool anthropic_subscription EXHAUSTED',
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
  });

  it('HUMAN_REQUIRED marcado retryable ainda não faz failover — o código é a autoridade', async () => {
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
            code: 'PLANNING_LAUNCH_HUMAN_REQUIRED',
            message: 'gate humano',
            retryable: true,
          },
        };
      },
    });
    const result = await port.invoke(invocation);
    expect(seen).toEqual([OPUS]);
    expect(result.outcome).toBe('INVOCATION_FAILED');
  });
});

describe('história de planning em produção', () => {
  it('runProject não liga PlanningHistoryObservation ao selector', async () => {
    const source = await readFile(path.join(REPO_ROOT, 'dev/lib/run-project.ts'), 'utf8');
    expect(source).not.toContain('PlanningHistoryObservation');
    expect(source).not.toMatch(/\bhistory\s*:/);
  });

  it('deliberadores publicam upstream de providerFactsOf, não scaffold agent', async () => {
    const source = await readFile(path.join(REPO_ROOT, 'dev/lib/run-project.ts'), 'utf8');
    expect(source).toContain('providerFactsOf');
    expect(source).not.toMatch(/assignments\.push\(\{[\s\S]*provider:\s*capability\.agent/m);
  });
});
