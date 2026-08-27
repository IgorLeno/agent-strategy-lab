import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { diagnose, type DoctorReport } from '../../dev/lib/doctor.js';
import { providerIdentityOf } from '../../src/providers/index.js';
import { REPO_ROOT } from '../dev/helpers.js';
import {
  CapabilityRegistry,
  DuplicateCapabilityError,
  ProfileCapability,
  capabilityOf,
  type ProfileCapabilityInput,
} from '../../src/routing/index.js';

/**
 * A entrada de `capabilityOf` é sempre um `DoctorReport` real — nunca argv
 * cru nem `notes`. `diagnose` já é o único lugar que deriva model/effort a
 * partir do argv versionado; este helper só recorta os campos que
 * `ProfileCapabilityInput` declara.
 */
function inputFrom(report: DoctorReport): ProfileCapabilityInput {
  return {
    profile_id: report.profile_id,
    agent: report.agent as ProfileCapabilityInput['agent'],
    // O doctor é quem deriva a identidade upstream; o registry a consome em
    // vez de rederivar e divergir.
    provider_identity: report.provider_identity,
    capability_prior: report.capability_prior,
    model: report.model,
    reasoning_effort: report.reasoning_effort,
    reasoning_effort_source: report.reasoning_effort_source,
    billing_mode: report.billing_mode,
    credential_source: report.credential_source,
    environment_mode: report.environment_mode,
    instruction_environment: report.instruction_environment,
    commit_owner: report.commit_owner,
    official_validation_owner: report.official_validation_owner,
    worker_validation_policy: report.worker_validation_policy,
    sandbox: report.sandbox,
    session_persistence: report.session_persistence,
  };
}

/** Nunca faz um turno de modelo pago: prova a fonte da credencial localmente. */
const fakeCredentialRunner = async (
  command: string,
): Promise<{ code: number | null; output: string }> => {
  if (command.endsWith('claude')) {
    return {
      code: 0,
      output: JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        subscriptionType: 'pro',
      }),
    };
  }
  return { code: 0, output: 'Logged in using ChatGPT' };
};

async function realProfileIds(): Promise<string[]> {
  const entries = await readdir(path.join(REPO_ROOT, 'dev', 'profiles'));
  return entries.filter((entry) => entry.endsWith('.yaml')).map((entry) => entry.slice(0, -'.yaml'.length));
}

async function capabilityFor(profileId: string): Promise<ProfileCapability> {
  const report = await diagnose({
    repoRoot: REPO_ROOT,
    profileId,
    credentialRunner: fakeCredentialRunner,
  });
  return capabilityOf(inputFrom(report));
}

/**
 * Estes testes rodam `diagnose()` de verdade contra CADA profile versionado, e
 * `diagnose` inicia processos (`command -v`, `--help`, `opencode models`).
 * Com o catálogo OpenCode o número de profiles mais que dobrou, e o default de
 * 30s do vitest passou a cortar a varredura no meio. O teto maior é do TESTE,
 * não do produto: nada aqui é deadline de execução.
 */
const REAL_PROFILE_SCAN_TIMEOUT_MS = 180_000;

describe('capabilityOf — deriva de todos os profiles reais de dev/profiles', () => {
  it('produz um ProfileCapability válido para cada profile versionado', async () => {
    const ids = await realProfileIds();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const capability = await capabilityFor(id);
      expect(ProfileCapability.parse(capability)).toEqual(capability);
      expect(capability.profile_id).toBe(id);
      expect(capability.schema_version).toBe(1);
    }
  }, REAL_PROFILE_SCAN_TIMEOUT_MS);

  it('session isolation é sempre fresh_process, resume_forbidden e com mecanismo explícito', async () => {
    const ids = await realProfileIds();
    for (const id of ids) {
      const capability = await capabilityFor(id);
      expect(capability.session_isolation.fresh_process).toBe(true);
      expect(capability.session_isolation.resume_forbidden).toBe(true);
      expect(capability.session_isolation.mechanism.length).toBeGreaterThan(0);
    }
  }, REAL_PROFILE_SCAN_TIMEOUT_MS);

  it('valor não determinável de mutation_capability sempre vem com motivo (nunca chute)', async () => {
    const ids = await realProfileIds();
    for (const id of ids) {
      const capability = await capabilityFor(id);
      if (capability.mutation_capability.value === null) {
        expect(capability.mutation_capability.provenance.length).toBeGreaterThan(0);
      }
    }
  }, REAL_PROFILE_SCAN_TIMEOUT_MS);

  it('codex build-worker com sandbox workspace-write pode mutar e é reviewer-compatível via overlay read-only', async () => {
    const capability = await capabilityFor('codex-build-worker-subscription-high-v1');
    expect(capability.mutation_capability).toEqual({
      value: true,
      provenance: 'sandbox=workspace-write',
    });
    expect(capability.read_only_operability.value).toBe(true);
    expect(capability.read_only_mechanism).toContain('buildRoutineAgentArgv');
    expect(capability.role_compatibility.implementer.value).toBe(true);
    expect(capability.role_compatibility.reviewer.value).toBe(true);
  });

  it('perfil Claude fica com read_only_operability indisponível até M84', async () => {
    const capability = await capabilityFor('claude-build-worker-subscription-v1');
    expect(capability.agent).toBe('claude');
    expect(capability.read_only_operability.value).toBe(false);
    expect(capability.read_only_operability.provenance).toMatch(/M84/);
    expect(capability.read_only_mechanism).toBeNull();
  });

  it('worker falso não modela mutação nem participa do overlay read-only', async () => {
    const capability = await capabilityFor('fake-worker-v1');
    expect(capability.agent).toBe('fake');
    expect(capability.mutation_capability.value).toBeNull();
    expect(capability.read_only_operability.value).toBeNull();
    expect(capability.role_compatibility.planner.value).toBeNull();
  });

  it('role_compatibility representa planner, implementer e reviewer para todo profile', async () => {
    const ids = await realProfileIds();
    for (const id of ids) {
      const capability = await capabilityFor(id);
      expect(capability.role_compatibility).toHaveProperty('planner');
      expect(capability.role_compatibility).toHaveProperty('implementer');
      expect(capability.role_compatibility).toHaveProperty('reviewer');
    }
  }, REAL_PROFILE_SCAN_TIMEOUT_MS);
});

describe('CapabilityRegistry', () => {
  it('indexa todos os profiles reais e rejeita profile_id duplicado', async () => {
    const ids = await realProfileIds();
    const registry = new CapabilityRegistry();
    for (const id of ids) {
      registry.add(await capabilityFor(id));
    }
    expect(registry.list()).toHaveLength(ids.length);

    const duplicate = await capabilityFor(ids[0] as string);
    expect(() => registry.add(duplicate)).toThrow(DuplicateCapabilityError);
  }, REAL_PROFILE_SCAN_TIMEOUT_MS);

  it('get devolve undefined para profile_id desconhecido', () => {
    const registry = new CapabilityRegistry();
    expect(registry.get('nao-existe')).toBeUndefined();
  });

  it('expõe facts de diversidade pelo UPSTREAM, não pelo executável', async () => {
    const capability = await capabilityFor('claude-build-worker-subscription-v1');
    const registry = new CapabilityRegistry([capability]);
    expect(registry.diversityFacts(capability.profile_id)).toEqual({
      // Executável e upstream continuam ambos disponíveis, e SEPARADOS: o
      // primeiro é fato do experimento, o segundo é a dimensão em que
      // "diversidade de provider" significa alguma coisa.
      provider: 'anthropic',
      quota_pool: 'anthropic_subscription',
      execution_scaffold: capability.agent,
      model: capability.model,
      reasoning_effort: capability.reasoning_effort,
      environment_mode: capability.environment_mode,
      provenance: expect.stringContaining('ProviderIdentity'),
    });
    expect(registry.diversityFacts('nao-existe')).toBeUndefined();
  });

  it('registra o Sol High explícito e o legacy high-v2 como IDs distintos com as mesmas facts', async () => {
    const legacy = await capabilityFor('codex-build-worker-subscription-high-v2');
    const explicit = await capabilityFor('codex-build-worker-subscription-sol-high-v2');
    const registry = new CapabilityRegistry([legacy, explicit]);

    expect(legacy.profile_id).toBe('codex-build-worker-subscription-high-v2');
    expect(explicit.profile_id).toBe('codex-build-worker-subscription-sol-high-v2');
    expect(legacy.profile_id).not.toBe(explicit.profile_id);
    expect(registry.get(explicit.profile_id)).toEqual(explicit);
    for (const capability of [legacy, explicit]) {
      expect(capability.agent).toBe('codex');
      expect(capability.model).toBe('gpt-5.6-sol');
      expect(capability.reasoning_effort).toBe('high');
      expect(capability.reasoning_effort_source).toBe('codex_config_override');
    }
    expect(registry.diversityFacts(explicit.profile_id)).toEqual({
      provider: 'openai',
      quota_pool: 'openai_chatgpt_subscription',
      execution_scaffold: 'codex',
      model: 'gpt-5.6-sol',
      reasoning_effort: 'high',
      environment_mode: 'real-world',
      provenance: expect.stringContaining('ProviderIdentity'),
    });
  });

  it('capabilityOf e diversityFacts não derivam model/effort do texto do profile_id', () => {
    const capability = capabilityOf(
      inputFrom({
        profile_id: 'codex-build-worker-subscription-luna-medium-v2',
        agent: 'codex',
        model: 'gpt-5.6-sol',
        provider_identity: providerIdentityOf({
          execution_scaffold: 'codex_cli',
          provider: 'openai',
          model: 'gpt-5.6-sol',
          provenance: 'fixture',
        }),
        provider_identity_reason: null,
        capability_prior: null,
        output_format: 'json',
        reasoning_effort: 'high',
        reasoning_effort_source: 'codex_config_override',
        billing_mode: 'subscription_only',
        credential_source: 'chatgpt_subscription',
        environment_mode: 'real-world',
        instruction_environment: 'sanitized_user_home',
        commit_owner: 'orchestrator',
        official_validation_owner: 'orchestrator',
        worker_validation_policy: 'targeted',
        sandbox: 'workspace-write',
        session_persistence: 'ephemeral',
        user_config_ignored: true,
        execpolicy_rules_ignored: true,
        ok: true,
        checks: [],
      }),
    );
    const registry = new CapabilityRegistry([capability]);

    expect(capability.profile_id).toMatch(/luna-medium/);
    expect(capability.model).toBe('gpt-5.6-sol');
    expect(capability.reasoning_effort).toBe('high');
    // DIVERSIDADE É DE UPSTREAM: o profile roda pelo scaffold `codex`, mas o
    // provider que responde é `openai`, e a franquia consumida é a assinatura
    // ChatGPT — a mesma que um profile OpenCode/openai consumiria.
    expect(registry.diversityFacts(capability.profile_id)).toEqual({
      provider: 'openai',
      quota_pool: 'openai_chatgpt_subscription',
      execution_scaffold: 'codex',
      model: 'gpt-5.6-sol',
      reasoning_effort: 'high',
      environment_mode: 'real-world',
      provenance: expect.stringContaining('ProviderIdentity'),
    });
  });
});
