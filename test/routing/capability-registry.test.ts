import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { diagnose, type DoctorReport } from '../../dev/lib/doctor.js';
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
  });

  it('session isolation é sempre fresh_process, resume_forbidden e com mecanismo explícito', async () => {
    const ids = await realProfileIds();
    for (const id of ids) {
      const capability = await capabilityFor(id);
      expect(capability.session_isolation.fresh_process).toBe(true);
      expect(capability.session_isolation.resume_forbidden).toBe(true);
      expect(capability.session_isolation.mechanism.length).toBeGreaterThan(0);
    }
  });

  it('valor não determinável de mutation_capability sempre vem com motivo (nunca chute)', async () => {
    const ids = await realProfileIds();
    for (const id of ids) {
      const capability = await capabilityFor(id);
      if (capability.mutation_capability.value === null) {
        expect(capability.mutation_capability.provenance.length).toBeGreaterThan(0);
      }
    }
  });

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
  });
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
  });

  it('get devolve undefined para profile_id desconhecido', () => {
    const registry = new CapabilityRegistry();
    expect(registry.get('nao-existe')).toBeUndefined();
  });

  it('expõe facts de diversidade (provider/model/effort/environment) sem decidir nada', async () => {
    const capability = await capabilityFor('claude-build-worker-subscription-v1');
    const registry = new CapabilityRegistry([capability]);
    expect(registry.diversityFacts(capability.profile_id)).toEqual({
      provider: capability.agent,
      model: capability.model,
      reasoning_effort: capability.reasoning_effort,
      environment_mode: capability.environment_mode,
    });
    expect(registry.diversityFacts('nao-existe')).toBeUndefined();
  });
});
