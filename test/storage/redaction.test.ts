import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  appendJsonLine,
  containsSecret,
  isSensitiveKeyName,
  redactString,
  redactionPlaceholder,
} from '../../src/storage/index.js';

/** Secrets falsos, com formato válido e valor sem significado. */
const FAKE_SECRETS = {
  anthropic: 'sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0123456789AA',
  anthropicOther: 'sk-ant-api03-0000FAKE1111FAKE2222FAKE3333FAKE4444FAKE55',
  openai: 'sk-proj-FAKE0123456789abcdefFAKE0123456789abcdef',
  github: 'ghp_FAKE0123456789abcdefFAKE0123456789',
  githubPat: 'github_pat_FAKE0123456789abcdefFAKE0123456789',
  google: 'AIzaFAKE0123456789abcdef-_0123456789',
  slack: 'xoxb-000000000000-000000000000-FAKE0123456789abcdefFAKE',
  aws: 'AKIAFAKE0123456789AB',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlLXN1YmplY3QifQ.FAKE0123456789signature',
} as const;

const PRIVATE_KEY_BLOCK = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz',
  'FAKE0123456789abcdefFAKE0123456789abcdefFAKE0123456789abcdefFAKE',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n');

const temporaryRoots: string[] = [];

async function temporaryFile(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-redaction-'));
  temporaryRoots.push(root);
  return path.join(root, 'events.jsonl');
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe('redaction de tokens de formato conhecido', () => {
  const cases: readonly (readonly [string, string, string])[] = [
    ['chave da Anthropic', FAKE_SECRETS.anthropic, redactionPlaceholder('anthropic-api-key')],
    ['chave da OpenAI', FAKE_SECRETS.openai, redactionPlaceholder('openai-api-key')],
    ['token do GitHub', FAKE_SECRETS.github, redactionPlaceholder('github-token')],
    ['PAT do GitHub', FAKE_SECRETS.githubPat, redactionPlaceholder('github-token')],
    ['chave do Google', FAKE_SECRETS.google, redactionPlaceholder('google-api-key')],
    ['token do Slack', FAKE_SECRETS.slack, redactionPlaceholder('slack-token')],
    ['access key id da AWS', FAKE_SECRETS.aws, redactionPlaceholder('aws-access-key-id')],
    ['JWT', FAKE_SECRETS.jwt, redactionPlaceholder('jwt')],
    ['bloco de chave privada', PRIVATE_KEY_BLOCK, redactionPlaceholder('private-key')],
  ];

  for (const [description, secret, placeholder] of cases) {
    it(`substitui ${description} pelo placeholder do formato`, () => {
      const redacted = redactString(`valor: ${secret} fim`);

      expect(redacted).toBe(`valor: ${placeholder} fim`);
      expect(redacted).not.toContain(secret);
    });
  }

  it('usa o mesmo placeholder para secrets diferentes do mesmo formato', () => {
    const first = redactString(FAKE_SECRETS.anthropic);
    const second = redactString(FAKE_SECRETS.anthropicOther);

    expect(first).toBe(second);
    expect(first).toBe(redactionPlaceholder('anthropic-api-key'));
  });

  it('não deixa o placeholder revelar tamanho nem hash do secret', () => {
    const short = redactString('sk-ant-api03-FAKE01234567');
    const long = redactString(`${FAKE_SECRETS.anthropic}FAKE0123456789abcdef`);

    expect(short).toBe(long);
  });

  it('redige bearer token preservando o esquema', () => {
    const redacted = redactString('Authorization: Bearer FAKE0123456789abcdef');

    expect(redacted).toBe(`Authorization: Bearer ${redactionPlaceholder('bearer-token')}`);
  });

  it('redige a senha da URL preservando esquema, usuário e host', () => {
    const redacted = redactString('git remote https://igor:FAKEpassword123@github.com/org/repo.git');

    expect(redacted).toBe(
      `git remote https://igor:${redactionPlaceholder('url-password')}@github.com/org/repo.git`,
    );
  });

  it('é idempotente', () => {
    const line = `key=${FAKE_SECRETS.anthropic} auth: Bearer FAKE0123456789abcdef password=hunter2`;
    const once = redactString(line);

    expect(redactString(once)).toBe(once);
  });
});

describe('redaction por nome de chave sensível', () => {
  it('redige valor de formato desconhecido em atribuição de env', () => {
    const redacted = redactString('CODEX_API_KEY=nao-tem-formato-conhecido-123');

    expect(redacted).toBe(`CODEX_API_KEY=${redactionPlaceholder('sensitive-value')}`);
  });

  it('preserva a estrutura JSON ao redigir o valor', () => {
    const line = `{"model":"claude-opus-5","api_key":"${FAKE_SECRETS.openai}","password":"hunter2"}`;

    const redacted = redactString(line);

    expect(JSON.parse(redacted) as Record<string, string>).toEqual({
      model: 'claude-opus-5',
      // O formato reconhecido tem precedência sobre a regra por nome de chave.
      api_key: redactionPlaceholder('openai-api-key'),
      password: redactionPlaceholder('sensitive-value'),
    });
  });

  it('redige atribuição sensível aninhada no valor de uma chave não sensível', () => {
    const redacted = redactString('provider: {"nested":{"password":"hunter2"},"ok":1}');

    expect(redacted).toBe(
      `provider: {"nested":{"password":"${redactionPlaceholder('sensitive-value')}"},"ok":1}`,
    );
  });

  it('preserva a pontuação que fecha o contexto em volta do valor', () => {
    const redacted = redactString('curl -H "Authorization: Bearer FAKEtokenvalue123456" https://x');

    expect(redacted).toBe(
      `curl -H "Authorization: Bearer ${redactionPlaceholder('bearer-token')}" https://x`,
    );
    expect(redactString('run(CODEX_TOKEN=abc123def456);')).toBe(
      `run(CODEX_TOKEN=${redactionPlaceholder('sensitive-value')});`,
    );
  });

  it('reconhece o nome sensível em camelCase e com hífen', () => {
    expect(isSensitiveKeyName('apiKey')).toBe(true);
    expect(isSensitiveKeyName('X-Auth-Token')).toBe(true);
    expect(isSensitiveKeyName('ANTHROPIC_API_KEY')).toBe(true);
    expect(isSensitiveKeyName('author')).toBe(false);
    expect(isSensitiveKeyName('pass_rate')).toBe(false);
  });

  it('não toca em campos que apenas parecem sensíveis', () => {
    const line = 'AUTHOR=igor pass_rate=0.75 endpoint=https://api.anthropic.com:443/v1/messages';

    expect(redactString(line)).toBe(line);
    expect(containsSecret(line)).toBe(false);
  });
});

describe('utilidade da linha redigida', () => {
  it('preserva timestamp, nível e mensagem em volta do secret', () => {
    const redacted = redactString(
      `2026-08-07T17:49:47.212Z INFO adapter=codex chamando provider com ${FAKE_SECRETS.anthropic} para run 01K0FAKE`,
    );

    expect(redacted).toBe(
      `2026-08-07T17:49:47.212Z INFO adapter=codex chamando provider com ${redactionPlaceholder(
        'anthropic-api-key',
      )} para run 01K0FAKE`,
    );
  });

  it('preserva as demais linhas de um chunk multilinha', () => {
    const chunk = [
      'linha util antes',
      `export ANTHROPIC_API_KEY=${FAKE_SECRETS.anthropic}`,
      'linha util depois',
    ].join('\n');

    const redacted = redactString(chunk);

    expect(redacted.split('\n')).toEqual([
      'linha util antes',
      `export ANTHROPIC_API_KEY=${redactionPlaceholder('anthropic-api-key')}`,
      'linha util depois',
    ]);
  });
});

describe('round-trip de escrita e leitura', () => {
  it('não deixa nenhum secret sobreviver no arquivo persistido', async () => {
    const filePath = await temporaryFile();
    const secrets = [...Object.values(FAKE_SECRETS), PRIVATE_KEY_BLOCK, 'hunter2'];
    const lines = [
      `stdout: exportando ANTHROPIC_API_KEY=${FAKE_SECRETS.anthropic}`,
      `stderr: 401 de Authorization: Bearer ${FAKE_SECRETS.jwt}`,
      `provider: {"api_key":"${FAKE_SECRETS.openai}","password":"hunter2"}`,
      `provider: token do GitHub ${FAKE_SECRETS.github} e ${FAKE_SECRETS.githubPat}`,
      `provider: ${FAKE_SECRETS.google} ${FAKE_SECRETS.slack} ${FAKE_SECRETS.aws}`,
      `provider: ${FAKE_SECRETS.anthropicOther}`,
      `stdout: ${PRIVATE_KEY_BLOCK}`,
    ];

    for (const [index, line] of lines.entries()) {
      await appendJsonLine(filePath, { seq: index + 1, stream: 'stdout', line: redactString(line) });
    }

    const content = await readFile(filePath, 'utf8');
    for (const secret of secrets) {
      expect(content).not.toContain(secret);
    }

    const persisted = content
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as { seq: number; line: string });

    expect(persisted).toHaveLength(lines.length);
    for (const record of persisted) {
      expect(record.line).toContain('[REDACTED:');
      expect(containsSecret(record.line)).toBe(false);
    }
  });
});
