import { describe, expect, it } from 'vitest';

import {
  createHumanRequired,
  createTechnicalBlocked,
  isHumanRequired,
  readHumanAuthority,
} from '../../dev/lib/control-plane-halt.js';
import { authorizeProjectLaunch } from '../../dev/lib/project-orchestrate.js';
import type { ExecutionAuthorizationScope } from '../../src/intake/index.js';

const SCOPE: ExecutionAuthorizationScope = {
  schema_version: 1,
  requested_scope: { summary: 'implementar a task' },
  autonomous_execution_boundary: [
    'DISPOSABLE_LOCAL_WORKSPACE',
    'CONFIGURED_SUBSCRIPTION_WORKER',
    'DETERMINISTIC_VALIDATION',
    'BOUNDED_REPAIR',
  ],
  human_gated_capabilities: ['UNAUTHORIZED_API_BILLING', 'SCOPE_EXPANSION'],
};

const launchContext = (overrides: Record<string, unknown> = {}) =>
  ({
    scope: SCOPE,
    capability: 'CONFIGURED_SUBSCRIPTION_WORKER',
    billing_mode: 'subscription_only',
    quota: { availability: true, provenance: 'observação fresca do pool' },
    credential: { availability: true, provenance: 'probe local' },
    risk: 'medium',
    worker_owns_commit: false,
    worker_owns_official_validation: false,
    ...overrides,
  }) as Parameters<typeof authorizeProjectLaunch>[0];

describe('construtor central de HUMAN_REQUIRED', () => {
  it('exige uma autoridade do enum fechado e a preserva verbatim', () => {
    const halt = createHumanRequired({
      human_authority: 'SCOPE_EXPANSION',
      incident_id: 'INC-1',
      decision_needed: 'ampliar o boundary autorizado',
      why_automation_stopped: 'capability fora do boundary',
      options: ['ampliar explicitamente'],
      evidence_paths: ['dev/authorization.json'],
    });
    expect(isHumanRequired(halt)).toBe(true);
    expect(halt.human_authority).toBe('SCOPE_EXPANSION');
  });

  it('recusa em runtime uma autoridade que não existe no enum', () => {
    // O tipo já impede isto em produção; o parse fecha o caminho para chamadas
    // dinâmicas e para dados vindos de fora do processo.
    expect(() =>
      createHumanRequired({
        human_authority: 'INSUFFICIENT_EVIDENCE' as never,
        incident_id: 'INC-2',
        decision_needed: 'x',
        why_automation_stopped: 'y',
        options: [],
        evidence_paths: [],
      }),
    ).toThrow();
    expect(() =>
      createHumanRequired({
        human_authority: 'OTHER' as never,
        incident_id: 'INC-3',
        decision_needed: 'x',
        why_automation_stopped: 'y',
        options: [],
        evidence_paths: [],
      }),
    ).toThrow();
  });

  it('o blocker técnico é uma parada distinta, nunca um gate humano', () => {
    const halt = createTechnicalBlocked({
      blocker: 'PROVIDER_OR_INFRA_FAILURE',
      incident_id: 'INC-4',
      decision_needed: 'corrigir o provider',
      why_automation_stopped: 'turn.failed',
      options: [],
      evidence_paths: [],
    });
    expect(halt.status).toBe('BLOCKED');
    expect(isHumanRequired(halt)).toBe(false);
    expect(halt).not.toHaveProperty('human_authority');
  });
});

describe('proveniência legada é lida sem inventar autoridade', () => {
  it('record histórico sem human_authority devolve null, não um palpite', () => {
    expect(readHumanAuthority({ status: 'HUMAN_REQUIRED' } as never)).toBeNull();
    expect(readHumanAuthority(null)).toBeNull();
    expect(readHumanAuthority(undefined)).toBeNull();
  });

  it('valor legado fora do enum também é ausência, nunca promoção', () => {
    expect(readHumanAuthority({ human_authority: 'INSUFFICIENT_EVIDENCE' })).toBeNull();
    expect(readHumanAuthority({ human_authority: 'CATEGORIA_QUE_NUNCA_EXISTIU' })).toBeNull();
  });

  it('autoridade declarada é devolvida verbatim', () => {
    expect(readHumanAuthority({ human_authority: 'DESTRUCTIVE_ACTION' })).toBe(
      'DESTRUCTIVE_ACTION',
    );
  });
});

describe('autorização de launch separa fronteira humana de bloqueio técnico', () => {
  it('quota do pool esgotada é BLOQUEIO TÉCNICO: a janela reseta, ninguém autoriza', () => {
    const decision = authorizeProjectLaunch(
      launchContext({
        quota: { availability: false, provenance: 'provider declarou limit_reached' },
      }),
    );
    expect(decision.outcome).toBe('BLOCKED');
    if (decision.outcome !== 'BLOCKED') throw new Error('esperava BLOCKED');
    expect(decision.blocker).toBe('NO_ELIGIBLE_EXECUTOR');
    // Fail-closed preservado: o launch NÃO é permitido.
    expect(decision.outcome).not.toBe('ALLOW');
  });

  it('capability fora do boundary é HUMAN_REQUIRED com SCOPE_EXPANSION nomeado', () => {
    const decision = authorizeProjectLaunch(
      launchContext({ capability: 'CAPABILITY_ESCALATION_WITHIN_LADDER' }),
    );
    expect(decision.outcome).toBe('HUMAN_REQUIRED');
    if (decision.outcome !== 'HUMAN_REQUIRED') throw new Error('esperava HUMAN_REQUIRED');
    expect(decision.gated_capability).toBe('SCOPE_EXPANSION');
  });

  it('cobrança por API é HUMAN_REQUIRED com a autoridade de billing nomeada', () => {
    const decision = authorizeProjectLaunch(launchContext({ billing_mode: 'api' }));
    expect(decision.outcome).toBe('HUMAN_REQUIRED');
    if (decision.outcome !== 'HUMAN_REQUIRED') throw new Error('esperava HUMAN_REQUIRED');
    expect(decision.gated_capability).toBe('UNAUTHORIZED_API_BILLING');
  });

  it('credencial não provada é HUMAN_REQUIRED com NEW_CREDENTIAL_BOUNDARY', () => {
    const decision = authorizeProjectLaunch(
      launchContext({ credential: { availability: null, provenance: 'probe falhou' } }),
    );
    expect(decision.outcome).toBe('HUMAN_REQUIRED');
    if (decision.outcome !== 'HUMAN_REQUIRED') throw new Error('esperava HUMAN_REQUIRED');
    expect(decision.gated_capability).toBe('NEW_CREDENTIAL_BOUNDARY');
  });

  it('quota DESCONHECIDA continua não bloqueando: falha de instrumento não decide', () => {
    const decision = authorizeProjectLaunch(
      launchContext({ quota: { availability: null, provenance: 'sem medidor de assinatura' } }),
    );
    expect(decision.outcome).toBe('ALLOW');
  });

  it('launch dentro do boundary continua sendo autorizado sem gate por spawn', () => {
    expect(authorizeProjectLaunch(launchContext()).outcome).toBe('ALLOW');
  });
});
