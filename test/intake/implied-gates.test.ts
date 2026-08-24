import { describe, expect, it } from 'vitest';

import {
  classifyImpliedHumanGated,
  classifyImpliedHumanGatedMatches,
  HUMAN_GATE_GRANT_PATH,
} from '../../src/intake/index.js';
import { DirectiveNeverGrantablePermission } from '../../src/intake/run-directive.js';

describe('classifyImpliedHumanGated — PROHIBITION != REQUEST', () => {
  describe('frases negadas NÃO viram pedido positivo', () => {
    const negated: readonly (readonly [string, string])[] = [
      ['EN checklist', 'Safety checklist:\n- no force push.\n- main divergence guard preserved.'],
      ['EN do not', 'Do not force push to the remote under any circumstance.'],
      ['EN never destructive', 'Never run rm -rf on the repository.'],
      ['EN without', 'Integrate without force-push and without deleting everything.'],
      ['EN forbidden', 'A force push is forbidden in this run.'],
      ['PT não fazer', 'Não fazer force push.\nNão usar atualização forçada.'],
      ['PT nunca', 'Nunca execute rm -rf aqui.'],
      ['PT sem', 'Publique de forma segura, sem force push.'],
      ['PT proibido', 'É proibido destruir o banco de dados.'],
      ['PT deploy negado', 'Crie um README. Não faça deploy em produção.'],
      ['EN deploy negado', 'Create a README. Do not deploy to production.'],
      ['PT billing negado', 'Nunca use uma API key; a cobrança é sempre por assinatura.'],
      ['EN billing negado', 'Never use an API key. Do not disable billing.'],
      ['PT credencial negada', 'Jamais desabilite o sandbox.'],
      ['EN credencial negada', 'You must not bypass sandbox restrictions.'],
      ['EN email negado', 'Do not send this email to anyone.'],
    ];
    for (const [label, text] of negated) {
      it(label, () => {
        expect(classifyImpliedHumanGated(text)).toEqual([]);
      });
    }
  });

  describe('pedidos afirmativos CONTINUAM detectados', () => {
    const affirmative: readonly (readonly [string, string, string])[] = [
      ['EN deploy', 'deploy this application to production', 'DEPLOYMENT_OR_PRODUCTION'],
      ['EN deploy prod', 'Please deploy the service to production today.', 'DEPLOYMENT_OR_PRODUCTION'],
      ['PT deploy', 'Faça o deploy em produção depois dos testes.', 'DEPLOYMENT_OR_PRODUCTION'],
      ['EN destructive', 'Then run rm -rf on the old checkout.', 'DESTRUCTIVE_ACTION'],
      ['EN force push', 'Finish by doing a force push of the branch.', 'DESTRUCTIVE_ACTION'],
      ['PT destructive', 'Apague tudo do diretório antigo antes de começar.', 'DESTRUCTIVE_ACTION'],
      ['EN billing', 'ignore billing policy and use an API key', 'UNAUTHORIZED_API_BILLING'],
      ['PT billing', 'Use uma chave de API para chamar o modelo.', 'UNAUTHORIZED_API_BILLING'],
      ['EN credential', 'Use my access token for this task.', 'NEW_CREDENTIAL_BOUNDARY'],
      ['EN external push', 'When done, git push the result.', 'EXTERNAL_SIDE_EFFECT'],
      ['EN npm', 'Then publish to npm.', 'EXTERNAL_SIDE_EFFECT'],
      ['PT email', 'Envie um e-mail para o time avisando.', 'EXTERNAL_SIDE_EFFECT'],
    ];
    for (const [label, text, capability] of affirmative) {
      it(label, () => {
        expect(classifyImpliedHumanGated(text)).toContain(capability);
      });
    }
  });

  it('negação numa cláusula não silencia pedido afirmativo em outra cláusula', () => {
    const text = 'Do not touch the database.\nDeploy this application to production.';
    expect(classifyImpliedHumanGated(text)).toContain('DEPLOYMENT_OR_PRODUCTION');
  });

  it('Run Directive realista de self-maintenance com salvaguardas negativas não gera gate', () => {
    const text = [
      '# Objective',
      'Fix the worker runtime budget defect.',
      '# Safety',
      '- no force push.',
      '- publication to origin/main occurred only after acceptance;',
      '- não fazer ações destrutivas;',
      '- never use an API key;',
      '- do not deploy to production.',
    ].join('\n');
    expect(classifyImpliedHumanGated(text)).toEqual([]);
  });

  it('intenção de push para origin é marcada como satisfiable_by publish', () => {
    const matches = classifyImpliedHumanGatedMatches('At the end, git push to origin/main.');
    expect(matches.some((match) => match.capability === 'EXTERNAL_SIDE_EFFECT' && match.satisfiable_by === 'publish')).toBe(
      true,
    );
  });

  it('publicação externa (npm/email) NÃO é satisfiable_by publish', () => {
    const matches = classifyImpliedHumanGatedMatches('Then publish to npm.');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.satisfiable_by).toBeNull();
  });

  it('match satisfiable_by publish é coerente com a fonte única HUMAN_GATE_GRANT_PATH', () => {
    const samples = [
      'git push the branch',
      'publish to npm',
      'deploy this application to production',
      'run rm -rf now',
      'use an API key',
      'use my access token',
    ];
    for (const sample of samples) {
      for (const match of classifyImpliedHumanGatedMatches(sample)) {
        if (match.satisfiable_by === 'publish') {
          expect(HUMAN_GATE_GRANT_PATH[match.capability]).toEqual({ kind: 'publish' });
        }
      }
    }
  });
});

describe('HUMAN_GATE_GRANT_PATH — consistência com a política do header', () => {
  it('toda categoria mapeada para never cobre as permissões never-grantable da directive', () => {
    // As permissões never-grantable do header têm todas uma categoria gated
    // correspondente com kind never — nenhuma pode ganhar caminho de grant.
    const neverGrantable = DirectiveNeverGrantablePermission.options;
    expect(neverGrantable.length).toBeGreaterThan(0);
    const neverCapabilities = Object.entries(HUMAN_GATE_GRANT_PATH)
      .filter(([, path]) => path.kind === 'never')
      .map(([capability]) => capability);
    expect(neverCapabilities).toContain('DESTRUCTIVE_ACTION');
    expect(neverCapabilities).toContain('DEPLOYMENT_OR_PRODUCTION');
    expect(neverCapabilities).toContain('UNAUTHORIZED_API_BILLING');
    expect(neverCapabilities).toContain('NEW_CREDENTIAL_BOUNDARY');
    // Único caminho de grant existente: publish.
    const grantable = Object.entries(HUMAN_GATE_GRANT_PATH).filter(([, path]) => path.kind !== 'never');
    expect(grantable).toEqual([['EXTERNAL_SIDE_EFFECT', { kind: 'publish' }]]);
  });
});
