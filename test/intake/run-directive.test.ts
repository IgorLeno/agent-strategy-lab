import { describe, expect, it } from 'vitest';

import {
  parseRunDirective,
  RunDirectiveError,
  normalizeDirectiveText,
  runDirectiveHash,
} from '../../src/intake/index.js';
import { MAX_RUN_DIRECTIVE_BYTES } from '../../src/intake/run-directive.js';

const SAMPLE = `---agentlab
version: 1
target:
  type: repository
  path: /tmp/project
execution:
  mode: new
authorization:
  preset: local-autonomous-development
  allow:
    local_repository_write: true
    bounded_repair: true
  deny:
    deployment: true
    api_billing: true
---
# Objective

Implement the README note.

Keep the original wording.
`;

describe('parseRunDirective', () => {
  it('separa header estruturado do corpo Markdown', () => {
    const parsed = parseRunDirective(SAMPLE);
    expect(parsed.header?.version).toBe(1);
    expect(parsed.header?.target).toEqual({ type: 'repository', path: '/tmp/project' });
    expect(parsed.header?.authorization?.preset).toBe('local-autonomous-development');
    expect(parsed.header?.authorization?.allow?.local_repository_write).toBe(true);
    expect(parsed.body).toBe('# Objective\n\nImplement the README note.\n\nKeep the original wording.\n');
    expect(parsed.raw).toBe(SAMPLE);
    expect(parsed.hash).toBe(runDirectiveHash(SAMPLE));
  });

  it('preserva o corpo byte-a-byte após normalizar newlines', () => {
    const windows = SAMPLE.replace(/\n/g, '\r\n');
    const parsed = parseRunDirective(windows);
    expect(parsed.raw).toBe(normalizeDirectiveText(windows));
    expect(parsed.body).toContain('Keep the original wording.');
    expect(parsed.body).not.toContain('\r');
  });

  it('ausência do marcador ---agentlab é o formato legado', () => {
    const parsed = parseRunDirective('Create a small README note.\n');
    expect(parsed.header).toBeNull();
    expect(parsed.body).toBe('Create a small README note.\n');
  });

  it('recusa header sem fechamento', () => {
    expect(() => parseRunDirective('---agentlab\nversion: 1\n# body\n')).toThrow(RunDirectiveError);
    expect(() => parseRunDirective('---agentlab\nversion: 1\n# body\n')).toThrow(/fechamento/);
  });

  it('recusa YAML inválido sem tentar reparar', () => {
    expect(() =>
      parseRunDirective('---agentlab\nversion: 1\ntarget: [\n---\n# body\n'),
    ).toThrow(/YAML do header inválido/);
  });

  it('recusa campo desconhecido no header', () => {
    expect(() =>
      parseRunDirective('---agentlab\nversion: 1\nsecret_backdoor: true\n---\n# body\n'),
    ).toThrow(RunDirectiveError);
  });

  it('recusa permissão desconhecida em allow', () => {
    expect(() =>
      parseRunDirective(
        '---agentlab\nversion: 1\nauthorization:\n  allow:\n    internet_root: true\n---\n# body\n',
      ),
    ).toThrow(RunDirectiveError);
  });

  it('recusa corpo vazio', () => {
    expect(() => parseRunDirective('---agentlab\nversion: 1\n---\n   \n')).toThrow(/corpo/);
  });

  it('recusa documento vazio', () => {
    expect(() => parseRunDirective('   \n')).toThrow(/vazia/);
  });

  it('guard de produto: directive acima de MAX_RUN_DIRECTIVE_BYTES falha explícito, sem truncation', () => {
    const body = `# Objective\n\n${'x'.repeat(MAX_RUN_DIRECTIVE_BYTES)}\n`;
    expect(() => parseRunDirective(body)).toThrow(/excede o limite de produto/);
    expect(() => parseRunDirective(body)).toThrow(/Nada foi truncado/);
  });

  it('directive grande DENTRO do guard continua aceita com corpo íntegro', () => {
    const body = `# Objective\n\n${'y'.repeat(30_000)}`;
    const parsed = parseRunDirective(`---agentlab\nversion: 1\ntarget:\n  type: self\n---\n${body}\n`);
    expect(parsed.body.trim()).toBe(body);
  });
});

describe('planning.deliberation no header', () => {
  it('declara max_turns e diversity, e o corpo continua intocado', () => {
    const parsed = parseRunDirective(
      [
        '---agentlab',
        'version: 1',
        'planning:',
        '  deliberation:',
        '    max_turns: 3',
        '    diversity: cross_provider_preferred',
        'providers:',
        '  policy: evidence_balanced',
        '---',
        '# Objetivo',
        '',
        'Implementar o filtro.',
        '',
      ].join('\n'),
    );
    expect(parsed.header?.planning?.deliberation?.max_turns).toBe(3);
    expect(parsed.header?.planning?.deliberation?.diversity).toBe('cross_provider_preferred');
    expect(parsed.header?.providers?.policy).toBe('evidence_balanced');
    expect(parsed.body).toContain('Implementar o filtro.');
  });

  it('directives antigas continuam válidas e sem deliberação', () => {
    const legacy = parseRunDirective('# Objetivo\n\nImplementar o filtro.\n');
    expect(legacy.header).toBeNull();

    const headerWithoutPlanning = parseRunDirective(
      ['---agentlab', 'version: 1', 'execution:', '  autonomy: routine', '---', '# Objetivo', ''].join('\n'),
    );
    expect(headerWithoutPlanning.header?.planning).toBeUndefined();
    expect(headerWithoutPlanning.header?.providers).toBeUndefined();
  });

  it('max_turns fora do contrato falha antes de qualquer provider', () => {
    for (const value of ['-1', '99', '"tres"']) {
      expect(() =>
        parseRunDirective(
          ['---agentlab', 'version: 1', 'planning:', '  deliberation:', `    max_turns: ${value}`, '---', '# Objetivo', ''].join('\n'),
        ),
      ).toThrow(RunDirectiveError);
    }
  });
});
