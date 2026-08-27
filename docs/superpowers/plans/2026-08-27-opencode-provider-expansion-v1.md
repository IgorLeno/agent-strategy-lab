# Provider Expansion v1 — OpenCode como scaffold de execução

Base: `bc21756` (size advisory != execution gate, preservado).

## Problema

O Lab depende operacionalmente de dois scaffolds (Claude Code, Codex CLI) e o
campo `agent` significa, ao mesmo tempo, scaffold, provider, pool de quota e
fonte de cobrança. Quota de assinatura acaba rápido e não há para onde rotear.

## Dimensões que passam a ser separadas

| dimensão | exemplo Codex | exemplo OpenCode/Go | exemplo OpenCode/OpenRouter |
| --- | --- | --- | --- |
| execution scaffold | `codex_cli` | `opencode` | `opencode` |
| provider (upstream) | `openai` | `opencode_go` | `openrouter` |
| model | `gpt-5.6-sol` | `deepseek-v4-flash` | `z-ai/glm-4.7-flash` |
| auth method | `chatgpt_oauth` | `api_key` | `api_key` |
| billing mode | `subscription` | `subscription` | `metered_api` |
| quota pool | `openai_chatgpt_subscription` | `opencode_go_subscription` | `openrouter_balance` |

Invariante central: **api_key NÃO implica metered_api.** A chave do OpenCode Go
autentica uma assinatura de valor fixo.

Segunda invariante: **scaffold != provider.** `codex_cli -> openai` e
`opencode -> openai` compartilham `openai_chatgpt_subscription`; não são
capacidade independente.

## Entregas

- [x] 1. `src/providers/` — identidade normalizada + tabela de combinações legais
- [x] 2. `dev/lib/profile.ts` — bloco `provider:` opcional; perfis legados mapeiam deterministicamente
- [x] 3. OpenCode como scaffold: launcher, argv, contrato de acesso, probe de credencial
- [x] 4. Role safety estrutural via `OPENCODE_PERMISSION` (deny curto-circuita antes de qualquer ask; `--auto` não contorna)
- [x] 5. `src/quota/` — observação normalizada (KNOWN / AVAILABLE_WITHOUT_METER / EXHAUSTED / UNKNOWN) + probes OpenAI, OpenCode Go, OpenRouter
- [x] 6. Routing por pool de quota e provider upstream, não por nome de executável
- [x] 7. Catálogo inicial de 10 perfis OpenCode
- [x] 8. TUI/projeção por pool; UNKNOWN impresso como UNKNOWN
- [x] 9. Testes focados + suíte completa verde
- [x] 10. Documentação

## Fronteiras

- Não reintroduzir teto de bytes como gate. Size continua advisory.
- Não criar gate de quota por percentual. Só exaustão REAL do provider remove perfil.
- OpenRouter exige autorização explícita de run; credencial não é autorização.
- Nenhum segredo em record, log, teste ou git.
- Runtime `semi-imperium-real-01` não é tocado.
