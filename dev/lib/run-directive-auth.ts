import type { AutonomousExecutionCapability } from '../../src/intake/index.js';
import {
  DirectiveNeverGrantablePermission,
  RunDirectiveError,
  type AgentLabRunDirectiveHeader,
  type DirectivePermission,
  type DirectivePermissionMap,
  type DirectivePublishGrant,
} from '../../src/intake/run-directive.js';
import type { ProjectRunAuthorizationFile as AuthorizationFile } from './project-authorization.js';

export interface ResolvedPublishGrant {
  readonly allowed: boolean;
  readonly remote: string;
  readonly ref: string;
}

const GRANTABLE_TO_BOUNDARY: Readonly<
  Record<
    'local_repository_write' | 'dependency_network' | 'subscription_workers' | 'deterministic_validation' | 'bounded_repair' | 'capability_escalation' | 'cross_provider' | 'local_git_commits',
    AutonomousExecutionCapability
  >
> = {
  local_repository_write: 'DISPOSABLE_LOCAL_WORKSPACE',
  dependency_network: 'DISPOSABLE_LOCAL_WORKSPACE',
  local_git_commits: 'DISPOSABLE_LOCAL_WORKSPACE',
  subscription_workers: 'CONFIGURED_SUBSCRIPTION_WORKER',
  deterministic_validation: 'DETERMINISTIC_VALIDATION',
  bounded_repair: 'BOUNDED_REPAIR',
  capability_escalation: 'CAPABILITY_ESCALATION_WITHIN_LADDER',
  cross_provider: 'CROSS_PROVIDER_WITHIN_ALLOWED_SUBSCRIPTION_PROFILES',
};

const NEVER_GRANTABLE = new Set<string>(DirectiveNeverGrantablePermission.options);

function permissionEntries(map: DirectivePermissionMap | undefined): ReadonlyArray<readonly [DirectivePermission, boolean]> {
  if (map === undefined) return [];
  return (Object.entries(map) as Array<[DirectivePermission, boolean | undefined]>).filter(
    (entry): entry is [DirectivePermission, boolean] => entry[1] !== undefined,
  );
}

function uniqueBoundary(
  values: readonly AutonomousExecutionCapability[],
): AutonomousExecutionCapability[] {
  return [...new Set(values)];
}

/**
 * Overlay do header sobre o preset. Texto livre não entra aqui.
 * allow+deny no mesmo nome falha fechado. Categoria never-grantable em
 * allow=true falha fechado — a política do produto não a concede pelo header.
 */
export function overlayAuthorization(input: {
  readonly preset: AuthorizationFile;
  readonly header: AgentLabRunDirectiveHeader | null;
}): AuthorizationFile {
  const allow = input.header?.authorization?.allow;
  const deny = input.header?.authorization?.deny;
  let boundary = [...input.preset.autonomous_execution_boundary];

  for (const [name, granted] of permissionEntries(allow)) {
    const denied = deny?.[name];
    if (denied === true && granted === true) {
      throw new RunDirectiveError(
        `Run Directive conflitante: authorization.allow.${name} e authorization.deny.${name} estão ambos true.`,
      );
    }
    if (!granted) continue;
    if (NEVER_GRANTABLE.has(name)) {
      throw new RunDirectiveError(
        `a política do produto não permite conceder ${name} só pelo header da Run Directive. Esta categoria continua human-gated.`,
      );
    }
    const capability = GRANTABLE_TO_BOUNDARY[name as keyof typeof GRANTABLE_TO_BOUNDARY];
    if (capability !== undefined && !boundary.includes(capability)) {
      boundary = uniqueBoundary([...boundary, capability]);
    }
  }

  for (const [name, denied] of permissionEntries(deny)) {
    if (!denied) continue;
    const capability = GRANTABLE_TO_BOUNDARY[name as keyof typeof GRANTABLE_TO_BOUNDARY];
    if (capability !== undefined) {
      boundary = boundary.filter((entry) => entry !== capability);
    }
  }

  if (boundary.length === 0) {
    throw new RunDirectiveError(
      'Run Directive inválida: o deny do header deixaria o boundary autônomo vazio.',
    );
  }

  return {
    ...input.preset,
    autonomous_execution_boundary: boundary,
  };
}

export function resolveDirectivePublishGrant(input: {
  readonly header: AgentLabRunDirectiveHeader | null;
  readonly cliPublish?: boolean;
}): ResolvedPublishGrant {
  const publish = input.header?.authorization?.publish;
  const allowOrigin = input.header?.authorization?.allow?.publish_origin;
  const denyOrigin = input.header?.authorization?.deny?.publish_origin;

  let allowed = false;
  let remote = 'origin';
  let ref = 'main';

  if (publish !== undefined) {
    allowed = publish.allowed;
    remote = publish.remote ?? remote;
    ref = publish.ref ?? ref;
  }
  if (allowOrigin === true) allowed = true;
  if (denyOrigin === true) allowed = false;
  if (publish?.allowed === true && denyOrigin === true) {
    throw new RunDirectiveError(
      'Run Directive conflitante: authorization.publish.allowed=true e authorization.deny.publish_origin=true.',
    );
  }
  if (publish?.allowed === false && allowOrigin === true) {
    throw new RunDirectiveError(
      'Run Directive conflitante: authorization.publish.allowed=false e authorization.allow.publish_origin=true.',
    );
  }

  if (input.cliPublish === true && (publish?.allowed === false || denyOrigin === true)) {
    throw new RunDirectiveError(
      'conflito: --publish tenta conceder publicação e a Run Directive a nega. Nenhuma tem precedência silenciosa.',
    );
  }
  if (input.cliPublish === true && publish === undefined && denyOrigin !== true) {
    allowed = true;
  }

  return { allowed, remote, ref };
}

export function snapshotHasCapability(
  file: AuthorizationFile,
  capability: AutonomousExecutionCapability,
): boolean {
  return file.autonomous_execution_boundary.includes(capability);
}

export function resolvedPublishLabel(grant: ResolvedPublishGrant): string {
  return grant.allowed ? `${grant.remote}/${grant.ref}` : 'denied';
}
