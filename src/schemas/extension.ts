import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';

const identifier = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'id deve ser alfanumérico com - ou _');
const nonEmpty = z.string().trim().min(1);

export const ExtensionKind = z.enum([
  'strategy',
  'skill',
  'hook',
  'mcp',
  'review_protocol',
  'provider_integration',
]);
export type ExtensionKind = z.infer<typeof ExtensionKind>;

/**
 * Identidade e configuração de uma extensão: imutável e versionada. Não tem
 * nenhum campo de lifecycle/status de propósito — mudar o estado de
 * incubação nunca deve poder alterar o manifest nem seu hash canônico.
 */
export const ExtensionManifest = z
  .object({
    kind: ExtensionKind,
    name: identifier,
    version: z.number().int().positive(),
    description: nonEmpty,
    requires: z.array(nonEmpty).optional(),
  })
  .strict();
export type ExtensionManifest = z.infer<typeof ExtensionManifest>;

export const IncubationStatus = z.enum([
  'DISCOVERED',
  'CANDIDATE',
  'SANDBOXED',
  'BENCHMARKED',
  'PROMOTED',
]);
export type IncubationStatus = z.infer<typeof IncubationStatus>;

/**
 * Estado mutável de incubação, guardado em arquivo próprio (`incubation.yaml`)
 * separado do manifest. Referencia a identidade kind/name/version do
 * manifest para que um arquivo movido ou copiado não se aplique a outra
 * extensão silenciosamente.
 */
export const IncubationState = z
  .object({
    status: IncubationStatus,
    updated_at: z.string().datetime(),
    kind: ExtensionKind,
    name: identifier,
    version: z.number().int().positive(),
  })
  .strict();
export type IncubationState = z.infer<typeof IncubationState>;

export interface Extension {
  readonly manifest: ExtensionManifest;
  readonly incubation: IncubationState;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/**
 * Carrega uma extensão em
 * `extensions/<kind>/<nome>/<versão>/extension.yaml`. A identidade é
 * conferida contra o caminho solicitado, como em `loadStrategy`. Se
 * `incubation.yaml` existir no mesmo diretório, o estado é validado contra a
 * mesma identidade; se não existir, o estado default `DISCOVERED` é apenas
 * reportado em memória — nada é gravado em disco.
 */
export async function loadExtension(
  repoRoot: string,
  kind: ExtensionKind,
  name: string,
  version: number,
): Promise<Extension> {
  const requested = ExtensionManifest.pick({ kind: true, name: true, version: true }).parse({
    kind,
    name,
    version,
  });
  const directory = path.join(
    repoRoot,
    'extensions',
    requested.kind,
    requested.name,
    String(requested.version),
  );
  const manifestFile = path.join(directory, 'extension.yaml');
  const manifest = ExtensionManifest.parse(parseYaml(await readFile(manifestFile, 'utf8')));

  if (
    manifest.kind !== requested.kind ||
    manifest.name !== requested.name ||
    manifest.version !== requested.version
  ) {
    throw new Error(
      `extensão ${manifestFile} declara ${manifest.kind}/${manifest.name}@${manifest.version}, ` +
        `esperado ${requested.kind}/${requested.name}@${requested.version}`,
    );
  }

  const incubationFile = path.join(directory, 'incubation.yaml');
  let incubationSource: string;
  try {
    incubationSource = await readFile(incubationFile, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return {
        manifest,
        incubation: {
          status: 'DISCOVERED',
          updated_at: new Date().toISOString(),
          kind: manifest.kind,
          name: manifest.name,
          version: manifest.version,
        },
      };
    }
    throw error;
  }

  const incubation = IncubationState.parse(parseYaml(incubationSource));
  if (
    incubation.kind !== manifest.kind ||
    incubation.name !== manifest.name ||
    incubation.version !== manifest.version
  ) {
    throw new Error(
      `estado de incubação ${incubationFile} declara ${incubation.kind}/${incubation.name}@${incubation.version}, ` +
        `esperado ${manifest.kind}/${manifest.name}@${manifest.version}`,
    );
  }

  return { manifest, incubation };
}
