import { describe, expect, it } from 'vitest';

import { selectReviewerProfileForFreshCapacity } from '../../dev/lib/reviewer-capacity.js';
import { CapacityStatus } from '../../src/quota/index.js';

const POLICY = [
  { id: 'codex-sol', capability_rank: 2 },
  { id: 'claude-opus', capability_rank: 3 },
  { id: 'opencode-go-kimi', capability_rank: 4 },
] as const;

function poolOf(profileId: string): string | null {
  if (profileId.startsWith('codex')) return 'openai_chatgpt_subscription';
  if (profileId.startsWith('claude')) return 'anthropic_subscription';
  if (profileId.startsWith('opencode-go')) return 'opencode_go_subscription';
  return null;
}

function capacity(status: (typeof CapacityStatus)[keyof typeof CapacityStatus]) {
  return { status };
}

describe('reviewer — pool EXHAUSTED do profile pinado não bloqueia outro autorizado', () => {
  it('mantém o reviewer pinado quando o pool NÃO está EXHAUSTED', () => {
    const selected = selectReviewerProfileForFreshCapacity({
      pinnedProfileId: 'codex-sol',
      policyProfiles: POLICY,
      poolOf,
      capacityByPool: new Map([
        ['openai_chatgpt_subscription', capacity(CapacityStatus.KNOWN)],
        ['anthropic_subscription', capacity(CapacityStatus.KNOWN)],
      ]),
    });
    expect(selected.profileId).toBe('codex-sol');
    expect(selected.rerouted).toBe(false);
  });

  it('UNKNOWN fresco do pool pinado não exclui e não autoriza rerrotear', () => {
    const selected = selectReviewerProfileForFreshCapacity({
      pinnedProfileId: 'codex-sol',
      policyProfiles: POLICY,
      poolOf,
      capacityByPool: new Map([['openai_chatgpt_subscription', capacity(CapacityStatus.UNKNOWN)]]),
    });
    expect(selected.profileId).toBe('codex-sol');
    expect(selected.rerouted).toBe(false);
  });

  it('EXHAUSTED do pinado escolhe o próximo autorizado cujo pool não está EXHAUSTED', () => {
    const selected = selectReviewerProfileForFreshCapacity({
      pinnedProfileId: 'codex-sol',
      policyProfiles: POLICY,
      poolOf,
      capacityByPool: new Map([
        ['openai_chatgpt_subscription', capacity(CapacityStatus.EXHAUSTED)],
        ['anthropic_subscription', capacity(CapacityStatus.EXHAUSTED)],
        ['opencode_go_subscription', capacity(CapacityStatus.KNOWN)],
      ]),
    });
    expect(selected.profileId).toBe('opencode-go-kimi');
    expect(selected.rerouted).toBe(true);
  });

  it('todos os pools autorizados EXHAUSTED devolvem nenhum reviewer', () => {
    const selected = selectReviewerProfileForFreshCapacity({
      pinnedProfileId: 'codex-sol',
      policyProfiles: POLICY,
      poolOf,
      capacityByPool: new Map([
        ['openai_chatgpt_subscription', capacity(CapacityStatus.EXHAUSTED)],
        ['anthropic_subscription', capacity(CapacityStatus.EXHAUSTED)],
        ['opencode_go_subscription', capacity(CapacityStatus.EXHAUSTED)],
      ]),
    });
    expect(selected.profileId).toBeNull();
    expect(selected.rerouted).toBe(false);
  });

  it('INFRA no pinado rerroteia mesmo quando o pool dele NÃO está EXHAUSTED', () => {
    const selected = selectReviewerProfileForFreshCapacity({
      pinnedProfileId: 'codex-sol',
      policyProfiles: POLICY,
      poolOf,
      capacityByPool: new Map([
        ['openai_chatgpt_subscription', capacity(CapacityStatus.KNOWN)],
        ['anthropic_subscription', capacity(CapacityStatus.KNOWN)],
      ]),
      excludedProfileIds: ['codex-sol'],
    });
    expect(selected.profileId).toBe('claude-opus');
    expect(selected.rerouted).toBe(true);
  });

  it('INFRA no primeiro rerroteio escolhe o próximo, sem repetir o mesmo profile', () => {
    const selected = selectReviewerProfileForFreshCapacity({
      pinnedProfileId: 'codex-sol',
      policyProfiles: POLICY,
      poolOf,
      capacityByPool: new Map([
        ['openai_chatgpt_subscription', capacity(CapacityStatus.EXHAUSTED)],
        ['anthropic_subscription', capacity(CapacityStatus.EXHAUSTED)],
        ['opencode_go_subscription', capacity(CapacityStatus.KNOWN)],
      ]),
      excludedProfileIds: ['opencode-go-kimi'],
    });
    expect(selected.profileId).toBeNull();
  });

  it('diversity=required com pin igual ao implementer rerroteia mesmo com pool KNOWN', () => {
    const selected = selectReviewerProfileForFreshCapacity({
      pinnedProfileId: 'codex-sol',
      implementerProfileId: 'codex-sol',
      diversityRequirement: 'required',
      policyProfiles: POLICY,
      poolOf,
      capacityByPool: new Map([
        ['openai_chatgpt_subscription', capacity(CapacityStatus.KNOWN)],
        ['anthropic_subscription', capacity(CapacityStatus.KNOWN)],
      ]),
    });
    expect(selected.profileId).toBe('claude-opus');
    expect(selected.rerouted).toBe(true);
  });

  it('diversity=required sem outro profile diverso não devolve o implementer', () => {
    const selected = selectReviewerProfileForFreshCapacity({
      pinnedProfileId: 'codex-sol',
      implementerProfileId: 'codex-sol',
      diversityRequirement: 'required',
      policyProfiles: [{ id: 'codex-sol', capability_rank: 2 }],
      poolOf,
      capacityByPool: new Map([['openai_chatgpt_subscription', capacity(CapacityStatus.KNOWN)]]),
    });
    expect(selected.profileId).toBeNull();
    expect(selected.rerouted).toBe(false);
  });

  it('diversity=preferred com pin igual ao implementer mantém o pin', () => {
    const selected = selectReviewerProfileForFreshCapacity({
      pinnedProfileId: 'codex-sol',
      implementerProfileId: 'codex-sol',
      diversityRequirement: 'preferred',
      policyProfiles: POLICY,
      poolOf,
      capacityByPool: new Map([
        ['openai_chatgpt_subscription', capacity(CapacityStatus.KNOWN)],
        ['anthropic_subscription', capacity(CapacityStatus.KNOWN)],
      ]),
    });
    expect(selected.profileId).toBe('codex-sol');
    expect(selected.rerouted).toBe(false);
  });

  it('dois OpenCode Go: INFRA no flash escolhe o pro, não o flash de novo', () => {
    const selected = selectReviewerProfileForFreshCapacity({
      pinnedProfileId: 'codex-sol',
      policyProfiles: [
        { id: 'codex-sol', capability_rank: 2 },
        { id: 'opencode-go-flash', capability_rank: 4 },
        { id: 'opencode-go-pro', capability_rank: 5 },
      ],
      poolOf,
      capacityByPool: new Map([
        ['openai_chatgpt_subscription', capacity(CapacityStatus.EXHAUSTED)],
        ['opencode_go_subscription', capacity(CapacityStatus.KNOWN)],
      ]),
      excludedProfileIds: ['opencode-go-flash'],
    });
    expect(selected.profileId).toBe('opencode-go-pro');
    expect(selected.rerouted).toBe(true);
  });
});
