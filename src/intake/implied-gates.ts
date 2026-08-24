import type { HumanGatedCapability } from './index.js';

/**
 * Classifica INTENÇÃO a partir do texto humano. Isto NÃO autoriza nada:
 * só nomeia categorias human-gated que o pedido implica. A policy decide
 * se a categoria exige gate.
 */
const DEPLOYMENT_NEGATION = /\b(do not|don't|nao|não)\b.{0,40}\bdeploy/i;
const DEPLOYMENT_REQUEST =
  /\bdeploy(ment|ing|ed|ar|e)?\b/i;
const PRODUCTION = /\b(production|prod(?:uction)?|produção|producao)\b/i;
const DEPLOY_THIS_APP = /\bdeploy this (application|app|service|system)\b/i;

const DESTRUCTIVE = /\b(rm\s+-rf|wipe (the )?repo|delete everything|destroy (the )?(database|cluster)|force[- ]push)\b/i;
const EXTERNAL_PUSH = /\b(git push|push to origin|publish to (npm|pypi)|send (this )?email)\b/i;
const API_BILLING = /\b(use (an? )?api key|anthropic_api_key|--api-key|disable billing|ignore billing|charge (the )?api)\b/i;
const CREDENTIAL = /\b(use (my )?(api key|access token)|disable sandbox|bypass sandbox)\b/i;

function matchesDeployment(text: string): boolean {
  if (DEPLOYMENT_NEGATION.test(text)) return false;
  return (DEPLOYMENT_REQUEST.test(text) && PRODUCTION.test(text)) || DEPLOY_THIS_APP.test(text);
}

export function classifyImpliedHumanGated(rawInstruction: string): readonly HumanGatedCapability[] {
  const text = rawInstruction.trim();
  const implied: HumanGatedCapability[] = [];
  if (matchesDeployment(text)) implied.push('DEPLOYMENT_OR_PRODUCTION');
  if (DESTRUCTIVE.test(text)) implied.push('DESTRUCTIVE_ACTION');
  if (EXTERNAL_PUSH.test(text)) implied.push('EXTERNAL_SIDE_EFFECT');
  if (API_BILLING.test(text)) implied.push('UNAUTHORIZED_API_BILLING');
  if (CREDENTIAL.test(text)) implied.push('NEW_CREDENTIAL_BOUNDARY');
  return implied;
}
