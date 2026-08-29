/**
 * Avaliação de intenção human-gated da HumanInstruction persistida.
 *
 * NEW e RESUME, e o launch de produção, consomem ESTA função — nunca uma
 * segunda lista lexical, substring nova, risco da task ou prosa do planner.
 *
 * Fontes: corpo da HumanInstruction, ExecutionAuthorizationScope persistido,
 * publish grant persistido, `authorizeExecutionAction` + `HUMAN_GATE_GRANT_PATH`.
 */
import {
  authorizeExecutionAction,
  classifyImpliedHumanGatedMatches,
  humanInstructionBody,
  type ExecutionAuthorizationScope,
  type HumanGatedCapability,
  type ImpliedGateMatch,
} from '../../src/intake/index.js';
import {
  labArtifactPaths,
  loadHumanInstruction,
  loadPublishGrant,
  pathExists,
} from './lab-runtime.js';

export type ImpliedHumanGatedEvaluation =
  | { readonly outcome: 'ALLOW'; readonly implied: readonly HumanGatedCapability[] }
  | {
      readonly outcome: 'HUMAN_REQUIRED';
      readonly implied: readonly HumanGatedCapability[];
      readonly capability: HumanGatedCapability;
      readonly evidence: string;
      readonly match: ImpliedGateMatch;
    };

export function evaluateImpliedHumanGatedIntent(input: {
  readonly instructionBody: string;
  readonly scope: ExecutionAuthorizationScope;
  readonly publishAllowed: boolean;
}): ImpliedHumanGatedEvaluation {
  const implied: HumanGatedCapability[] = [];
  let first: ImpliedGateMatch | undefined;
  for (const match of classifyImpliedHumanGatedMatches(input.instructionBody)) {
    // INTENT != AUTHORIZATION: a única satisfação possível vem do header
    // estruturado. Intenção de publicar no remoto/ref já concedido por
    // authorization.publish não é um gate novo — é exatamente o que o grant
    // autoriza. Toda outra categoria continua HUMAN_REQUIRED.
    if (match.satisfiable_by === 'publish' && input.publishAllowed) continue;
    const decision = authorizeExecutionAction(input.scope, {
      kind: 'human_gated',
      capability: match.capability,
    });
    if (decision !== 'HUMAN_REQUIRED') continue;
    implied.push(match.capability);
    first ??= match;
  }
  if (first === undefined) return { outcome: 'ALLOW', implied: [] };
  return {
    outcome: 'HUMAN_REQUIRED',
    implied,
    capability: first.capability,
    evidence: first.evidence,
    match: first,
  };
}

export function executionScopeFromAuthorization(input: {
  readonly requested_scope: ExecutionAuthorizationScope['requested_scope'];
  readonly autonomous_execution_boundary: ExecutionAuthorizationScope['autonomous_execution_boundary'];
  readonly human_gated_capabilities: ExecutionAuthorizationScope['human_gated_capabilities'];
}): ExecutionAuthorizationScope {
  return {
    schema_version: 1,
    requested_scope: input.requested_scope,
    autonomous_execution_boundary: input.autonomous_execution_boundary,
    human_gated_capabilities: input.human_gated_capabilities,
  };
}

/**
 * Fonte autoritativa, no runtime Lab, das categorias que a instrução humana
 * implica de fato. Sem HumanInstruction persistida (orchestrate direto),
 * devolve vazio — não inventa capability a partir de objective, risk ou plano.
 */
export async function resolveImpliedHumanGatedFromRuntime(
  runtimeDir: string,
  scope: ExecutionAuthorizationScope,
): Promise<readonly HumanGatedCapability[]> {
  const artifacts = labArtifactPaths(runtimeDir);
  if (!(await pathExists(artifacts.humanInstruction))) return [];
  const instruction = await loadHumanInstruction(artifacts.humanInstruction);
  const grant = await loadPublishGrant(artifacts.publishGrant);
  return evaluateImpliedHumanGatedIntent({
    instructionBody: humanInstructionBody(instruction),
    scope,
    publishAllowed: grant?.allowed === true,
  }).implied;
}
