import { z } from 'zod';

import { canonicalSha256 } from '../envelope/index.js';

const nonEmpty = z.string().trim().min(1);
const gitCommitSha = z
  .string()
  .regex(/^[0-9a-f]{40}$/, 'base_sha deve ser SHA-1 de commit em hex minúsculo');

/** Repositório externo alvo da implementação. Nunca o próprio agent-strategy-lab. */
export const TargetRepo = z
  .object({
    url: nonEmpty,
  })
  .strict();
export type TargetRepo = z.infer<typeof TargetRepo>;

/** Revisão base do repositório alvo. Exige SHA-1 completo para fixar identidade. */
export const BaseRevision = z
  .object({
    sha: gitCommitSha,
  })
  .strict();
export type BaseRevision = z.infer<typeof BaseRevision>;

/**
 * Registro explícito do que o usuário pediu — o "execution_intent". Isto NÃO é
 * autorização geral: é só o resumo do escopo pedido, para que gates humanos
 * posteriores possam ser proporcionais (ex.: não perguntar de novo algo que o
 * usuário já pediu explicitamente) em vez de redundantes. Ver
 * `ExecutionAuthorizationScope` para a separação entre isto e o que pode
 * efetivamente ser executado sem novo gate.
 */
export const RequestedScope = z
  .object({
    summary: nonEmpty,
  })
  .strict();
export type RequestedScope = z.infer<typeof RequestedScope>;

/**
 * Pedido formal de implementação sobre um repositório externo. Estado
 * persistido do control plane (nunca memória conversacional de worker),
 * strict e versionado.
 *
 * `constraints` e `exclusions` podem ser arrays vazios — a ausência de
 * restrições declaradas é diferente de campo ausente.
 */
export const ProjectIntakeRequest = z
  .object({
    schema_version: z.literal(1),
    target_repo: TargetRepo,
    base_revision: BaseRevision,
    user_request: nonEmpty,
    objectives: z.array(nonEmpty).min(1),
    constraints: z.array(nonEmpty),
    exclusions: z.array(nonEmpty),
    requested_scope: RequestedScope,
  })
  .strict();
export type ProjectIntakeRequest = z.infer<typeof ProjectIntakeRequest>;

/**
 * Identidade canônica determinística do intake, reusando `canonicalSha256`
 * de `envelope/index.ts`. Reordenar chaves do objeto não muda o hash.
 */
export function projectIntakeSha256(intake: ProjectIntakeRequest): string {
  return canonicalSha256(intake);
}

/**
 * Ações que o harness pode realizar dentro do escopo autorizado do
 * projeto/run sem exigir um novo gate humano por spawn individual.
 */
export const AutonomousExecutionCapability = z.enum([
  'DISPOSABLE_LOCAL_WORKSPACE',
  'CONFIGURED_SUBSCRIPTION_WORKER',
  'DETERMINISTIC_VALIDATION',
  'BOUNDED_REPAIR',
  'CAPABILITY_ESCALATION_WITHIN_LADDER',
  'CROSS_PROVIDER_WITHIN_ALLOWED_SUBSCRIPTION_PROFILES',
]);
export type AutonomousExecutionCapability = z.infer<typeof AutonomousExecutionCapability>;

/**
 * Categorias que continuam exigindo intervenção humana independentemente do
 * que `requested_scope` registra. `requested_scope` nunca autoriza, por si
 * só, nenhuma destas categorias — é isso que o tipo separado impede de ser
 * inferido implicitamente ("o usuário pediu X, logo Y está autorizado").
 */
export const HumanGatedCapability = z.enum([
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
]);
export type HumanGatedCapability = z.infer<typeof HumanGatedCapability>;

/**
 * AUTORIDADE HUMANA REAL — o subconjunto de `HumanGatedCapability` em que um
 * humano/operador é a ÚNICA fonte possível da decisão, autorização ou insumo
 * que falta.
 *
 * A distinção existe porque um BLOQUEIO TÉCNICO não é uma DECISÃO HUMANA.
 * Automação que não sabe o que fazer, evidência que não pôde ser verificada,
 * telemetria de provider ausente e ferramenta quebrada são todos problemas
 * técnicos: continuam sendo fail-closed, mas nenhum deles nomeia uma
 * autoridade que só um humano detém. Nomeá-los `HUMAN_REQUIRED` inventava
 * autoridade de execução e parava a run pedindo uma decisão que não existia.
 *
 * Por isso `INSUFFICIENT_EVIDENCE` — a única categoria de `HumanGatedCapability`
 * que descreve o estado da automação em vez de um poder do operador — está
 * DELIBERADAMENTE fora desta lista. Não há `OTHER`, `UNKNOWN`, `GENERIC` nem
 * `TECHNICAL_PROBLEM`: um caminho novo que não consegue nomear uma destas
 * autoridades não é `HUMAN_REQUIRED`, é um blocker técnico tipado.
 */
export const HumanAuthority = z.enum([
  /** Cobrança por API fora da assinatura autorizada. */
  'UNAUTHORIZED_API_BILLING',
  /** Trocar o modo de cobrança acordado para a run. */
  'BILLING_MODE_CHANGE',
  /** Ação destrutiva sobre trabalho, histórico ou dados. */
  'DESTRUCTIVE_ACTION',
  /** Deploy ou efeito em produção. */
  'DEPLOYMENT_OR_PRODUCTION',
  /** Efeito observável fora do workspace (publicar, notificar, integrar). */
  'EXTERNAL_SIDE_EFFECT',
  /** Ampliar o escopo de produto/autorização acordado. */
  'SCOPE_EXPANSION',
  /** Conceder uma credencial ou fronteira de credencial nova. */
  'NEW_CREDENTIAL_BOUNDARY',
  /** Decisão de produto/arquitetura genuinamente em aberto. */
  'UNRESOLVED_ARCHITECTURE_OR_PRODUCT_DECISION',
  /** Ação crítica ou sensível a segurança. */
  'CRITICAL_OR_SECURITY_SENSITIVE_ACTION',
  /** Ampliar a policy de profile/provider autorizada. */
  'PROFILE_OR_PROVIDER_OUTSIDE_POLICY',
  /** Ampliar a autonomia segura depois de um boundary INTENCIONALMENTE esgotado. */
  'SAFE_ESCALATION_EXHAUSTED',
]);
export type HumanAuthority = z.infer<typeof HumanAuthority>;

/**
 * `INSUFFICIENT_EVIDENCE` é a diferença exata entre as duas listas. Manter a
 * prova em tipos impede que uma categoria nova entre em `HumanGatedCapability`
 * e passe a valer como autoridade humana sem alguém decidir isso.
 */
export type NonAuthoritativeHumanGatedCapability = Exclude<
  HumanGatedCapability,
  HumanAuthority
>;
const _AUTHORITY_IS_SUBSET_OF_GATED: readonly HumanGatedCapability[] = HumanAuthority.options;
const _NON_AUTHORITATIVE_IS_EXACTLY_INSUFFICIENT_EVIDENCE: NonAuthoritativeHumanGatedCapability =
  'INSUFFICIENT_EVIDENCE';
void _AUTHORITY_IS_SUBSET_OF_GATED;
void _NON_AUTHORITATIVE_IS_EXACTLY_INSUFFICIENT_EVIDENCE;

/**
 * BLOQUEIOS TÉCNICOS tipados: a automação para, fail-closed, sem inventar
 * autoridade humana. Nenhum deles autoriza continuar; todos são recuperáveis
 * por conserto técnico, novo insumo ou reset de janela — não por decisão de
 * operador.
 */
export const TechnicalBlocker = z.enum([
  /** Evidência ausente/insuficiente para decidir; nada é promovido. */
  'INSUFFICIENT_EVIDENCE',
  /** Evidência autoritativa em contradição consigo mesma. */
  'INCONSISTENT_EVIDENCE',
  /** Identidade/proveniência autoritativa inválida (base, candidate, cadeia). */
  'INVALID_PROVENANCE',
  /** Ferramenta/validação quebrada sem primitive de remediação conhecida. */
  'VALIDATION_OR_TOOLING_GAP',
  /** Falha de provider/infra sem output de protocolo utilizável. */
  'PROVIDER_OR_INFRA_FAILURE',
  /** Uma primitive de remediação automática rodou e não resolveu o incidente. */
  'AUTOMATED_REMEDIATION_FAILED',
  /** Configuração de runtime/plano incoerente com o que o loop precisa. */
  'RUNTIME_CONFIGURATION_INVALID',
  /** Não há profile elegível AGORA (capacidade ou quota); a policy não muda. */
  'NO_ELIGIBLE_EXECUTOR',
]);
export type TechnicalBlocker = z.infer<typeof TechnicalBlocker>;

/**
 * Decisão de autorização de uma ação candidata. `ALLOWED` significa dentro
 * do boundary autônomo aprovado para este escopo/run; `HUMAN_REQUIRED`
 * significa que um gate humano é necessário antes da ação prosseguir.
 */
export const ExecutionAuthorizationDecision = z.enum(['ALLOWED', 'HUMAN_REQUIRED']);
export type ExecutionAuthorizationDecision = z.infer<typeof ExecutionAuthorizationDecision>;

/**
 * Contrato de autorização de execução, provider-neutro e separado do
 * `ProjectIntakeRequest`. Distingue três partes:
 *
 * 1. `requested_scope` — o que o usuário pediu (reusa o mesmo tipo do
 *    intake, não uma estrutura paralela).
 * 2. `autonomous_execution_boundary` — o subconjunto de
 *    `AutonomousExecutionCapability` que este projeto/run pode exercer sem
 *    novo gate humano.
 * 3. `human_gated_capabilities` — o subconjunto de `HumanGatedCapability`
 *    que este projeto/run reconhece como sempre exigindo gate.
 *
 * A autorização é de escopo no nível do projeto/run: um spawn individual
 * dentro do boundary não exige um novo gate. Isto é implementado por
 * `authorizeExecutionAction`, que nunca deriva `ALLOWED` a partir de
 * `requested_scope` isoladamente.
 */
export const ExecutionAuthorizationScope = z
  .object({
    schema_version: z.literal(1),
    requested_scope: RequestedScope,
    autonomous_execution_boundary: z.array(AutonomousExecutionCapability).min(1),
    human_gated_capabilities: z.array(HumanGatedCapability).min(1),
  })
  .strict();
export type ExecutionAuthorizationScope = z.infer<typeof ExecutionAuthorizationScope>;

/**
 * Identidade canônica determinística do escopo de autorização, reusando o
 * mesmo `canonicalSha256` do envelope.
 */
export function executionAuthorizationScopeSha256(scope: ExecutionAuthorizationScope): string {
  return canonicalSha256(scope);
}

/**
 * FONTE ÚNICA de verdade de "como o header estruturado da Run Directive pode
 * satisfazer uma categoria human-gated implicada pelo corpo".
 *
 * - `{ kind: 'publish' }` — a intenção é coberta por `authorization.publish`
 *   (publicar no remoto/ref concedido). É a ÚNICA categoria com caminho de
 *   grant pelo header.
 * - `{ kind: 'never' }` — a política do produto NUNCA concede a categoria por
 *   Run Directive (espelha `DirectiveNeverGrantablePermission`); a resposta
 *   HUMAN_REQUIRED não pode oferecer "conceda no header" para estas.
 *
 * Qualquer UX de HUMAN_REQUIRED deve derivar opções DAQUI, nunca de uma lista
 * paralela.
 */
export type HumanGateGrantPath = { readonly kind: 'publish' } | { readonly kind: 'never' };

export const HUMAN_GATE_GRANT_PATH: Readonly<Record<HumanGatedCapability, HumanGateGrantPath>> = {
  UNAUTHORIZED_API_BILLING: { kind: 'never' },
  BILLING_MODE_CHANGE: { kind: 'never' },
  DESTRUCTIVE_ACTION: { kind: 'never' },
  DEPLOYMENT_OR_PRODUCTION: { kind: 'never' },
  EXTERNAL_SIDE_EFFECT: { kind: 'publish' },
  SCOPE_EXPANSION: { kind: 'never' },
  NEW_CREDENTIAL_BOUNDARY: { kind: 'never' },
  UNRESOLVED_ARCHITECTURE_OR_PRODUCT_DECISION: { kind: 'never' },
  CRITICAL_OR_SECURITY_SENSITIVE_ACTION: { kind: 'never' },
  PROFILE_OR_PROVIDER_OUTSIDE_POLICY: { kind: 'never' },
  INSUFFICIENT_EVIDENCE: { kind: 'never' },
  SAFE_ESCALATION_EXHAUSTED: { kind: 'never' },
};

export type ExecutionAction =
  | { readonly kind: 'autonomous'; readonly capability: AutonomousExecutionCapability }
  | { readonly kind: 'human_gated'; readonly capability: HumanGatedCapability };

/**
 * Classifica uma ação candidata contra o `ExecutionAuthorizationScope`.
 * Ações `human_gated` são SEMPRE `HUMAN_REQUIRED`, independentemente do
 * conteúdo de `requested_scope` — isto é o que impede a inferência "o
 * usuário pediu X, logo qualquer ação necessária está autorizada". Ações
 * `autonomous` são `ALLOWED` somente se a capability estiver listada no
 * boundary deste escopo.
 */
export function authorizeExecutionAction(
  scope: ExecutionAuthorizationScope,
  action: ExecutionAction,
): ExecutionAuthorizationDecision {
  if (action.kind === 'human_gated') return 'HUMAN_REQUIRED';
  return scope.autonomous_execution_boundary.includes(action.capability)
    ? 'ALLOWED'
    : 'HUMAN_REQUIRED';
}

export {
  HumanInstruction,
  createHumanInstruction,
  humanInstructionBody,
  humanInstructionHash,
} from './human-instruction.js';
export type { HumanInstruction as HumanInstructionRecord } from './human-instruction.js';
export {
  AgentLabRunDirectiveHeader,
  DirectiveAuthorization,
  DirectiveDeliberation,
  DirectiveExecution,
  DirectivePlanning,
  DirectiveGrantablePermission,
  DirectiveNeverGrantablePermission,
  DirectivePermission,
  DirectivePublishGrant,
  DirectiveTarget,
  RunDirectiveError,
  normalizeDirectiveText,
  parseRunDirective,
  runDirectiveHash,
} from './run-directive.js';
export type { ParsedRunDirective } from './run-directive.js';
export {
  CompiledIntakeFields,
  DETERMINISTIC_INTAKE_COMPILER_PROFILE,
  compileIntakeFieldsDeterministic,
  deterministicIntakeCompiler,
} from './compile.js';
export type { IntakeCompilerPort } from './compile.js';
export { classifyImpliedHumanGated, classifyImpliedHumanGatedMatches } from './implied-gates.js';
export type { ImpliedGateMatch } from './implied-gates.js';
