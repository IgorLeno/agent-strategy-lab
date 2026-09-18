/**
 * Launch REAL do INCIDENT_INVESTIGATOR.
 *
 * Não existe um quarto role estrutural: o investigator reusa exatamente o
 * mecanismo read-only do `reviewer` (dev/lib/project-roles.ts) — mesmo argv
 * overlay, mesma prova estrutural por provider, mesmo `assertReadOnlyArgv`.
 * O que muda é só o PROMPT e o SCHEMA de saída esperado (`IncidentDiagnosis`
 * em vez de um veredito de review). Decisão registrada em
 * docs/autonomous-incident-recovery-plan.md: reusar `reviewer` evita abrir um
 * quinto/sexto switch exaustivo em cada adapter de provider.
 *
 * Fatos de credencial/quota vêm de `collectCurrentLaunchFacts`
 * (dev/lib/project-preflight.ts), a MESMA primitive canônica que
 * implementer/reviewer/escalation usam — nenhum regime de quota paralelo.
 */
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { ExecutionAuthorizationScope } from '../../src/intake/index.js';
import { assertNoApiCredentials, runBillingPreflight } from './billing.js';
import type { IncidentInvestigatorPort } from './incident-recovery-coordinator.js';
import {
  IncidentDiagnosis,
  type IncidentInvestigationResult,
  type InvestigatorLaunchEvidence,
  type RecoveryIncident,
} from './incident-recovery.js';
import { machineSafetyCeiling } from './machine-safety.js';
import type { HarnessPaths } from './paths.js';
import {
  createProductionPoolCapacityProbe,
  observeEligiblePoolCapacities,
  type PoolCapacityProbe,
} from './pool-capacity-observer.js';
import type { LoadedProjectRunAuthorization } from './project-authorization.js';
import { collectCurrentLaunchFacts } from './project-preflight.js';
import {
  authorizeProjectLaunch,
  createProviderRoleInvocationPort,
  extractRoleModelJson,
  ProviderRoleInvocationError,
  resolveRoleOverlayArgv,
  type ProviderRoleInvocationPort,
} from './project-orchestrate.js';
import { buildEnvironment, loadProfileFromCatalog, type LauncherProfile } from './profile.js';
import { assertReadOnlyArgv, buildRoleArgv } from './project-roles.js';

const MAX_EVIDENCE_BYTES_PER_FILE = 8_000;
const MAX_TOTAL_EVIDENCE_BYTES = 32_000;

/**
 * Conteúdo da evidência lido pelo CONTROL PLANE, não pelo agente: o
 * investigator recebe texto embutido no prompt, e não uma ferramenta de
 * leitura de arquivo arbitrária fora do repositório alvo. Isso preserva a
 * mesma fronteira de acesso do reviewer (cwd = repoRoot) sem precisar
 * expandi-la para o runtime dir do Lab.
 */
export async function readEvidenceForPrompt(evidencePaths: readonly string[]): Promise<string> {
  if (evidencePaths.length === 0) return '(nenhum evidence_path registrado)';
  let budget = MAX_TOTAL_EVIDENCE_BYTES;
  const blocks: string[] = [];
  for (const evidencePath of evidencePaths) {
    if (budget <= 0) {
      blocks.push('[orçamento de evidência esgotado; paths restantes omitidos]');
      break;
    }
    const resolved = path.resolve(evidencePath);
    try {
      const content = await readFile(resolved, 'utf8');
      const truncated =
        content.length > MAX_EVIDENCE_BYTES_PER_FILE
          ? `${content.slice(0, MAX_EVIDENCE_BYTES_PER_FILE)}\n...[truncado]`
          : content;
      const slice = truncated.slice(0, budget);
      blocks.push(`--- ${evidencePath} ---\n${slice}`);
      budget -= slice.length;
    } catch (error) {
      blocks.push(
        `--- ${evidencePath} ---\n[NÃO ENCONTRADO OU ILEGÍVEL: ${error instanceof Error ? error.message : String(error)}]`,
      );
    }
  }
  return blocks.join('\n\n');
}

export function buildIncidentInvestigatorPrompt(input: {
  readonly incident: RecoveryIncident;
  readonly evidenceText: string;
}): string {
  return [
    'Você é o INCIDENT INVESTIGATOR, SOMENTE LEITURA, do control plane do Agent Lab.',
    'Não edite arquivos, não faça commit, não execute comandos que alterem estado e não chame outro agente.',
    'Seu único produto é um diagnóstico factual em JSON — a correção, se houver, é aplicada por uma primitive',
    'oficial separada, nunca por você.',
    '',
    `INCIDENTE ${input.incident.incident_id} (fingerprint ${input.incident.fingerprint})`,
    `task_id: ${input.incident.task_id ?? 'desconhecida'}`,
    `blocker técnico registrado pelo lifecycle: ${input.incident.blocker}`,
    `motivo registrado pelo lifecycle: ${input.incident.reason}`,
    '',
    'EVIDÊNCIA (lida pelo control plane, embutida aqui — você não tem acesso a outros paths fora do repositório):',
    input.evidenceText,
    '',
    'Responda SOMENTE com um único JSON, exatamente neste formato:',
    '{"schema_version":1,',
    ' "classification":"TARGET_PROJECT|HARNESS|ENVIRONMENT|PROVIDER|MISSING_CONTEXT|HUMAN_DECISION",',
    ' "root_cause":"...",',
    ' "evidence":[{"path":"...","summary":"..."}],',
    ' "remediation":["passo 1","passo 2"],',
    ' "safe_within_current_authority":true|false,',
    ' "resume_strategy":"...",',
    ' "human_authority":"<presente e obrigatório SÓ quando classification=HUMAN_DECISION>"}',
    '',
    'Guia de classification:',
    '- TARGET_PROJECT: defeito no código/config do REPOSITÓRIO ALVO, corrigível por um repair já autorizado.',
    '- HARNESS: defeito no próprio Agent Lab (o harness que executa esta run), não no repositório alvo.',
    '- ENVIRONMENT: infraestrutura local/config do runtime, não código de produto.',
    '- PROVIDER: falha do provider/model externo.',
    '- MISSING_CONTEXT: a evidência necessária para diagnosticar está ausente ou inconsistente.',
    '- HUMAN_DECISION: exige decisão de produto/arquitetura/autorização que só um humano pode dar;',
    '  human_authority é OBRIGATÓRIO e precisa ser um valor REAL da lista fechada de autoridades humanas',
    '  do Agent Lab — nunca invente uma categoria nem deixe o campo genérico.',
    '',
    'safe_within_current_authority só pode ser true quando a correção cabe INTEIRAMENTE na autorização já',
    'concedida a esta run: sem publicar, sem nova credencial, sem expandir escopo, sem ação destrutiva.',
    'Se você não tem certeza de que a correção cabe, responda false — nunca advinhe a favor de progresso.',
  ].join('\n');
}

export type IncidentInvestigatorLaunchResult = IncidentInvestigationResult;

export interface IncidentInvestigatorLaunchOptions {
  readonly paths: HarnessPaths;
  readonly authorization: LoadedProjectRunAuthorization;
  readonly incident: RecoveryIncident;
  readonly maximumLaunches?: number;
  readonly port?: ProviderRoleInvocationPort;
  readonly probe?: PoolCapacityProbe;
}

/**
 * Failover simples entre os profiles JÁ autorizados para esta run (a mesma
 * `profile_policy` do projeto): nenhuma policy nova é aberta, e um role
 * read-only diagnóstico não precisa da diversidade cross-provider que o
 * reviewer exige. Cada profile tenta no máximo uma vez; falha de invocação ou
 * payload não-parseável passa para o próximo profile elegível.
 */
export async function launchIncidentInvestigator(
  options: IncidentInvestigatorLaunchOptions,
): Promise<IncidentInvestigatorLaunchResult> {
  const { paths, authorization, incident } = options;
  const probe = options.probe ?? createProductionPoolCapacityProbe({ paths });
  const port = options.port ?? createProviderRoleInvocationPort();
  const scope = ExecutionAuthorizationScope.parse({
    schema_version: 1,
    requested_scope: authorization.file.requested_scope,
    autonomous_execution_boundary: authorization.file.autonomous_execution_boundary,
    human_gated_capabilities: authorization.file.human_gated_capabilities,
  });
  const evidenceText = await readEvidenceForPrompt(incident.evidence_paths);
  const prompt = buildIncidentInvestigatorPrompt({ incident, evidenceText });
  const ceiling = machineSafetyCeiling();

  const reasons: string[] = [];
  const launches: InvestigatorLaunchEvidence[] = [];
  const maximumLaunches = options.maximumLaunches ?? Number.MAX_SAFE_INTEGER;
  for (const entry of authorization.file.profile_policy.profiles) {
    if (launches.length >= maximumLaunches) break;
    let profile: LauncherProfile;
    try {
      profile = await loadProfileFromCatalog(paths.profileCatalogRoot, entry.id);
    } catch (error) {
      reasons.push(`${entry.id}: catálogo ilegível — ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const capacityByPool = await observeEligiblePoolCapacities([profile], probe);
    const facts = await collectCurrentLaunchFacts({ paths, profile, probe, observed: capacityByPool });

    const authorized = authorizeProjectLaunch({
      scope,
      capability: 'CONFIGURED_SUBSCRIPTION_WORKER',
      billing_mode: profile.billing_mode,
      quota: facts.quota,
      credential: facts.credential,
      risk: 'low',
      worker_owns_commit: false,
      worker_owns_official_validation: false,
    });
    if (authorized.outcome !== 'ALLOW') {
      reasons.push(`${entry.id}: ${authorized.reason}`);
      continue;
    }

    const home = path.join(paths.devDir, 'incidents', incident.incident_id, 'homes', profile.id);
    await mkdir(home, { recursive: true });
    const env = buildEnvironment(profile, process.env, { sanitizedHome: home });
    assertNoApiCredentials(`preflight do incident investigator (${profile.id})`, env);
    const billing = await runBillingPreflight({
      agent: profile.agent,
      provider: profile.provider,
      billingMode: profile.billing_mode,
      binary: profile.argv[0] as string,
      env,
      orchestratorEnv: process.env,
    });
    if (!billing.ok) {
      reasons.push(`${entry.id}: billing preflight recusou — ${billing.refusal ?? 'motivo não informado'}`);
      continue;
    }

    let argv: readonly string[];
    let roleEnv: Readonly<Record<string, string | undefined>>;
    try {
      const overlay = buildRoleArgv(profile, { role: 'reviewer', prompt });
      assertReadOnlyArgv('reviewer', profile.agent, overlay.argv, overlay.env);
      argv = resolveRoleOverlayArgv(paths, overlay.argv);
      roleEnv = { ...env, ...overlay.env };
      assertReadOnlyArgv('reviewer', profile.agent, argv, roleEnv, {
        catalogRoot: paths.profileCatalogRoot,
        workerCwd: paths.repoRoot,
      });
    } catch (error) {
      reasons.push(`${entry.id}: overlay read-only recusado — ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    let stdout: string;
    try {
      stdout = await port.run({
        role: 'reviewer',
        profile,
        argv,
        prompt,
        cwd: paths.repoRoot,
        env: roleEnv,
        timeoutSeconds: ceiling.seconds,
      });
    } catch (error) {
      const detail =
        error instanceof ProviderRoleInvocationError
          ? `exit=${String(error.exitCode)} stderr=${error.stderr.slice(0, 300)}`
          : error instanceof Error
            ? error.message
            : String(error);
      reasons.push(`${entry.id}: invocação falhou — ${detail}`);
      launches.push({ schema_version: 1, profile_id: profile.id, outcome: 'INVOCATION_FAILED', detail });
      continue;
    }

    const extracted = extractRoleModelJson({ agent: profile.agent, argv, stdout });
    if (extracted.outcome !== 'EXTRACTED') {
      reasons.push(`${entry.id}: ${extracted.outcome} — ${extracted.message}`);
      launches.push({
        schema_version: 1, profile_id: profile.id, outcome: 'INVALID_OUTPUT',
        detail: `${extracted.outcome}: ${extracted.message}`,
      });
      continue;
    }
    const parsed = IncidentDiagnosis.safeParse(extracted.value);
    if (!parsed.success) {
      reasons.push(`${entry.id}: diagnóstico não passou no schema — ${parsed.error.message}`);
      launches.push({
        schema_version: 1, profile_id: profile.id, outcome: 'INVALID_OUTPUT',
        detail: `diagnóstico não passou no schema: ${parsed.error.message}`,
      });
      continue;
    }
    launches.push({ schema_version: 1, profile_id: profile.id, outcome: 'DIAGNOSED' });
    return { outcome: 'DIAGNOSED', diagnosis: parsed.data, launches };
  }

  return {
    outcome: 'UNAVAILABLE',
    launches,
    reason:
      reasons.length === 0
        ? 'nenhum profile elegível na profile_policy desta run'
        : `nenhum profile produziu diagnóstico válido: ${reasons.join(' | ')}`,
  };
}

export function createDefaultIncidentInvestigatorPort(options: {
  readonly paths: HarnessPaths;
  readonly authorization: LoadedProjectRunAuthorization;
  readonly port?: ProviderRoleInvocationPort;
  readonly probe?: PoolCapacityProbe;
}): IncidentInvestigatorPort {
  return {
    async investigate({ incident, maximumLaunches }) {
      return launchIncidentInvestigator({ ...options, incident, maximumLaunches });
    },
  };
}
