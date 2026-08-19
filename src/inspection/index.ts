/**
 * Inspeção READ-ONLY de um repositório-alvo já clonado (ver
 * `src/workspace/clone.ts`). Produz um `ProjectInspection`: os fatos que o
 * control plane precisa para planejar, montar contexto proporcional e depois
 * derivar environment readiness.
 *
 * Fronteira: este módulo só lê. Nenhuma função aqui escreve, cria branch,
 * executa comando de validação descoberto ou chama provider — a montagem de
 * prompt e a decisão de o que rodar são responsabilidade de quem consome o
 * `ProjectInspection`, não deste inspetor.
 *
 * Fato ausente vira `{ known: false, value: null, reason, provenance }`,
 * nunca um valor inventado, zero ou "READY" por omissão — quem consome
 * precisa poder distinguir "não sei" de "sei que não tem".
 *
 * Reusa `gitOrThrow` e `isInside` de `src/workspace/clone.ts`: nenhum
 * spawner de git novo, nenhuma checagem de contenção de caminho nova.
 */

import { access, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { gitOrThrow, isInside, resolveIntendedPath } from '../workspace/clone.js';

const nonEmpty = z.string().trim().min(1);

// ---------------------------------------------------------------------------
// Fato: valor conhecido com proveniência, ou `null` com motivo e proveniência.
// ---------------------------------------------------------------------------

function knownFactSchema<T extends z.ZodTypeAny>(valueSchema: T) {
  return z
    .object({
      known: z.literal(true),
      value: valueSchema,
      provenance: nonEmpty,
    })
    .strict();
}

const UnknownFactSchema = z
  .object({
    known: z.literal(false),
    value: z.null(),
    reason: nonEmpty,
    provenance: nonEmpty,
  })
  .strict();

function factSchema<T extends z.ZodTypeAny>(valueSchema: T) {
  return z.discriminatedUnion('known', [knownFactSchema(valueSchema), UnknownFactSchema]);
}

export type Fact<T> =
  | { readonly known: true; readonly value: T; readonly provenance: string }
  | { readonly known: false; readonly value: null; readonly reason: string; readonly provenance: string };

function known<T>(value: T, provenance: string): Fact<T> {
  return { known: true, value, provenance };
}

function unknown<T>(reason: string, provenance: string): Fact<T> {
  return { known: false, value: null, reason, provenance };
}

// ---------------------------------------------------------------------------
// Schemas de valor
// ---------------------------------------------------------------------------

const GitStateSchema = z
  .object({
    head_sha: nonEmpty,
    branch: nonEmpty.nullable(),
    dirty: z.boolean(),
    remotes: z.array(nonEmpty),
  })
  .strict();
export type GitState = z.infer<typeof GitStateSchema>;

const StackSchema = z
  .object({
    primary_ecosystem: nonEmpty,
    ecosystems_detected: z.array(nonEmpty).min(1),
  })
  .strict();
export type Stack = z.infer<typeof StackSchema>;

const DependenciesStateSchema = z
  .object({
    lockfile_path: nonEmpty.nullable(),
    installed: z.boolean(),
  })
  .strict();
export type DependenciesState = z.infer<typeof DependenciesStateSchema>;

const FilesystemPermissionsSchema = z
  .object({
    readable: z.boolean(),
    writable: z.boolean(),
  })
  .strict();
export type FilesystemPermissions = z.infer<typeof FilesystemPermissionsSchema>;

const DirectoryEntrySchema = z
  .object({
    path: nonEmpty,
    role: z.enum(['source', 'tests', 'docs', 'ci', 'config', 'other']),
  })
  .strict();
export type DirectoryEntry = z.infer<typeof DirectoryEntrySchema>;

const TestsInfoSchema = z
  .object({
    framework: nonEmpty.nullable(),
    test_directories: z.array(nonEmpty),
  })
  .strict();
export type TestsInfo = z.infer<typeof TestsInfoSchema>;

const ValidationCommandCandidateSchema = z
  .object({
    name: nonEmpty,
    command: nonEmpty,
    source: nonEmpty,
  })
  .strict();
export type ValidationCommandCandidate = z.infer<typeof ValidationCommandCandidateSchema>;

const RequiredToolSchema = z
  .object({
    name: nonEmpty,
    reason: nonEmpty,
    source: nonEmpty,
  })
  .strict();
export type RequiredTool = z.infer<typeof RequiredToolSchema>;

const RequiredServiceSchema = z
  .object({
    name: nonEmpty,
    reason: nonEmpty,
    source: nonEmpty,
  })
  .strict();
export type RequiredService = z.infer<typeof RequiredServiceSchema>;

const FeedbackSourceSchema = z
  .object({
    path: nonEmpty,
    kind: z.enum(['ci', 'changelog', 'logging_config', 'other']),
  })
  .strict();
export type FeedbackSource = z.infer<typeof FeedbackSourceSchema>;

/**
 * Entrada do mapa de instruções do projeto: só caminho, escopo e relevância
 * aparente (deduzida do nome/posição do arquivo). Nunca o conteúdo — montar
 * o prompt com esse conteúdo é responsabilidade de quem consome este mapa.
 */
const ProjectInstructionRefSchema = z
  .object({
    path: nonEmpty,
    scope: z.enum(['root', 'module']),
    relevance: z.enum(['architecture', 'contribution', 'build', 'ci', 'general']),
  })
  .strict();
export type ProjectInstructionRef = z.infer<typeof ProjectInstructionRefSchema>;

/** Âncora de área para montagem posterior de contexto proporcional — caminho, não conteúdo. */
const SourceAnchorSchema = z
  .object({
    area: nonEmpty,
    path: nonEmpty,
  })
  .strict();
export type SourceAnchor = z.infer<typeof SourceAnchorSchema>;

export const ProjectInspection = z
  .object({
    schema_version: z.literal(1),
    repo_root: nonEmpty,
    inspected_at: nonEmpty,
    git: factSchema(GitStateSchema),
    stack: factSchema(StackSchema),
    package_manager: factSchema(nonEmpty),
    build_system: factSchema(nonEmpty),
    directories: z.array(DirectoryEntrySchema),
    tests: factSchema(TestsInfoSchema),
    validation_command_candidates: z.array(ValidationCommandCandidateSchema),
    dependencies_state: factSchema(DependenciesStateSchema),
    required_tools: z.array(RequiredToolSchema),
    required_services: z.array(RequiredServiceSchema),
    filesystem_permissions: factSchema(FilesystemPermissionsSchema),
    feedback_sources: z.array(FeedbackSourceSchema),
    project_instructions: z.array(ProjectInstructionRefSchema),
    source_anchors: z.array(SourceAnchorSchema),
    relevant_files: z.array(nonEmpty),
    risks: z.array(nonEmpty),
  })
  .strict();
export type ProjectInspection = z.infer<typeof ProjectInspection>;

export interface InspectRepositoryOptions {
  /** Raiz do repositório-alvo a inspecionar. Só é lida. */
  readonly repoRoot: string;
  /** Injetável para determinismo em teste; default `() => new Date()`. */
  readonly now?: () => Date;
}

// ---------------------------------------------------------------------------
// Leitura contida — nenhum caminho resolvido pode escapar de `repoRoot`.
// ---------------------------------------------------------------------------

interface ContainedFs {
  readonly repoRoot: string;
  readFile(relativePath: string): Promise<string | null>;
  readdir(relativePath: string): Promise<string[] | null>;
  isDirectory(relativePath: string): Promise<boolean>;
  exists(relativePath: string): Promise<boolean>;
  /** true quando o alvo real (symlink resolvido) permanece dentro de `repoRoot`. */
  isContained(relativePath: string): Promise<boolean>;
}

/**
 * `resolveIntendedPath` resolve os symlinks do trecho que já existe do
 * caminho antes de `isInside` decidir a fronteira — sem isso, um symlink
 * dentro do repositório apontando para fora seria lido como se estivesse
 * contido, porque `path.resolve` sozinho não enxerga o alvo do link.
 */
async function createContainedFs(repoRoot: string): Promise<ContainedFs> {
  const repoRootResolved = await realpath(repoRoot);

  async function resolveContained(relativePath: string): Promise<string | null> {
    const target = path.resolve(repoRootResolved, relativePath);
    const resolved = await resolveIntendedPath(target);
    return isInside(repoRootResolved, resolved) ? resolved : null;
  }

  return {
    repoRoot: repoRootResolved,
    async readFile(relativePath) {
      const resolved = await resolveContained(relativePath);
      if (resolved === null) return null;
      try {
        return await readFile(resolved, 'utf8');
      } catch {
        return null;
      }
    },
    async readdir(relativePath) {
      const resolved = await resolveContained(relativePath);
      if (resolved === null) return null;
      try {
        return await readdir(resolved);
      } catch {
        return null;
      }
    },
    async isDirectory(relativePath) {
      const resolved = await resolveContained(relativePath);
      if (resolved === null) return false;
      try {
        return (await stat(resolved)).isDirectory();
      } catch {
        return false;
      }
    },
    async exists(relativePath) {
      const resolved = await resolveContained(relativePath);
      if (resolved === null) return false;
      try {
        await access(resolved);
        return true;
      } catch {
        return false;
      }
    },
    async isContained(relativePath) {
      return (await resolveContained(relativePath)) !== null;
    },
  };
}

// ---------------------------------------------------------------------------
// Git state — via gitOrThrow existente, nunca spawner novo.
// ---------------------------------------------------------------------------

async function inspectGit(repoRoot: string): Promise<Fact<GitState>> {
  try {
    const headSha = (await gitOrThrow(repoRoot, ['rev-parse', 'HEAD'])).trim();
    const branchRaw = (await gitOrThrow(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const status = await gitOrThrow(repoRoot, ['status', '--porcelain']);
    const remotesRaw = (await gitOrThrow(repoRoot, ['remote'])).trim();

    const branch = branchRaw === 'HEAD' ? null : branchRaw;
    const remotes = remotesRaw === '' ? [] : remotesRaw.split('\n');

    return known(
      { head_sha: headSha, branch, dirty: status.trim() !== '', remotes },
      'git:rev-parse+status+remote',
    );
  } catch (error) {
    return unknown(
      `repositório git ilegível em ${repoRoot}: ${(error as Error).message}`,
      'git:rev-parse',
    );
  }
}

// ---------------------------------------------------------------------------
// Stack, package manager, build system — a partir de arquivos de ecossistema.
// ---------------------------------------------------------------------------

interface EcosystemMarker {
  readonly ecosystem: string;
  readonly markerFile: string;
}

const ECOSYSTEM_MARKERS: readonly EcosystemMarker[] = [
  { ecosystem: 'node', markerFile: 'package.json' },
  { ecosystem: 'python', markerFile: 'pyproject.toml' },
  { ecosystem: 'python', markerFile: 'requirements.txt' },
  { ecosystem: 'go', markerFile: 'go.mod' },
  { ecosystem: 'rust', markerFile: 'Cargo.toml' },
  { ecosystem: 'java-maven', markerFile: 'pom.xml' },
  { ecosystem: 'java-gradle', markerFile: 'build.gradle' },
  { ecosystem: 'ruby', markerFile: 'Gemfile' },
];

const LOCKFILE_TO_PACKAGE_MANAGER: ReadonlyMap<string, string> = new Map([
  ['pnpm-lock.yaml', 'pnpm'],
  ['package-lock.json', 'npm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['poetry.lock', 'poetry'],
  ['Cargo.lock', 'cargo'],
  ['go.sum', 'go'],
]);

interface PackageJsonShape {
  readonly name?: unknown;
  readonly scripts?: Record<string, unknown>;
  readonly dependencies?: Record<string, unknown>;
  readonly devDependencies?: Record<string, unknown>;
  readonly engines?: Record<string, unknown>;
}

async function readPackageJson(fs: ContainedFs): Promise<PackageJsonShape | null> {
  const raw = await fs.readFile('package.json');
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as PackageJsonShape) : null;
  } catch {
    return null;
  }
}

async function detectEcosystems(fs: ContainedFs): Promise<string[]> {
  const found: string[] = [];
  for (const marker of ECOSYSTEM_MARKERS) {
    if (await fs.exists(marker.markerFile)) {
      if (!found.includes(marker.ecosystem)) found.push(marker.ecosystem);
    }
  }
  return found;
}

async function inspectStack(fs: ContainedFs): Promise<Fact<Stack>> {
  const ecosystems = await detectEcosystems(fs);
  if (ecosystems.length === 0) {
    return unknown('nenhum arquivo de manifesto de ecossistema conhecido na raiz', 'fs:markers');
  }
  const primary = ecosystems[0];
  if (primary === undefined) {
    return unknown('nenhum arquivo de manifesto de ecossistema conhecido na raiz', 'fs:markers');
  }
  return known(
    { primary_ecosystem: primary, ecosystems_detected: ecosystems },
    'fs:markers',
  );
}

async function detectLockfile(fs: ContainedFs): Promise<{ path: string; manager: string } | null> {
  for (const [lockfile, manager] of LOCKFILE_TO_PACKAGE_MANAGER) {
    if (await fs.exists(lockfile)) return { path: lockfile, manager };
  }
  return null;
}

async function inspectPackageManager(fs: ContainedFs): Promise<Fact<string>> {
  const lockfile = await detectLockfile(fs);
  if (lockfile === null) {
    return unknown('nenhum lockfile conhecido encontrado na raiz', 'fs:lockfile');
  }
  return known(lockfile.manager, `fs:${lockfile.path}`);
}

async function inspectBuildSystem(fs: ContainedFs): Promise<Fact<string>> {
  if (await fs.exists('tsconfig.json')) return known('typescript', 'fs:tsconfig.json');
  const pkg = await readPackageJson(fs);
  if (pkg !== null) return known('node-package-scripts', 'fs:package.json');
  if (await fs.exists('Cargo.toml')) return known('cargo', 'fs:Cargo.toml');
  if (await fs.exists('go.mod')) return known('go-build', 'fs:go.mod');
  if (await fs.exists('pyproject.toml')) return known('python-pyproject', 'fs:pyproject.toml');
  return unknown('nenhum indicador de build system conhecido na raiz', 'fs:markers');
}

// ---------------------------------------------------------------------------
// Diretórios e testes.
// ---------------------------------------------------------------------------

const DIRECTORY_ROLE_BY_NAME: Readonly<Record<string, DirectoryEntry['role']>> = {
  src: 'source',
  lib: 'source',
  app: 'source',
  test: 'tests',
  tests: 'tests',
  __tests__: 'tests',
  spec: 'tests',
  docs: 'docs',
  doc: 'docs',
  '.github': 'ci',
  scripts: 'config',
  config: 'config',
};

const IGNORED_TOP_LEVEL_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

async function inspectDirectories(fs: ContainedFs): Promise<DirectoryEntry[]> {
  const entries = await fs.readdir('.');
  if (entries === null) return [];

  const directories: DirectoryEntry[] = [];
  for (const entry of entries) {
    if (IGNORED_TOP_LEVEL_DIRECTORIES.has(entry)) continue;
    if (!(await fs.isDirectory(entry))) continue;
    directories.push({ path: entry, role: DIRECTORY_ROLE_BY_NAME[entry] ?? 'other' });
  }
  return directories;
}

const TEST_FRAMEWORK_DEV_DEPENDENCIES = ['vitest', 'jest', 'mocha', 'ava', 'jasmine'];

async function inspectTests(fs: ContainedFs, directories: readonly DirectoryEntry[]): Promise<Fact<TestsInfo>> {
  const testDirectories = directories.filter((entry) => entry.role === 'tests').map((entry) => entry.path);
  const pkg = await readPackageJson(fs);
  const devDeps = pkg?.devDependencies ?? {};
  const framework = TEST_FRAMEWORK_DEV_DEPENDENCIES.find((name) => name in devDeps) ?? null;

  if (testDirectories.length === 0 && framework === null) {
    return unknown('nenhum diretório de teste nem framework de teste detectado', 'fs:directories+package.json');
  }
  return known({ framework, test_directories: testDirectories }, 'fs:directories+package.json');
}

// ---------------------------------------------------------------------------
// Comandos de validação candidatos — apenas listados, nunca executados aqui.
// ---------------------------------------------------------------------------

const CANDIDATE_SCRIPT_NAMES = ['test', 'build', 'lint', 'typecheck', 'check'];

async function inspectValidationCommandCandidates(
  fs: ContainedFs,
): Promise<ValidationCommandCandidate[]> {
  const pkg = await readPackageJson(fs);
  if (pkg?.scripts === undefined) return [];

  const candidates: ValidationCommandCandidate[] = [];
  for (const scriptName of CANDIDATE_SCRIPT_NAMES) {
    const command = pkg.scripts[scriptName];
    if (typeof command === 'string' && command.trim() !== '') {
      candidates.push({ name: scriptName, command, source: 'package.json:scripts' });
    }
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Dependências, ferramentas, serviços.
// ---------------------------------------------------------------------------

async function inspectDependenciesState(fs: ContainedFs): Promise<Fact<DependenciesState>> {
  const lockfile = await detectLockfile(fs);
  const installed = await fs.isDirectory('node_modules');
  if (lockfile === null && !installed) {
    return unknown('nenhum lockfile e nenhum diretório de dependências instaladas encontrado', 'fs:lockfile+node_modules');
  }
  return known({ lockfile_path: lockfile?.path ?? null, installed }, 'fs:lockfile+node_modules');
}

async function inspectRequiredTools(fs: ContainedFs): Promise<RequiredTool[]> {
  const tools: RequiredTool[] = [];
  const pkg = await readPackageJson(fs);
  const nodeEngine = pkg?.engines?.['node'];
  if (typeof nodeEngine === 'string' && nodeEngine.trim() !== '') {
    tools.push({ name: `node ${nodeEngine}`, reason: 'engines.node declarado', source: 'package.json:engines' });
  }
  if (await fs.exists('Dockerfile')) {
    tools.push({ name: 'docker', reason: 'Dockerfile presente na raiz', source: 'fs:Dockerfile' });
  }
  if (await fs.exists('.nvmrc')) {
    const version = (await fs.readFile('.nvmrc'))?.trim();
    if (version !== undefined && version !== '') {
      tools.push({ name: `node ${version}`, reason: '.nvmrc presente na raiz', source: 'fs:.nvmrc' });
    }
  }
  return tools;
}

/** Padrões de nome de variável de ambiente que sugerem um serviço externo requerido. */
const ENV_VAR_SERVICE_HINTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/DATABASE_URL|POSTGRES|MYSQL/i, 'banco de dados relacional'],
  [/REDIS/i, 'redis'],
  [/MONGO/i, 'mongodb'],
  [/KAFKA/i, 'kafka'],
];

async function inspectRequiredServices(fs: ContainedFs): Promise<RequiredService[]> {
  const services: RequiredService[] = [];
  if (await fs.exists('docker-compose.yml')) {
    services.push({
      name: 'docker-compose',
      reason: 'docker-compose.yml presente na raiz',
      source: 'fs:docker-compose.yml',
    });
  }

  const envExample = await fs.readFile('.env.example');
  if (envExample !== null) {
    const varNames = envExample
      .split('\n')
      .map((line) => line.split('=')[0]?.trim())
      .filter((name): name is string => !!name && !name.startsWith('#'));

    const seen = new Set<string>();
    for (const varName of varNames) {
      for (const [pattern, serviceName] of ENV_VAR_SERVICE_HINTS) {
        if (pattern.test(varName) && !seen.has(serviceName)) {
          seen.add(serviceName);
          services.push({
            name: serviceName,
            reason: `variável de ambiente ${varName} declarada em .env.example`,
            source: 'fs:.env.example',
          });
        }
      }
    }
  }
  return services;
}

// ---------------------------------------------------------------------------
// Permissões de filesystem — só `access`, nunca escreve.
// ---------------------------------------------------------------------------

async function inspectFilesystemPermissions(repoRoot: string): Promise<Fact<FilesystemPermissions>> {
  try {
    const readable = await accessOk(repoRoot, fsConstants.R_OK);
    const writable = await accessOk(repoRoot, fsConstants.W_OK);
    return known({ readable, writable }, 'fs:access');
  } catch (error) {
    return unknown(`falha ao checar permissões de ${repoRoot}: ${(error as Error).message}`, 'fs:access');
  }
}

async function accessOk(target: string, mode: number): Promise<boolean> {
  try {
    await access(target, mode);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Feedback/observabilidade disponível.
// ---------------------------------------------------------------------------

async function inspectFeedbackSources(fs: ContainedFs): Promise<FeedbackSource[]> {
  const sources: FeedbackSource[] = [];
  const workflowFiles = await fs.readdir('.github/workflows');
  for (const file of workflowFiles ?? []) {
    if (file.endsWith('.yml') || file.endsWith('.yaml')) {
      sources.push({ path: `.github/workflows/${file}`, kind: 'ci' });
    }
  }
  if (await fs.exists('CHANGELOG.md')) {
    sources.push({ path: 'CHANGELOG.md', kind: 'changelog' });
  }
  return sources;
}

// ---------------------------------------------------------------------------
// Mapa de instruções do projeto — caminho, escopo e relevância. Nunca conteúdo.
// ---------------------------------------------------------------------------

const PROJECT_INSTRUCTION_RELEVANCE: ReadonlyArray<readonly [RegExp, ProjectInstructionRef['relevance']]> = [
  [/^(AGENTS|CLAUDE)\.md$/i, 'general'],
  [/^CONTRIBUTING\.md$/i, 'contribution'],
  [/^README\.md$/i, 'general'],
  [/architecture/i, 'architecture'],
  [/^package\.json$/, 'build'],
  [/^tsconfig.*\.json$/, 'build'],
  [/\.github\/workflows\//, 'ci'],
];

const PROJECT_INSTRUCTION_CANDIDATES = [
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
  'CONTRIBUTING.md',
  'package.json',
  'tsconfig.json',
  'docs/architecture.md',
];

function relevanceFor(relativePath: string): ProjectInstructionRef['relevance'] {
  for (const [pattern, relevance] of PROJECT_INSTRUCTION_RELEVANCE) {
    if (pattern.test(relativePath)) return relevance;
  }
  return 'general';
}

async function inspectProjectInstructions(fs: ContainedFs): Promise<ProjectInstructionRef[]> {
  const refs: ProjectInstructionRef[] = [];
  for (const candidate of PROJECT_INSTRUCTION_CANDIDATES) {
    if (await fs.exists(candidate)) {
      refs.push({
        path: candidate,
        scope: candidate.includes('/') ? 'module' : 'root',
        relevance: relevanceFor(candidate),
      });
    }
  }

  const workflowFiles = await fs.readdir('.github/workflows');
  for (const file of workflowFiles ?? []) {
    const relativePath = `.github/workflows/${file}`;
    refs.push({ path: relativePath, scope: 'module', relevance: 'ci' });
  }

  return refs;
}

// ---------------------------------------------------------------------------
// Source anchors por área — caminhos, não conteúdo.
// ---------------------------------------------------------------------------

async function inspectSourceAnchors(fs: ContainedFs, directories: readonly DirectoryEntry[]): Promise<SourceAnchor[]> {
  const sourceRoot = directories.find((entry) => entry.role === 'source')?.path;
  if (sourceRoot === undefined) return [];

  const entries = await fs.readdir(sourceRoot);
  if (entries === null) return [];

  const anchors: SourceAnchor[] = [];
  for (const entry of entries) {
    const relativePath = `${sourceRoot}/${entry}`;
    if (await fs.isContained(relativePath)) {
      anchors.push({ area: entry, path: relativePath });
    }
  }
  return anchors;
}

// ---------------------------------------------------------------------------
// Riscos observados — heurísticas simples, nunca inventadas sem base em fato.
// ---------------------------------------------------------------------------

function inspectRisks(input: {
  readonly dependenciesState: Fact<DependenciesState>;
  readonly tests: Fact<TestsInfo>;
  readonly git: Fact<GitState>;
}): string[] {
  const risks: string[] = [];
  if (input.dependenciesState.known && !input.dependenciesState.value.installed) {
    risks.push('dependências declaradas mas não instaladas (node_modules ausente)');
  }
  if (!input.tests.known) {
    risks.push('nenhum diretório ou framework de teste detectado');
  }
  if (input.git.known && input.git.value.dirty) {
    risks.push('working tree com alterações não commitadas no momento da inspeção');
  }
  return risks;
}

// ---------------------------------------------------------------------------
// Entrada pública.
// ---------------------------------------------------------------------------

export async function inspectRepository(options: InspectRepositoryOptions): Promise<ProjectInspection> {
  const repoRoot = options.repoRoot;
  const now = options.now ?? (() => new Date());
  const fs = await createContainedFs(repoRoot);

  const git = await inspectGit(fs.repoRoot);
  const stack = await inspectStack(fs);
  const packageManager = await inspectPackageManager(fs);
  const buildSystem = await inspectBuildSystem(fs);
  const directories = await inspectDirectories(fs);
  const tests = await inspectTests(fs, directories);
  const validationCommandCandidates = await inspectValidationCommandCandidates(fs);
  const dependenciesState = await inspectDependenciesState(fs);
  const requiredTools = await inspectRequiredTools(fs);
  const requiredServices = await inspectRequiredServices(fs);
  const filesystemPermissions = await inspectFilesystemPermissions(fs.repoRoot);
  const feedbackSources = await inspectFeedbackSources(fs);
  const projectInstructions = await inspectProjectInstructions(fs);
  const sourceAnchors = await inspectSourceAnchors(fs, directories);
  const risks = inspectRisks({ dependenciesState, tests, git });

  const relevantFiles = [
    ...projectInstructions.map((ref) => ref.path),
    ...(dependenciesState.known && dependenciesState.value.lockfile_path !== null
      ? [dependenciesState.value.lockfile_path]
      : []),
  ];

  return {
    schema_version: 1,
    repo_root: fs.repoRoot,
    inspected_at: now().toISOString(),
    git,
    stack,
    package_manager: packageManager,
    build_system: buildSystem,
    directories,
    tests,
    validation_command_candidates: validationCommandCandidates,
    dependencies_state: dependenciesState,
    required_tools: requiredTools,
    required_services: requiredServices,
    filesystem_permissions: filesystemPermissions,
    feedback_sources: feedbackSources,
    project_instructions: projectInstructions,
    source_anchors: sourceAnchors,
    relevant_files: [...new Set(relevantFiles)],
    risks,
  };
}
