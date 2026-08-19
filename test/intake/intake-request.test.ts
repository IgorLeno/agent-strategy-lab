import { describe, expect, it } from 'vitest';

import {
  authorizeExecutionAction,
  BaseRevision,
  ExecutionAuthorizationScope,
  projectIntakeSha256,
  ProjectIntakeRequest,
} from '../../src/intake/index.js';

const VALID_SHA = 'a'.repeat(40);

function validIntake(): ProjectIntakeRequest {
  return {
    schema_version: 1,
    target_repo: { url: 'https://example.com/org/repo.git' },
    base_revision: { sha: VALID_SHA },
    user_request: 'Adicionar validação de e-mail no formulário de cadastro.',
    objectives: ['Rejeitar e-mails inválidos no submit'],
    constraints: [],
    exclusions: [],
    requested_scope: { summary: 'Implementar validação de e-mail no formulário de cadastro.' },
  };
}

function validScope(
  overrides: Partial<ExecutionAuthorizationScope> = {},
): ExecutionAuthorizationScope {
  return {
    schema_version: 1,
    requested_scope: { summary: 'Implementar validação de e-mail no formulário de cadastro.' },
    autonomous_execution_boundary: [
      'DISPOSABLE_LOCAL_WORKSPACE',
      'CONFIGURED_SUBSCRIPTION_WORKER',
      'DETERMINISTIC_VALIDATION',
      'BOUNDED_REPAIR',
      'CAPABILITY_ESCALATION_WITHIN_LADDER',
      'CROSS_PROVIDER_WITHIN_ALLOWED_SUBSCRIPTION_PROFILES',
    ],
    human_gated_capabilities: [
      'UNAUTHORIZED_API_BILLING',
      'BILLING_MODE_CHANGE',
      'DESTRUCTIVE_ACTION',
      'DEPLOYMENT_OR_PRODUCTION',
      'EXTERNAL_SIDE_EFFECT',
      'SCOPE_EXPANSION',
      'NEW_CREDENTIAL_BOUNDARY',
      'UNRESOLVED_ARCHITECTURE_OR_PRODUCT_DECISION',
      'CRITICAL_OR_SECURITY_SENSITIVE_ACTION',
      'PROFILE_OR_PROVIDER_OUTSIDE_POLICY',
      'INSUFFICIENT_EVIDENCE',
      'SAFE_ESCALATION_EXHAUSTED',
    ],
    ...overrides,
  };
}

describe('ProjectIntakeRequest', () => {
  it('aceita um intake válido com todos os campos mínimos', () => {
    expect(ProjectIntakeRequest.parse(validIntake())).toEqual(validIntake());
  });

  it('exige schema_version, user_request, objectives, constraints, exclusions e requested_scope', () => {
    const { requested_scope, ...rest } = validIntake();
    expect(() => ProjectIntakeRequest.parse(rest)).toThrow();
  });

  it('exige base_revision.sha como SHA-1 de 40 hex', () => {
    const invalid = { ...validIntake(), base_revision: { sha: 'deadbeef' } };
    expect(() => ProjectIntakeRequest.parse(invalid)).toThrow();

    expect(() => BaseRevision.parse({ sha: VALID_SHA })).not.toThrow();
    expect(() => BaseRevision.parse({ sha: VALID_SHA.toUpperCase() })).toThrow();
  });

  it('rejeita objectives vazio', () => {
    const invalid = { ...validIntake(), objectives: [] };
    expect(() => ProjectIntakeRequest.parse(invalid)).toThrow();
  });

  it('permite constraints e exclusions vazios, mas exige os campos presentes', () => {
    expect(ProjectIntakeRequest.parse(validIntake()).constraints).toEqual([]);
    expect(ProjectIntakeRequest.parse(validIntake()).exclusions).toEqual([]);
  });

  it('é strict e rejeita campos desconhecidos', () => {
    const withExtra = { ...validIntake(), billing_authorized: true };
    expect(() => ProjectIntakeRequest.parse(withExtra)).toThrow();
  });

  it('produz o mesmo hash canônico independente da ordem das chaves', () => {
    const intake = validIntake();
    const reordered = {
      requested_scope: intake.requested_scope,
      exclusions: intake.exclusions,
      constraints: intake.constraints,
      objectives: intake.objectives,
      user_request: intake.user_request,
      base_revision: intake.base_revision,
      target_repo: intake.target_repo,
      schema_version: intake.schema_version,
    };

    expect(projectIntakeSha256(reordered as ProjectIntakeRequest)).toBe(
      projectIntakeSha256(intake),
    );
  });

  it('muda o hash quando o conteúdo do intake muda', () => {
    const intake = validIntake();
    const changed = { ...intake, user_request: 'Outro pedido completamente diferente.' };
    expect(projectIntakeSha256(changed)).not.toBe(projectIntakeSha256(intake));
  });
});

describe('ExecutionAuthorizationScope', () => {
  it('aceita um escopo válido com as três partes distintas', () => {
    expect(ExecutionAuthorizationScope.parse(validScope())).toEqual(validScope());
  });

  it('é strict e rejeita campos desconhecidos', () => {
    const withExtra = { ...validScope(), auto_approve_everything: true };
    expect(() => ExecutionAuthorizationScope.parse(withExtra)).toThrow();
  });

  it('rejeita capabilities autônomas que não pertencem ao enum autônomo', () => {
    const invalid = {
      ...validScope(),
      autonomous_execution_boundary: ['DESTRUCTIVE_ACTION'],
    };
    expect(() => ExecutionAuthorizationScope.parse(invalid)).toThrow();
  });

  it('rejeita human_gated_capabilities que não pertencem ao enum human-gated', () => {
    const invalid = {
      ...validScope(),
      human_gated_capabilities: ['DISPOSABLE_LOCAL_WORKSPACE'],
    };
    expect(() => ExecutionAuthorizationScope.parse(invalid)).toThrow();
  });

  it('permite ação autônoma dentro do boundary sem novo gate', () => {
    const scope = validScope();
    expect(
      authorizeExecutionAction(scope, {
        kind: 'autonomous',
        capability: 'DISPOSABLE_LOCAL_WORKSPACE',
      }),
    ).toBe('ALLOWED');
  });

  it('exige gate humano para ação autônoma fora do boundary declarado', () => {
    const scope = validScope({
      autonomous_execution_boundary: ['DETERMINISTIC_VALIDATION'],
    });
    expect(
      authorizeExecutionAction(scope, {
        kind: 'autonomous',
        capability: 'DISPOSABLE_LOCAL_WORKSPACE',
      }),
    ).toBe('HUMAN_REQUIRED');
  });

  it('requested_scope sozinho nunca autoriza billing, credenciais, ação destrutiva, efeito externo, deploy, scope expansion ou mudança security-sensitive', () => {
    const scope = validScope({
      requested_scope: {
        summary:
          'Implementar tudo o que for necessário, incluindo qualquer credencial, deploy ou billing.',
      },
    });

    const alwaysGated: ReadonlyArray<
      Extract<Parameters<typeof authorizeExecutionAction>[1], { kind: 'human_gated' }>['capability']
    > = [
      'UNAUTHORIZED_API_BILLING',
      'BILLING_MODE_CHANGE',
      'DESTRUCTIVE_ACTION',
      'DEPLOYMENT_OR_PRODUCTION',
      'EXTERNAL_SIDE_EFFECT',
      'SCOPE_EXPANSION',
      'NEW_CREDENTIAL_BOUNDARY',
      'CRITICAL_OR_SECURITY_SENSITIVE_ACTION',
    ];

    for (const capability of alwaysGated) {
      expect(authorizeExecutionAction(scope, { kind: 'human_gated', capability })).toBe(
        'HUMAN_REQUIRED',
      );
    }
  });
});
