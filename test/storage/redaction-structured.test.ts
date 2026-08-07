import { describe, expect, it } from 'vitest';

import type { JsonValue } from '../../src/core/index.js';
import { EnvironmentProfile } from '../../src/schemas/index.js';
import {
  containsSecret,
  redactEnvironment,
  redactJsonValue,
  redactionPlaceholder,
  REDACTED_PLACEHOLDER,
} from '../../src/storage/index.js';

/** Secrets falsos, com formato válido e valor sem significado. */
const FAKE_SECRETS = {
  anthropic: 'sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0123456789AA',
  github: 'ghp_FAKE0123456789abcdefFAKE0123456789',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlLXN1YmplY3QifQ.FAKE0123456789signature',
} as const;

const SENSITIVE = redactionPlaceholder('sensitive-value');

/** Perfil real do schema: a allowlist da redaction é a do EnvironmentProfile. */
const profile = EnvironmentProfile.parse({
  id: 'controlled-01',
  mode: 'controlled',
  home: 'sanitized',
  env_allowlist: ['HOME', 'PATH', 'ANTHROPIC_API_KEY', 'LAB_ENDPOINT', 'LAB_EMPTY_TOKEN'],
  instruction_files: [],
  plugins: [],
  skills: [],
  mcp_servers: [],
});

function redactEnv(
  env: Readonly<Record<string, string | undefined>>,
  unlisted?: 'redact' | 'omit',
) {
  return redactEnvironment(env, {
    allowlist: profile.env_allowlist,
    ...(unlisted === undefined ? {} : { unlisted }),
  });
}

describe('redaction recursiva de objetos', () => {
  it('preserva chaves, ordem e forma dos objetos aninhados', () => {
    const record: JsonValue = {
      run_id: '01K0FAKE',
      provider: {
        adapter: 'codex',
        auth: { api_key: FAKE_SECRETS.anthropic, mode: 'env' },
      },
      attempts: [{ index: 1, ok: true }],
    };

    const redacted = redactJsonValue(record) as Record<string, JsonValue>;

    expect(redacted).toEqual({
      run_id: '01K0FAKE',
      provider: {
        adapter: 'codex',
        auth: { api_key: redactionPlaceholder('anthropic-api-key'), mode: SENSITIVE },
      },
      attempts: [{ index: 1, ok: true }],
    });
    expect(Object.keys(redacted)).toEqual(['run_id', 'provider', 'attempts']);
    expect(Array.isArray(redacted['attempts'])).toBe(true);
  });

  it('redige os escalares de toda a subárvore sob uma chave sensível', () => {
    const redacted = redactJsonValue({
      credentials: { alias: 'valor-sem-formato-conhecido', rotations: [{ by: 'igor' }] },
      metadata: { alias: 'valor-sem-formato-conhecido' },
    });

    expect(redacted).toEqual({
      credentials: { alias: SENSITIVE, rotations: [{ by: SENSITIVE }] },
      metadata: { alias: 'valor-sem-formato-conhecido' },
    });
  });

  it('redige chave sensível com valor de formato desconhecido, inclusive numérico', () => {
    const redacted = redactJsonValue({
      session_token: 'nao-tem-formato-conhecido-123',
      pin_secret: 483920,
      has_password: true,
      password: null,
      retries: 3,
    });

    expect(redacted).toEqual({
      session_token: SENSITIVE,
      pin_secret: SENSITIVE,
      // Booleano e null não carregam segredo; preservá-los mantém o record legível.
      has_password: true,
      password: null,
      retries: 3,
    });
  });

  it('conserva o rótulo de formato dentro de campo não sensível', () => {
    const redacted = redactJsonValue({
      line: `stdout: falha com ${FAKE_SECRETS.github} no push`,
      note: 'nada a redigir',
    });

    expect(redacted).toEqual({
      line: `stdout: falha com ${redactionPlaceholder('github-token')} no push`,
      note: 'nada a redigir',
    });
  });

  it('preserva arrays e escalares no topo', () => {
    expect(redactJsonValue([FAKE_SECRETS.jwt, 'ok', 7, null])).toEqual([
      redactionPlaceholder('jwt'),
      'ok',
      7,
      null,
    ]);
    expect(redactJsonValue(FAKE_SECRETS.anthropic)).toBe(
      redactionPlaceholder('anthropic-api-key'),
    );
    expect(redactJsonValue(42)).toBe(42);
  });

  it('é idempotente', () => {
    const record: JsonValue = {
      auth: { token: FAKE_SECRETS.jwt, note: 'renovado' },
      url: `https://igor:FAKEpassword123@github.com/org/repo.git`,
    };

    const once = redactJsonValue(record);

    expect(redactJsonValue(once)).toEqual(once);
  });

  it('não trava em estrutura ciclicamente profunda', () => {
    const cyclic: Record<string, unknown> = { name: 'raiz' };
    cyclic['self'] = cyclic;

    const redacted = redactJsonValue(cyclic as unknown as JsonValue);

    expect(JSON.stringify(redacted)).toContain(REDACTED_PLACEHOLDER);
  });

  it('não deixa secret sobreviver na serialização do record', () => {
    const serialized = JSON.stringify(
      redactJsonValue({
        provider: { api_key: FAKE_SECRETS.anthropic, password: 'hunter2' },
        logs: [`export GITHUB_TOKEN=${FAKE_SECRETS.github}`],
      }),
    );

    for (const secret of [...Object.values(FAKE_SECRETS), 'hunter2']) {
      expect(serialized).not.toContain(secret);
    }
    expect(containsSecret(serialized)).toBe(false);
  });
});

describe('redaction de mapa de ambiente', () => {
  it('mantém variável da allowlist cujo valor não tem nada a redigir', () => {
    const { env, records } = redactEnv({ HOME: '/home/igor', PATH: '/usr/bin' });

    expect(env).toEqual({ HOME: '/home/igor', PATH: '/usr/bin' });
    expect(records).toEqual([
      { name: 'HOME', disposition: 'kept', reason: 'allowlisted' },
      { name: 'PATH', disposition: 'kept', reason: 'allowlisted' },
    ]);
  });

  it('redige nome sensível mesmo dentro da allowlist', () => {
    const { env, records } = redactEnv({ ANTHROPIC_API_KEY: FAKE_SECRETS.anthropic });

    expect(env['ANTHROPIC_API_KEY']).toBe(redactionPlaceholder('anthropic-api-key'));
    expect(records).toEqual([
      { name: 'ANTHROPIC_API_KEY', disposition: 'redacted', reason: 'sensitive-name' },
    ]);
  });

  it('redige nome sensível com valor de formato desconhecido', () => {
    const { env } = redactEnv({ ANTHROPIC_API_KEY: 'nao-tem-formato-conhecido-123' });

    expect(env['ANTHROPIC_API_KEY']).toBe(SENSITIVE);
  });

  it('redige secret reconhecido em variável de nome inocente', () => {
    const { env, records } = redactEnv({
      LAB_ENDPOINT: 'https://igor:FAKEpassword123@lab.local/v1',
    });

    expect(env['LAB_ENDPOINT']).toBe(
      `https://igor:${redactionPlaceholder('url-password')}@lab.local/v1`,
    );
    expect(records).toEqual([
      { name: 'LAB_ENDPOINT', disposition: 'redacted', reason: 'secret-in-value' },
    ]);
  });

  it('redige o valor de quem está fora da allowlist, registrando o nome', () => {
    const { env, records } = redactEnv({ HOME: '/home/igor', AWS_SESSION: 'FAKEvalue' });

    expect(env).toEqual({ HOME: '/home/igor', AWS_SESSION: REDACTED_PLACEHOLDER });
    expect(records).toContainEqual({
      name: 'AWS_SESSION',
      disposition: 'redacted',
      reason: 'not-allowlisted',
    });
  });

  it('omite quem está fora da allowlist quando pedido, registrando o nome', () => {
    const { env, records } = redactEnv({ HOME: '/home/igor', AWS_SESSION: 'FAKEvalue' }, 'omit');

    expect(env).toEqual({ HOME: '/home/igor' });
    expect(Object.keys(env)).not.toContain('AWS_SESSION');
    expect(records).toContainEqual({
      name: 'AWS_SESSION',
      disposition: 'omitted',
      reason: 'not-allowlisted',
    });
  });

  it('ignora variável ausente e ordena a saída por nome', () => {
    const { env, records } = redactEnv({
      PATH: '/usr/bin',
      LAB_ENDPOINT: 'https://lab.local/v1',
      HOME: '/home/igor',
      LAB_ABSENT: undefined,
    });

    expect(Object.keys(env)).toEqual(['HOME', 'LAB_ENDPOINT', 'PATH']);
    expect(records.map((record) => record.name)).toEqual(['HOME', 'LAB_ENDPOINT', 'PATH']);
  });

  it('trata valor vazio de nome sensível como não segredo', () => {
    const { env, records } = redactEnv({ LAB_EMPTY_TOKEN: '' });

    expect(env['LAB_EMPTY_TOKEN']).toBe('');
    expect(records).toEqual([
      { name: 'LAB_EMPTY_TOKEN', disposition: 'kept', reason: 'allowlisted' },
    ]);
  });

  it('não deixa secret sobreviver na serialização do ambiente redigido', () => {
    const result = redactEnv({
      ANTHROPIC_API_KEY: FAKE_SECRETS.anthropic,
      GITHUB_TOKEN: FAKE_SECRETS.github,
      HOME: '/home/igor',
    });

    const serialized = JSON.stringify(result);

    for (const secret of Object.values(FAKE_SECRETS)) {
      expect(serialized).not.toContain(secret);
    }
    expect(containsSecret(serialized)).toBe(false);
  });
});
