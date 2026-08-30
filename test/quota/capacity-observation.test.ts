import { describe, expect, it } from 'vitest';

import {
  CapacityPrecision,
  CapacityStatus,
  PoolCapacityObservation,
  anthropicCapacityOf,
  poolUnavailable,
  probeOpenAiSubscriptionQuota,
  probeOpenCodeGoQuota,
  probeOpenRouterBalance,
  remainingPercentOf,
  unknownCapacity,
  windowDeltas,
  type ProbeFetch,
} from '../../src/quota/index.js';
import { SealedCredential, sameChatGptAccount } from '../../src/quota/credentials.js';

const OBSERVED_AT = '2026-08-27T12:00:00.000Z';

/** Credencial FALSA: nenhum teste toca credencial real nem rede. */
function fakeCredential(label = 'teste', fingerprint: string | null = null) {
  return {
    present: true as const,
    credential: new SealedCredential({
      label,
      accountFingerprint: fingerprint,
      apply: (headers) => {
        headers['authorization'] = 'Bearer valor-de-teste-nao-e-segredo';
      },
    }),
  };
}

function respondWith(body: unknown, ok = true, status = 200): ProbeFetch {
  return async () => ({ ok, status, text: async () => JSON.stringify(body) });
}

/** Corpo real observado no endpoint, com o PII removido — como o probe o trata. */
const OPENAI_BODY = {
  user_id: 'user-EXEMPLO',
  account_id: 'conta-EXEMPLO',
  email: 'exemplo@example.com',
  plan_type: 'plus',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 3,
      limit_window_seconds: 18000,
      reset_after_seconds: 12534,
      reset_at: 1787878155,
    },
    secondary_window: {
      used_percent: 0,
      limit_window_seconds: 604800,
      reset_after_seconds: 599334,
      reset_at: 1788464955,
    },
  },
};

const GO_BODY = {
  usage: {
    rolling: { status: 'ok', percent: 0, resetsAt: '2026-08-28T02:20:32.277Z' },
    weekly: { status: 'ok', percent: 1, resetsAt: '2026-08-31T00:00:00.277Z' },
    monthly: { status: 'ok', percent: 0, resetsAt: '2026-09-27T15:25:31.277Z' },
  },
};

describe('quota OpenAI — assinatura ChatGPT', () => {
  it('janelas de 5h e semanal são interpretadas com reset datável', async () => {
    const observation = await probeOpenAiSubscriptionQuota({
      credential: fakeCredential(),
      fetch: respondWith(OPENAI_BODY),
      now: () => new Date(OBSERVED_AT),
    });
    expect(observation.status).toBe(CapacityStatus.KNOWN);
    expect(observation.plan).toBe('plus');
    const primary = observation.windows.find((window) => window.window_id === 'primary');
    const secondary = observation.windows.find((window) => window.window_id === 'secondary');
    expect(primary?.used_percent).toBe(3);
    expect(primary?.remaining_percent).toBe(97);
    expect(primary?.window_seconds).toBe(18_000);
    expect(primary?.resets_at).toBe(new Date(1787878155 * 1000).toISOString());
    expect(secondary?.used_percent).toBe(0);
    expect(secondary?.window_seconds).toBe(604_800);
  });

  it('percentual reportado é preservado exatamente, sem refinar precisão', async () => {
    const observation = await probeOpenAiSubscriptionQuota({
      credential: fakeCredential(),
      fetch: respondWith(OPENAI_BODY),
      now: () => new Date(OBSERVED_AT),
    });
    for (const window of observation.windows) {
      expect(window.precision).toBe(CapacityPrecision.COARSE_INTEGER_PERCENT);
    }
    // 0 e 3 são o que o provider disse; nada é arredondado nem interpolado.
    expect(observation.windows.map((window) => window.used_percent)).toEqual([3, 0]);
  });

  it('nenhum token, e-mail ou id de conta atravessa para a observação', async () => {
    const observation = await probeOpenAiSubscriptionQuota({
      credential: fakeCredential(),
      fetch: respondWith(OPENAI_BODY),
      now: () => new Date(OBSERVED_AT),
    });
    const serialized = JSON.stringify(observation);
    expect(serialized).not.toContain('user-EXEMPLO');
    expect(serialized).not.toContain('conta-EXEMPLO');
    expect(serialized).not.toContain('example.com');
    expect(serialized).not.toContain('Bearer');
  });

  it('limite atingido declarado pelo provider torna o pool EXHAUSTED', async () => {
    const observation = await probeOpenAiSubscriptionQuota({
      credential: fakeCredential(),
      fetch: respondWith({
        ...OPENAI_BODY,
        rate_limit: { ...OPENAI_BODY.rate_limit, allowed: false, limit_reached: true },
      }),
      now: () => new Date(OBSERVED_AT),
    });
    expect(observation.status).toBe(CapacityStatus.EXHAUSTED);
    expect(poolUnavailable(observation)).toBe(true);
  });

  it('falha de endpoint vira UNKNOWN, nunca zero nem esgotado', async () => {
    const observation = await probeOpenAiSubscriptionQuota({
      credential: fakeCredential(),
      fetch: respondWith({}, false, 500),
      now: () => new Date(OBSERVED_AT),
    });
    expect(observation.status).toBe(CapacityStatus.UNKNOWN);
    expect(observation.windows).toEqual([]);
    expect(poolUnavailable(observation)).toBe(false);
  });

  it('credencial ausente vira UNKNOWN com motivo, sem chamar o endpoint', async () => {
    let called = false;
    const observation = await probeOpenAiSubscriptionQuota({
      credential: { present: false, reason: 'auth do Codex ausente ou ilegível' },
      fetch: async () => {
        called = true;
        return { ok: true, status: 200, text: async () => '{}' };
      },
      now: () => new Date(OBSERVED_AT),
    });
    expect(called).toBe(false);
    expect(observation.status).toBe(CapacityStatus.UNKNOWN);
    expect(observation.reason).toContain('auth do Codex');
  });

  it('credencial OpenCode da MESMA conta observa o mesmo pool; de outra, não', () => {
    const codex = fakeCredential('codex_chatgpt_oauth', 'aaaa1111bbbb2222');
    const opencodeMesma = fakeCredential('opencode_openai_oauth', 'aaaa1111bbbb2222');
    const opencodeOutra = fakeCredential('opencode_openai_oauth', 'cccc3333dddd4444');
    expect(sameChatGptAccount(codex, opencodeMesma).same).toBe(true);
    expect(sameChatGptAccount(codex, opencodeOutra).same).toBe(false);
    // Sem credencial dos dois lados a identidade é indeterminável — nunca `true`.
    expect(sameChatGptAccount(codex, { present: false, reason: 'ausente' }).same).toBeNull();
  });

  it('fingerprint de conta não é reversível nem contém o id', () => {
    const credential = new SealedCredential({
      label: 'teste',
      accountFingerprint: null,
      apply: () => undefined,
    });
    expect(JSON.stringify(credential)).not.toContain('Bearer');
    expect(String(credential)).toBe('SealedCredential(teste)');
  });
});

describe('quota OpenCode Go — assinatura autenticada por chave', () => {
  it('rolling, weekly e monthly são interpretadas com reset', async () => {
    const observation = await probeOpenCodeGoQuota({
      credential: fakeCredential(),
      fetch: respondWith(GO_BODY),
      now: () => new Date(OBSERVED_AT),
    });
    expect(observation.status).toBe(CapacityStatus.KNOWN);
    expect(observation.windows.map((window) => window.window_id)).toEqual([
      'rolling',
      'weekly',
      'monthly',
    ]);
    expect(observation.windows.map((window) => window.used_percent)).toEqual([0, 1, 0]);
    expect(observation.windows[0]?.resets_at).toBe('2026-08-28T02:20:32.277Z');
  });

  it('percentual INTEIRO é preservado como veio e rotulado como grosseiro', async () => {
    const observation = await probeOpenCodeGoQuota({
      credential: fakeCredential(),
      fetch: respondWith(GO_BODY),
      now: () => new Date(OBSERVED_AT),
    });
    for (const window of observation.windows) {
      expect(window.precision).toBe(CapacityPrecision.COARSE_INTEGER_PERCENT);
    }
    // O dashboard mostra 3.6% onde a API diz 3. A fração NÃO é fabricada.
    expect(observation.windows.map((window) => window.used_percent)).not.toContain(3.6);
  });

  it('`percent: 0` NÃO é prova de consumo zero', async () => {
    const observation = await probeOpenCodeGoQuota({
      credential: fakeCredential(),
      fetch: respondWith(GO_BODY),
      now: () => new Date(OBSERVED_AT),
    });
    const rolling = observation.windows.find((window) => window.window_id === 'rolling');
    expect(rolling?.used_percent).toBe(0);
    // O record diz o que o número significa, para que ninguém o leia como
    // "nenhum token foi consumido": há consumo abaixo da resolução do medidor.
    expect(observation.reason).toContain('0 não prova consumo zero');
    expect(rolling?.precision).toBe(CapacityPrecision.COARSE_INTEGER_PERCENT);
  });

  it('status de esgotamento reportado pelo provider torna o pool EXHAUSTED', async () => {
    const observation = await probeOpenCodeGoQuota({
      credential: fakeCredential(),
      fetch: respondWith({
        usage: {
          rolling: { status: 'limit_reached', percent: 100, resetsAt: '2026-08-28T02:20:32.277Z' },
          weekly: { status: 'ok', percent: 40, resetsAt: '2026-08-31T00:00:00.277Z' },
          monthly: { status: 'ok', percent: 12, resetsAt: '2026-09-27T15:25:31.277Z' },
        },
      }),
      now: () => new Date(OBSERVED_AT),
    });
    expect(observation.status).toBe(CapacityStatus.EXHAUSTED);
  });

  it('endpoint indisponível vira UNKNOWN, não zero', async () => {
    const observation = await probeOpenCodeGoQuota({
      credential: fakeCredential(),
      fetch: async () => {
        throw new Error('rede indisponível');
      },
      now: () => new Date(OBSERVED_AT),
    });
    expect(observation.status).toBe(CapacityStatus.UNKNOWN);
    expect(observation.windows).toEqual([]);
  });

  it('credencial ausente vira UNKNOWN', async () => {
    const observation = await probeOpenCodeGoQuota({
      credential: { present: false, reason: 'auth do OpenCode sem entrada opencode-go' },
      now: () => new Date(OBSERVED_AT),
    });
    expect(observation.status).toBe(CapacityStatus.UNKNOWN);
  });
});

describe('saldo OpenRouter', () => {
  it('saldo é dinheiro observado, não percentual inventado', async () => {
    const observation = await probeOpenRouterBalance({
      credential: fakeCredential(),
      fetch: respondWith({ data: { total_credits: 13, total_usage: 3.389032833 } }),
      now: () => new Date(OBSERVED_AT),
    });
    expect(observation.status).toBe(CapacityStatus.KNOWN);
    expect(observation.balance).toEqual({
      remaining: 9.610967,
      currency: 'USD',
      precision: CapacityPrecision.CURRENCY,
    });
    // Sem teto de gasto autorizado não existe denominador; nada vira %.
    expect(observation.windows).toEqual([]);
  });

  it('saldo zerado é esgotamento REAL de recurso de cobrança', async () => {
    const observation = await probeOpenRouterBalance({
      credential: fakeCredential(),
      fetch: respondWith({ data: { total_credits: 5, total_usage: 5 } }),
      now: () => new Date(OBSERVED_AT),
    });
    expect(observation.status).toBe(CapacityStatus.EXHAUSTED);
    expect(poolUnavailable(observation)).toBe(true);
  });

  it('saldo UNKNOWN não é automaticamente zero', async () => {
    const observation = await probeOpenRouterBalance({
      credential: fakeCredential(),
      fetch: respondWith({ data: {} }),
      now: () => new Date(OBSERVED_AT),
    });
    expect(observation.status).toBe(CapacityStatus.UNKNOWN);
    expect(observation.balance).toBeNull();
    expect(poolUnavailable(observation)).toBe(false);
  });

  it('a chave nunca aparece na observação', async () => {
    const observation = await probeOpenRouterBalance({
      credential: fakeCredential(),
      fetch: respondWith({ data: { total_credits: 13, total_usage: 3 } }),
      now: () => new Date(OBSERVED_AT),
    });
    expect(JSON.stringify(observation)).not.toContain('Bearer');
    expect(JSON.stringify(observation)).not.toContain('sk-or');
  });
});

describe('contrato de observação', () => {
  it('UNKNOWN nunca reporta janela nem saldo', () => {
    const invalid = PoolCapacityObservation.safeParse({
      schema_version: 1,
      quota_pool: 'anthropic_subscription',
      status: CapacityStatus.UNKNOWN,
      windows: [
        {
          window_id: 'five_hour',
          used_percent: 0,
          remaining_percent: 100,
          precision: CapacityPrecision.FRACTIONAL_PERCENT,
          window_seconds: null,
          window_instance: null,
          resets_at: null,
        },
      ],
      balance: null,
      plan: null,
      reason: 'probe falhou',
      source: 'teste',
      observed_at: OBSERVED_AT,
    });
    expect(invalid.success).toBe(false);
  });

  it('folga restante sem uso observado é recusada', () => {
    const invalid = PoolCapacityObservation.safeParse({
      schema_version: 1,
      quota_pool: 'anthropic_subscription',
      status: CapacityStatus.KNOWN,
      windows: [
        {
          window_id: 'five_hour',
          used_percent: null,
          remaining_percent: 100,
          precision: CapacityPrecision.FRACTIONAL_PERCENT,
          window_seconds: null,
          window_instance: null,
          resets_at: null,
        },
      ],
      balance: null,
      plan: null,
      reason: 'teste',
      source: 'teste',
      observed_at: OBSERVED_AT,
    });
    expect(invalid.success).toBe(false);
  });

  it('remainingPercentOf devolve null para ausência, e nunca 100', () => {
    expect(remainingPercentOf(null)).toBeNull();
    expect(remainingPercentOf(0)).toBe(100);
    expect(remainingPercentOf(3)).toBe(97);
  });

  it('unknownCapacity é o único jeito de dizer "não sei"', () => {
    const observation = unknownCapacity({
      quota_pool: 'openrouter_balance',
      reason: 'credencial ausente',
      source: 'teste',
      observed_at: OBSERVED_AT,
    });
    expect(observation.status).toBe(CapacityStatus.UNKNOWN);
    expect(observation.windows).toEqual([]);
    expect(observation.balance).toBeNull();
  });
});

describe('delta entre observações', () => {
  function observation(usedPercent: number, instance: string) {
    return PoolCapacityObservation.parse({
      schema_version: 1,
      quota_pool: 'opencode_go_subscription',
      status: CapacityStatus.KNOWN,
      windows: [
        {
          window_id: 'rolling',
          used_percent: usedPercent,
          remaining_percent: remainingPercentOf(usedPercent),
          precision: CapacityPrecision.COARSE_INTEGER_PERCENT,
          window_seconds: null,
          window_instance: instance,
          resets_at: null,
        },
      ],
      balance: null,
      plan: null,
      reason: 'teste',
      source: 'teste',
      observed_at: OBSERVED_AT,
    });
  }

  it('mesma instância de janela produz delta observado', () => {
    const [delta] = windowDeltas(observation(1, 'janela-a'), observation(4, 'janela-a'));
    expect(delta?.consumed_pp).toBe(3);
    expect(delta?.same_window).toBe(true);
    expect(delta?.window_reset).toBe(false);
  });

  it('reset entre before e after NÃO produz delta negativo', () => {
    const [delta] = windowDeltas(observation(80, 'janela-a'), observation(2, 'janela-b'));
    // Subtrair aqui produziria -78 pontos que ninguém consumiu.
    expect(delta?.consumed_pp).toBeNull();
    expect(delta?.window_reset).toBe(true);
    expect(delta?.same_window).toBe(false);
  });

  it('queda dentro da MESMA janela é preservada como negativa, não clampada', () => {
    const [delta] = windowDeltas(observation(9, 'janela-a'), observation(7, 'janela-a'));
    expect(delta?.consumed_pp).toBe(-2);
    expect(delta?.reason).toContain('NEGATIVO');
  });
});

describe('Anthropic — mecanismo preservado, formato generalizado', () => {
  it('leitura fracionária do /usage mantém a precisão que ela tem', () => {
    const observation = anthropicCapacityOf({
      readings: [
        { window_id: 'five_hour', used_percent: 12.5, reset_label: 'Aug 27, 7am (America/Sao_Paulo)' },
        { window_id: 'seven_day_all_models', used_percent: 4.2, reset_label: 'Sep 1, 3am (America/Sao_Paulo)' },
      ],
      reason: 'claude -p /usage',
      source: 'claude_print_usage',
      observed_at: OBSERVED_AT,
    });
    expect(observation.status).toBe(CapacityStatus.KNOWN);
    expect(observation.windows[0]?.used_percent).toBe(12.5);
    expect(observation.windows[0]?.precision).toBe(CapacityPrecision.FRACTIONAL_PERCENT);
    // O rótulo de reset é a identidade da instância — é o que impede subtrair
    // entre janelas diferentes.
    expect(observation.windows[0]?.window_instance).toBe('Aug 27, 7am (America/Sao_Paulo)');
  });

  it('probe sem leitura permanece UNKNOWN', () => {
    const observation = anthropicCapacityOf({
      readings: null,
      reason: '/usage não devolveu result legível',
      source: 'claude_print_usage',
      observed_at: OBSERVED_AT,
    });
    expect(observation.status).toBe(CapacityStatus.UNKNOWN);
  });

  it('five_hour remaining 0 é EXHAUSTED: o provider reportou quota restante zero, não folga baixa', () => {
    const observation = anthropicCapacityOf({
      readings: [
        { window_id: 'five_hour', used_percent: 100, reset_label: 'Aug 28, 6:30pm (America/Sao_Paulo)' },
        { window_id: 'seven_day_all_models', used_percent: 45, reset_label: 'Sep 1, 3am (America/Sao_Paulo)' },
      ],
      reason: 'Claude /usage reportou capacidade e provou zero inferência',
      source: 'claude_print_usage_v1',
      observed_at: OBSERVED_AT,
    });
    expect(observation.windows[0]?.remaining_percent).toBe(0);
    expect(observation.status).toBe(CapacityStatus.EXHAUSTED);
    expect(poolUnavailable(observation)).toBe(true);
  });
});

/**
 * Incidente real do piloto Semi-Imperium (launch
 * d1bb96da-b46b-48f3-8ead-7098ba96e829, perfil
 * codex-build-worker-subscription-sol-high-v2).
 *
 * O provider moveu o reset previsto da janela primary em UM segundo entre as
 * duas leituras — 12:51:08 -> 12:51:09 — enquanto as duas observações
 * (08:11 e 08:22) aconteceram HORAS antes desse reset. Identificar a janela
 * pela igualdade exata do timestamp futuro transformou deriva do provider em
 * troca de janela, e 17 pontos percentuais realmente consumidos viraram
 * `consumed_pp: null` com `window_reset: true`.
 */
describe('deriva do timestamp de reset não é troca de janela', () => {
  function openAiObservation(input: {
    readonly observedAt: string;
    readonly primaryUsed: number;
    readonly primaryResetsAt: string;
    readonly secondaryUsed: number;
    readonly secondaryResetsAt: string;
  }) {
    const window = (id: string, used: number, resetsAt: string | null) => ({
      window_id: id,
      used_percent: used,
      remaining_percent: remainingPercentOf(used),
      precision: CapacityPrecision.COARSE_INTEGER_PERCENT,
      window_seconds: id === 'primary' ? 18000 : 604800,
      window_instance: resetsAt,
      resets_at: resetsAt,
    });
    return PoolCapacityObservation.parse({
      schema_version: 1,
      quota_pool: 'openai_chatgpt_subscription',
      status: CapacityStatus.KNOWN,
      windows: [
        window('primary', input.primaryUsed, input.primaryResetsAt),
        window('secondary', input.secondaryUsed, input.secondaryResetsAt),
      ],
      balance: null,
      plan: 'plus',
      reason: 'janelas de uso reportadas pelo provider',
      source: 'https://chatgpt.com/backend-api/wham/usage',
      observed_at: input.observedAt,
    });
  }

  const INCIDENT_BEFORE = openAiObservation({
    observedAt: '2026-08-29T08:11:10.813Z',
    primaryUsed: 83,
    primaryResetsAt: '2026-08-29T12:51:08.000Z',
    secondaryUsed: 76,
    secondaryResetsAt: '2026-09-03T19:49:15.000Z',
  });
  const INCIDENT_AFTER = openAiObservation({
    observedAt: '2026-08-29T08:22:36.696Z',
    primaryUsed: 100,
    primaryResetsAt: '2026-08-29T12:51:09.000Z',
    secondaryUsed: 78,
    secondaryResetsAt: '2026-09-03T19:49:15.000Z',
  });

  it('primary 83 -> 100 com reset deslocado 1s é a MESMA janela: 17 pp consumidos', () => {
    const [primary] = windowDeltas(INCIDENT_BEFORE, INCIDENT_AFTER);
    expect(primary?.window_id).toBe('primary');
    expect(primary?.same_window).toBe(true);
    expect(primary?.window_reset).toBe(false);
    expect(primary?.consumed_pp).toBe(17);
  });

  it('secondary 76 -> 78, instância idêntica, continua com 2 pp — sem regressão', () => {
    const secondary = windowDeltas(INCIDENT_BEFORE, INCIDENT_AFTER)[1];
    expect(secondary?.window_id).toBe('secondary');
    expect(secondary?.same_window).toBe(true);
    expect(secondary?.window_reset).toBe(false);
    expect(secondary?.consumed_pp).toBe(2);
  });

  it('deriva GRANDE também não inventa reset enquanto o reset declarado não chegou', () => {
    const after = openAiObservation({
      observedAt: '2026-08-29T08:22:36.696Z',
      primaryUsed: 100,
      // Uma hora de deriva: continua horas antes do reset declarado no before.
      primaryResetsAt: '2026-08-29T13:51:08.000Z',
      secondaryUsed: 78,
      secondaryResetsAt: '2026-09-03T19:49:15.000Z',
    });
    const [primary] = windowDeltas(INCIDENT_BEFORE, after);
    expect(primary?.same_window).toBe(true);
    expect(primary?.consumed_pp).toBe(17);
  });

  it('intervalo que ATRAVESSA o reset declarado permanece window_reset sem delta', () => {
    const before = openAiObservation({
      observedAt: '2026-08-29T12:40:00.000Z',
      primaryUsed: 96,
      primaryResetsAt: '2026-08-29T12:51:08.000Z',
      secondaryUsed: 76,
      secondaryResetsAt: '2026-09-03T19:49:15.000Z',
    });
    const after = openAiObservation({
      // Depois do reset declarado no before: a janela virou de verdade.
      observedAt: '2026-08-29T13:05:00.000Z',
      primaryUsed: 3,
      primaryResetsAt: '2026-08-29T17:51:08.000Z',
      secondaryUsed: 77,
      secondaryResetsAt: '2026-09-03T19:49:15.000Z',
    });
    const [primary] = windowDeltas(before, after);
    expect(primary?.same_window).toBe(false);
    expect(primary?.window_reset).toBe(true);
    expect(primary?.consumed_pp).toBeNull();
  });

  it('instância diferente sem resets_at datável mantém a semântica UNKNOWN-segura de reset', () => {
    const rotulada = (used: number, label: string, observedAt: string) =>
      PoolCapacityObservation.parse({
        schema_version: 1,
        quota_pool: 'anthropic_subscription',
        status: CapacityStatus.KNOWN,
        windows: [
          {
            window_id: 'five_hour',
            used_percent: used,
            remaining_percent: remainingPercentOf(used),
            precision: CapacityPrecision.FRACTIONAL_PERCENT,
            window_seconds: null,
            window_instance: label,
            resets_at: null,
          },
        ],
        balance: null,
        plan: null,
        reason: 'claude -p /usage',
        source: 'claude_print_usage',
        observed_at: observedAt,
      });
    const [delta] = windowDeltas(
      rotulada(80, 'Aug 29, 9am', '2026-08-29T08:11:10.813Z'),
      rotulada(2, 'Aug 29, 2pm', '2026-08-29T09:11:10.813Z'),
    );
    expect(delta?.same_window).toBe(false);
    expect(delta?.window_reset).toBe(true);
    expect(delta?.consumed_pp).toBeNull();
  });

  it('window_instance ausente continua UNKNOWN: nem mesma janela, nem reset', () => {
    const semInstancia = (used: number, observedAt: string) =>
      PoolCapacityObservation.parse({
        schema_version: 1,
        quota_pool: 'openai_chatgpt_subscription',
        status: CapacityStatus.KNOWN,
        windows: [
          {
            window_id: 'primary',
            used_percent: used,
            remaining_percent: remainingPercentOf(used),
            precision: CapacityPrecision.COARSE_INTEGER_PERCENT,
            window_seconds: 18000,
            window_instance: null,
            resets_at: null,
          },
        ],
        balance: null,
        plan: null,
        reason: 'teste',
        source: 'teste',
        observed_at: observedAt,
      });
    const [delta] = windowDeltas(
      semInstancia(83, '2026-08-29T08:11:10.813Z'),
      semInstancia(100, '2026-08-29T08:22:36.696Z'),
    );
    expect(delta?.same_window).toBeNull();
    expect(delta?.window_reset).toBe(false);
    expect(delta?.consumed_pp).toBe(17);
  });

  it('instância trocada ANTES do reset declarado mas com uso CAINDO é contradição: UNKNOWN', () => {
    const after = openAiObservation({
      observedAt: '2026-08-29T08:22:36.696Z',
      // Uso despencou: a evidência numérica contradiz "a janela não resetou".
      primaryUsed: 4,
      primaryResetsAt: '2026-08-29T13:51:08.000Z',
      secondaryUsed: 78,
      secondaryResetsAt: '2026-09-03T19:49:15.000Z',
    });
    const [primary] = windowDeltas(INCIDENT_BEFORE, after);
    // Nem consumo negativo inventado, nem reset inventado.
    expect(primary?.same_window).toBeNull();
    expect(primary?.window_reset).toBe(false);
    expect(primary?.consumed_pp).toBeNull();
  });
});
