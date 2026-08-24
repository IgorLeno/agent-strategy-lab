import { createHash } from 'node:crypto';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * Texto canônico da Run Directive: UTF-8, sem BOM, newlines normalizados
 * para `\n`. O hash e a persistência usam exatamente estes bytes.
 */
export function normalizeDirectiveText(raw: string): string {
  return raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function runDirectiveHash(raw: string): string {
  return createHash('sha256').update(normalizeDirectiveText(raw), 'utf8').digest('hex');
}

/**
 * Guard de produto para o TAMANHO da Run Directive — política de input, não
 * bound incidental de packet. 256 KiB (~64k tokens) cabe com folga na janela
 * dos providers de planning suportados e mantém prompt + packet dentro de um
 * único launch. Estourou: falha explícita ANTES de persistência e de qualquer
 * provider; nunca truncation silenciosa.
 */
export const MAX_RUN_DIRECTIVE_BYTES = 256 * 1024;

export class RunDirectiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunDirectiveError';
  }
}

const nonEmpty = z.string().trim().min(1);

export const DirectiveGrantablePermission = z.enum([
  'local_repository_write',
  'dependency_network',
  'subscription_workers',
  'deterministic_validation',
  'bounded_repair',
  'capability_escalation',
  'cross_provider',
  'local_git_commits',
  'self_integration',
  'publish_origin',
]);
export type DirectiveGrantablePermission = z.infer<typeof DirectiveGrantablePermission>;

export const DirectiveNeverGrantablePermission = z.enum([
  'api_billing',
  'new_credentials',
  'deployment',
  'production_changes',
  'destructive_actions',
  'unrelated_external_effects',
]);
export type DirectiveNeverGrantablePermission = z.infer<typeof DirectiveNeverGrantablePermission>;

export const DirectivePermission = z.enum([
  ...DirectiveGrantablePermission.options,
  ...DirectiveNeverGrantablePermission.options,
]);
export type DirectivePermission = z.infer<typeof DirectivePermission>;

const DirectivePermissionMap = z
  .object({
    local_repository_write: z.boolean().optional(),
    dependency_network: z.boolean().optional(),
    subscription_workers: z.boolean().optional(),
    deterministic_validation: z.boolean().optional(),
    bounded_repair: z.boolean().optional(),
    capability_escalation: z.boolean().optional(),
    cross_provider: z.boolean().optional(),
    local_git_commits: z.boolean().optional(),
    self_integration: z.boolean().optional(),
    publish_origin: z.boolean().optional(),
    api_billing: z.boolean().optional(),
    new_credentials: z.boolean().optional(),
    deployment: z.boolean().optional(),
    production_changes: z.boolean().optional(),
    destructive_actions: z.boolean().optional(),
    unrelated_external_effects: z.boolean().optional(),
  })
  .strict();
export type DirectivePermissionMap = z.infer<typeof DirectivePermissionMap>;

export const DirectivePublishGrant = z
  .object({
    allowed: z.boolean(),
    remote: nonEmpty.optional(),
    ref: nonEmpty.optional(),
  })
  .strict();
export type DirectivePublishGrant = z.infer<typeof DirectivePublishGrant>;

export const DirectiveTarget = z.discriminatedUnion('type', [
  z.object({ type: z.literal('self') }).strict(),
  z
    .object({
      type: z.literal('repository'),
      path: nonEmpty,
    })
    .strict(),
]);
export type DirectiveTarget = z.infer<typeof DirectiveTarget>;

export const DirectiveExecution = z
  .object({
    mode: z.enum(['new', 'resume']).optional(),
    autonomy: z.literal('routine').optional(),
    runtime: nonEmpty.optional(),
  })
  .strict();
export type DirectiveExecution = z.infer<typeof DirectiveExecution>;

export const DirectiveAuthorization = z
  .object({
    preset: nonEmpty.optional(),
    allow: DirectivePermissionMap.optional(),
    deny: DirectivePermissionMap.optional(),
    publish: DirectivePublishGrant.optional(),
  })
  .strict();
export type DirectiveAuthorization = z.infer<typeof DirectiveAuthorization>;

export const AgentLabRunDirectiveHeader = z
  .object({
    version: z.literal(1),
    target: DirectiveTarget.optional(),
    execution: DirectiveExecution.optional(),
    authorization: DirectiveAuthorization.optional(),
    providers: z
      .object({
        policy: z.literal('default').optional(),
      })
      .strict()
      .optional(),
    stop: z.array(nonEmpty).optional(),
  })
  .strict();
export type AgentLabRunDirectiveHeader = z.infer<typeof AgentLabRunDirectiveHeader>;

export interface ParsedRunDirective {
  readonly raw: string;
  readonly hash: string;
  readonly body: string;
  readonly header: AgentLabRunDirectiveHeader | null;
}

const OPEN_LINE = '---agentlab';
const CLOSE_LINE = '---';

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(raiz)'}: ${issue.message}`)
    .join('; ');
}

function extractFrontmatter(normalized: string): { readonly yaml: string; readonly body: string } | null {
  const lines = normalized.split('\n');
  const first = lines[0]?.trim();
  if (first !== OPEN_LINE) return null;
  const closeIndex = lines.findIndex((line, index) => index > 0 && line.trim() === CLOSE_LINE);
  if (closeIndex < 0) {
    throw new RunDirectiveError(
      'Run Directive malformada: o header ---agentlab não tem o fechamento ---.\nNenhum provider será chamado.',
    );
  }
  return {
    yaml: lines.slice(1, closeIndex).join('\n'),
    body: lines.slice(closeIndex + 1).join('\n'),
  };
}

/**
 * Parser determinístico. Não chama modelo e não "conserta" autorização.
 * Ausência do marcador ---agentlab é o formato legado (corpo inteiro).
 */
export function parseRunDirective(raw: string): ParsedRunDirective {
  const normalized = normalizeDirectiveText(raw);
  if (normalized.trim().length === 0) {
    throw new RunDirectiveError('a Run Directive está vazia.');
  }

  const bytes = Buffer.byteLength(normalized, 'utf8');
  if (bytes > MAX_RUN_DIRECTIVE_BYTES) {
    throw new RunDirectiveError(
      `a Run Directive tem ${bytes} bytes e excede o limite de produto de ${MAX_RUN_DIRECTIVE_BYTES} bytes ` +
        '(guard de input do Agent Lab, não um limite de packet). Nada foi truncado e nenhum provider será chamado. ' +
        'Divida a instrução ou remova conteúdo colado que não é instrução (logs extensos, transcripts).',
    );
  }

  const firstLine = normalized.split('\n', 1)[0]?.trim() ?? '';
  if (firstLine.startsWith('---agentlab') && firstLine !== OPEN_LINE) {
    throw new RunDirectiveError(
      `Run Directive malformada: a primeira linha deve ser exatamente ---agentlab (recebido ${JSON.stringify(firstLine)}).`,
    );
  }

  const frontmatter = extractFrontmatter(normalized);
  if (frontmatter === null) {
    return {
      raw: normalized,
      hash: runDirectiveHash(normalized),
      body: normalized,
      header: null,
    };
  }

  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(frontmatter.yaml) ?? {};
  } catch (error) {
    throw new RunDirectiveError(
      `Run Directive malformada: YAML do header inválido: ${error instanceof Error ? error.message : String(error)}\nNenhum provider será chamado.`,
    );
  }

  const header = AgentLabRunDirectiveHeader.safeParse(parsedYaml);
  if (!header.success) {
    throw new RunDirectiveError(
      `Run Directive malformada: ${describeIssues(header.error)}\nNenhum provider será chamado.`,
    );
  }

  if (frontmatter.body.trim().length === 0) {
    throw new RunDirectiveError('Run Directive malformada: o corpo da instrução humana está vazio.');
  }

  return {
    raw: normalized,
    hash: runDirectiveHash(normalized),
    body: frontmatter.body,
    header: header.data,
  };
}
