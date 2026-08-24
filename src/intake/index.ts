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
  DirectiveExecution,
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
export { classifyImpliedHumanGated } from './implied-gates.js';
