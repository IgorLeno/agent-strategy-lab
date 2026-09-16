# Interactive CLI Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `pnpm run lab` launch a guided wizard that starts a valid Agent Lab run without exposing directives, target types, or flags.

**Architecture:** `dev/cli/lab.ts` remains the command dispatcher. A presentation-only wizard gathers answers, constructs a v1 Run Directive, then calls `submitRunDirective` or `resumeHumanInstruction`; it does not reimplement runtime behavior.

**Tech Stack:** TypeScript, Node.js 22, `@inquirer/prompts`, Vitest, existing `yaml` and Lab Git/runtime utilities.

**Spec:** `docs/superpowers/specs/2026-09-16-interactive-cli-wizard-design.md`

## Global Constraints

- Enter the wizard only when no arguments are supplied and stdin plus stderr are TTYs. Preserve legacy stdin for every other invocation, including a valid no-argument directive piped in non-TTY mode.
- Preserve explicit `run`, `resume`, `--repo`, `--self`, `--prompt-file`, and authorization commands.
- Use `@inquirer/prompts`; do not create raw-stdin navigation.
- Generate a v1 Run Directive and delegate to the existing runtime seams.
- Preflight `git user.name` and `git user.email` before Start can create a new directory, Git repository, empty initial commit, or local remote.
- Never invent Git identity, clone or authenticate with GitHub, contact a remote, push, or create hosted repositories.
- Ctrl+C and prompt exit are normal, stack-trace-free cancellation; preserve the existing PTY directive capture behavior.
- Honor `NO_COLOR`, terminal width, and non-TTY use. Tests use fake execution only.
- Do not commit or push without separate current-task authorization.

---

## File structure

| File | Responsibility |
| --- | --- |
| `package.json`, `pnpm-lock.yaml` | Add the maintained prompt dependency without changing the `lab` script. |
| `dev/lib/lab-wizard-directive.ts` | Build a parser-valid v1 Run Directive from wizard choices. |
| `dev/lib/lab-project-selection.ts` | Resolve and inspect paths, discover recent runtimes, and prepare confirmed new projects. |
| `dev/lib/lab-wizard.ts` | Render the welcome, coordinate prompts, confirmation, cancellation, and dispatch. |
| `dev/cli/lab.ts` | Select wizard or preserve legacy argument-driven behavior. |
| `test/dev/lab-wizard-*.test.ts` | Unit-test directive, project, and scripted wizard behavior. |
| `test/e2e/direct-lab-cli-e2e.test.ts` | Prove non-TTY behavior and preserve advanced CLI compatibility. |
| `README.md` | Promote guided quick start and document advanced flags separately. |

### Task 1: Add directive construction and the prompt library

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `dev/lib/lab-wizard-directive.ts`
- Test: `test/dev/lab-wizard-directive.test.ts`

**Interfaces:**

```ts
export type WizardTarget =
  | { readonly type: 'repository'; readonly path: string }
  | { readonly type: 'self' };
export type WizardAction = 'implement' | 'fix' | 'refactor' | 'investigate' | 'continue-plan' | 'validate' | 'other';
export function buildWizardRunDirective(input: {
  readonly target: WizardTarget;
  readonly action: WizardAction;
  readonly objective: string;
}): string;
```

It consumes `parseRunDirective` and `AgentLabRunDirectiveHeader` from `src/intake/index.ts`. It emits `version: 1` plus the selected target, never authorization or execution defaults.

- [x] **Step 1: Write a failing parser-level test**

Create `test/dev/lab-wizard-directive.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseRunDirective } from '../../src/intake/index.js';
import { buildWizardRunDirective } from '../../dev/lib/lab-wizard-directive.js';

describe('buildWizardRunDirective', () => {
  it('builds a repository target without hidden defaults', () => {
    const parsed = parseRunDirective(buildWizardRunDirective({
      target: { type: 'repository', path: '/work/app' }, action: 'implement', objective: 'Add account recovery.',
    }));
    expect(parsed.header).toEqual({ version: 1, target: { type: 'repository', path: '/work/app' } });
    expect(parsed.body).toContain('Add account recovery.');
  });
  it('builds the canonical self target', () => {
    expect(parseRunDirective(buildWizardRunDirective({ target: { type: 'self' }, action: 'fix', objective: 'Correct CLI copy.' })).header?.target)
      .toEqual({ type: 'self' });
  });
});
```

- [x] **Step 2: Confirm the focused test fails before implementation**

Run: `pnpm test -- test/dev/lab-wizard-directive.test.ts`

Expected: FAIL because `lab-wizard-directive` does not exist.

- [x] **Step 3: Add the supported prompt dependency**

Run: `pnpm add @inquirer/prompts`

Expected: `@inquirer/prompts` is in `dependencies`, `pnpm-lock.yaml` updates, and the existing `lab` script remains `tsx dev/cli/lab.ts`.

- [x] **Step 4: Implement the minimal builder**

Use `yaml.stringify` for the header and call `parseRunDirective` before returning it:

```ts
const labels: Record<WizardAction, string> = { implement: 'Implement feature', fix: 'Fix problem', refactor: 'Refactor', investigate: 'Investigate or audit', 'continue-plan': 'Continue plan', validate: 'Run validation', other: 'Other' };
export function buildWizardRunDirective(input: { target: WizardTarget; action: WizardAction; objective: string }): string {
  const objective = input.objective.trim();
  if (!objective) throw new Error('Descreva o objetivo antes de continuar.');
  const header: AgentLabRunDirectiveHeader = { version: 1, target: input.target };
  const raw = `---agentlab\n${stringify(header)}---\nActivity: ${labels[input.action]}\n\n${objective}\n`;
  parseRunDirective(raw);
  return raw;
}
```

- [x] **Step 5: Verify the builder**

Run: `pnpm test -- test/dev/lab-wizard-directive.test.ts`

Expected: PASS; generated headers contain only the selected v1 target and objective text remains in the body.

### Task 2: Implement project selection and confirmed local bootstrap

**Files:**

- Create: `dev/lib/lab-project-selection.ts`
- Test: `test/dev/lab-project-selection.test.ts`

**Interfaces:**

```ts
export interface ProjectChoice {
  readonly root: string;
  readonly name: string;
  readonly branch: string | null;
  readonly clean: boolean;
  readonly remote: string | null;
}
export interface RecentRuntime {
  readonly runtimeDir: string;
  readonly target: ProjectChoice | { readonly type: 'self' };
  readonly updatedAtMs: number;
}
export async function inspectWizardProject(input: { readonly requestedPath: string; readonly controlRoot: string }): Promise<ProjectChoice>;
export async function listRecentRuntimes(input: { readonly controlRoot?: string; readonly env?: Readonly<Record<string, string | undefined>> }): Promise<readonly RecentRuntime[]>;
export async function prepareNewProject(input: {
  readonly parentDirectory: string;
  readonly name: string;
  readonly remoteUrl?: string;
  readonly git?: typeof git;
}): Promise<ProjectChoice>;
```

This module consumes `resolveLabRunsRoot`, `labArtifactPaths`, and `loadHumanInstruction`; `git`, `headSha`, `isWorkingTreeClean`, and `repoTopLevel`; and `resolveControlRepo`.

- [x] **Step 1: Write failing project tests**

Create temporary Git fixtures using existing `runGit` helper patterns. Cover this behavior:

```ts
it('expands a leading home marker and reports a clean Git root', async () => {
  await expect(inspectWizardProject({ requestedPath: nestedPath, controlRoot })).resolves.toMatchObject({ root, branch: 'main', clean: true, remote: 'owner/app' });
});
it('rejects missing, non-Git, dirty, and control-repository paths', async () => {
  await expect(inspectWizardProject({ requestedPath: missing, controlRoot })).rejects.toThrow(/não encontrei/i);
  await expect(inspectWizardProject({ requestedPath: dirty, controlRoot })).rejects.toThrow(/alterações/i);
  await expect(inspectWizardProject({ requestedPath: controlRoot, controlRoot })).rejects.toThrow(/próprio Agent Lab/i);
});
it('ignores malformed runtime artifacts and sorts valid recent runtimes', async () => {
  expect((await listRecentRuntimes({ env: { AGENTLAB_RUNS_DIR: runs } })).map(({ runtimeDir }) => runtimeDir)).toEqual([newest, older]);
});
it('refuses missing Git identity before creating a project directory', async () => {
  await expect(prepareNewProject({ parentDirectory, name: 'no-identity', git: noIdentityGit })).rejects.toThrow(/user.name/i);
  await expect(access(path.join(parentDirectory, 'no-identity'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('creates a clean main repository and optional local origin only on request', async () => {
  await expect(prepareNewProject({ parentDirectory, name: 'demo', remoteUrl: 'https://github.com/org/demo.git' })).resolves.toMatchObject({ branch: 'main', clean: true, remote: 'org/demo' });
});
```

Assert the new target directory is absent before `prepareNewProject`; this proves no write occurs during collection or summary.

- [x] **Step 2: Confirm the tests fail before the module exists**

Run: `pnpm test -- test/dev/lab-project-selection.test.ts`

Expected: FAIL with unresolved module import.

- [x] **Step 3: Implement safe inspection and runtime discovery**

Expand only `~` and `~/...`, resolve nested paths with `repoTopLevel`, reject dirty repositories via `isWorkingTreeClean`, and reject `resolveControlRepo(controlRoot)`. Read `origin` with `git(repoRoot, ['remote', 'get-url', 'origin'])`; redact credentials and return an `owner/repository` label when available, never the full URL.

Scan exactly two levels under `resolveLabRunsRoot`. Require and validate `lab/human-instruction.json`, use runtime `mtimeMs` for sorting, and ignore unreadable or malformed entries. Inspect external targets through `inspectWizardProject`; return `{ type: 'self' }` for persisted self targets.

- [x] **Step 4: Implement bootstrap after confirmation only**

Validate a non-empty, single-segment project name, an existing parent, and an absent destination. Before calling `mkdir`, read both `git config --get user.name` and `git config --get user.email` through the existing Git command seam. If either result is empty or non-zero, throw the documented configuration message without touching the destination. Only after that preflight succeeds, run local commands in this order:

```ts
await mkdir(targetDirectory);
await git(parentDirectory, ['init', '-b', 'main', targetDirectory]);
await git(targetDirectory, ['commit', '--allow-empty', '--quiet', '-m', 'Initial commit']);
if (input.remoteUrl?.trim()) await git(targetDirectory, ['remote', 'add', 'origin', input.remoteUrl.trim()]);
```

If Git identity is absent, throw `Não consigo criar um projeto novo porque Git ainda não tem user.name e user.email. Configure git config --global user.name e git config --global user.email e tente novamente.` Keep any later partial local failure in place; never delete user data.

- [x] **Step 5: Verify project selection**

Run: `pnpm test -- test/dev/lab-project-selection.test.ts`

Expected: PASS for paths, status, redacted remote labels, invalid and dirty repositories, valid recents, and local-only bootstrap.

### Task 3: Build the testable wizard and terminal presentation

**Files:**

- Create: `dev/lib/lab-wizard.ts`
- Test: `test/dev/lab-wizard.test.ts`

**Interfaces:**

```ts
export interface WizardPrompts {
  select<T>(message: string, choices: readonly { readonly name: string; readonly value: T }[]): Promise<T>;
  input(message: string, options?: { readonly default?: string; readonly validate?: (value: string) => true | string }): Promise<string>;
  confirm(message: string, options?: { readonly default?: boolean }): Promise<boolean>;
  editor(message: string, options?: { readonly default?: string }): Promise<string>;
}
export class WizardCancelled extends Error {}
export type WizardResult = 'completed' | 'advanced';
export async function runLabWizard(input: {
  readonly prompts: WizardPrompts;
  readonly stderr: { write(chunk: string): void; columns?: number };
  readonly color: boolean;
  readonly submit: typeof submitRunDirective;
  readonly resume: typeof resumeHumanInstruction;
  readonly controlRoot?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): Promise<WizardResult>;
export function renderWelcome(columns?: number, color?: boolean): string;
```

It consumes the three Task 1 and Task 2 public functions plus existing runtime seams. The production adapter wraps `@inquirer/prompts`; a scripted `WizardPrompts` adapter drives unit tests. Translate library cancellation into `WizardCancelled` only at the adapter boundary.

- [x] **Step 1: Write failing scripted wizard tests**

Create a prompt fixture that dequeues preselected answers and records messages. Test the concrete boundary behavior:

```ts
it('submits a generated external directive only after Start', async () => {
  await runLabWizard({ prompts, stderr, color: false, submit, resume });
  expect(submit).toHaveBeenCalledOnce();
  expect(parseRunDirective(submit.mock.calls[0][0].raw_directive).header?.target).toEqual({ type: 'repository', path: repo });
});
it('does not dispatch after Cancel or prompt cancellation', async () => {
  await runLabWizard({ prompts: cancelAtSummary, stderr, color: false, submit, resume });
  expect(submit).not.toHaveBeenCalled();
  await expect(runLabWizard({ prompts: throwsCancel, stderr, color: false, submit, resume })).rejects.toBeInstanceOf(WizardCancelled);
});
it('resumes the selected runtime without asking for a replacement objective', async () => {
  await runLabWizard({ prompts: chooseResume, stderr, color: false, submit, resume });
  expect(resume).toHaveBeenCalledWith(expect.objectContaining({ runtime_dir: runtime }));
  expect(submit).not.toHaveBeenCalled();
});
```

Add self, new-project Start, Review, advanced, and Exit cases. Assert that the narrow banner says `AGENT LAB`, the wide form renders this real ASCII logo, and no no-color render contains an ANSI escape:

```text
    _                    _     _          _
   / \   __ _  ___ _ __ | |_  | |    __ _| |__
  / _ \ / _` |/ _ \ '_ \| __| | |   / _` | '_ \
 / ___ \ (_| |  __/ | | | |_  | |__| (_| | |_) |
/_/   \_\__, |\___|_| |_|\__| |_____|\__,_|_.__/
        |___/
```

- [x] **Step 2: Confirm wizard tests fail**

Run: `pnpm test -- test/dev/lab-wizard.test.ts`

Expected: FAIL with unresolved `lab-wizard` import.

- [x] **Step 3: Implement standard prompts and the accessibility boundary**

Adapt the named `select`, `input`, `confirm`, and `editor` exports from `@inquirer/prompts` to `WizardPrompts`. Keep the custom banner ASCII-only:

```ts
export function renderWelcome(columns = 80, color = false): string {
  const logo = columns < 60
    ? 'AGENT LAB'
    : ['    _                    _     _          _', '   / \\   __ _  ___ _ __ | |_  | |    __ _| |__', "  / _ \\ / _` |/ _ \\ '_ \\| __| | |   / _` | '_ \\", ' / ___ \\ (_| |  __/ | | | |_  | |__| (_| | |_) |', '/_/   \\_\\__, |\\___|_| |_|\\__| |_____|\\__,_|_.__/', '        |___/'].join('\\n');
  return `${logo}\n\nPlan, implement, and review projects with agents.\n`;
}
```

Use a local `paint` helper that returns its input unchanged when `color` is false. Never color or transform the body that becomes the directive. Treat prompt-library Ctrl+C/exit as `WizardCancelled` and let the dispatcher return zero.

- [x] **Step 4: Implement navigation, confirmation, and runtime dispatch**

Use these discriminated choices:

```ts
type PrimaryChoice = 'existing' | 'new' | 'resume' | 'self' | 'advanced' | 'exit';
type SummaryChoice = 'start' | 'review' | 'cancel';
```

`existing` offers valid recents, local path, and Back. It calls `inspectWizardProject` before action and objective collection. The normal objective prompt is `input`; an explicit “Adicionar contexto longo” choice opens `editor` only when wanted. `new` gathers name, parent, confirmation that the directory will be created, Git initialization, optional remote URL, action, and objective. A user who declines Git initialization receives the clear explanation that a runnable Agent Lab project needs a Git repository with an initial commit and returns to the new-project choice; `prepareNewProject` preflights Git identity and is called only after `start`. `self` uses `{ type: 'self' }`. `resume` chooses `listRecentRuntimes` then calls `resume({ runtime_dir, on_runtime, on_summary, on_progress })` without any objective prompt. `advanced` returns `'advanced'` so no Inquirer prompt owns the terminal during legacy capture.

For new and existing targets, build the directive, show project, path, branch, clean status, remote, action, and objective, and offer Start, Review, Cancel. Review returns to the relevant selection. Start calls:

```ts
await input.submit({
  raw_directive,
  instruction_source: 'stdin',
  self: target.type === 'self',
  ...(target.type === 'repository' ? { repo: target.path } : {}),
  on_runtime: (dir) => input.stderr.write(`runtime: ${dir}\n`),
  on_summary: (summary) => input.stderr.write(`${formatRunSummary(summary)}\n`),
});
```

- [x] **Step 5: Verify the wizard**

Run: `pnpm test -- test/dev/lab-wizard.test.ts`

Expected: PASS for existing, self, new Start confirmation, recents, resume, Review, Cancel, advanced return, prompt exit, narrow rendering, and `NO_COLOR` behavior.

### Task 4: Dispatch the wizard without breaking advanced CLI use

**Files:**

- Modify: `dev/cli/lab.ts`
- Modify: `test/e2e/direct-lab-cli-e2e.test.ts`
- Modify: `test/dev/lab-input-pty.test.ts` only if the explicit advanced invocation must be updated

**Interfaces:**

```ts
export function shouldOpenWizard(input: {
  readonly argv: readonly string[];
  readonly stdinIsTTY: boolean;
  readonly stderrIsTTY: boolean;
}): boolean;
```

It returns true only for an empty argument list with both TTY conditions. It consumes Task 3's `runLabWizard` and `WizardCancelled`.

- [x] **Step 1: Add failing selection and non-TTY tests**

Add pure assertions and a public subprocess assertion that preserves legacy stdin:

```ts
expect(shouldOpenWizard({ argv: [], stdinIsTTY: true, stderrIsTTY: true })).toBe(true);
expect(shouldOpenWizard({ argv: ['run'], stdinIsTTY: true, stderrIsTTY: true })).toBe(false);
expect(shouldOpenWizard({ argv: [], stdinIsTTY: false, stderrIsTTY: false })).toBe(false);
const raw = runDirective({ header: `target:\n  type: repository\n  path: ${fixture.target}\n`, body: 'Create a small README note.' });
const result = await runLab([], labEnv(fixture.runs), raw);
expect(result.exitCode, result.stderr).toBe(0);
expect(JSON.parse(result.stdout).observability).toMatchObject({ target_type: 'external', directive_format: 'agentlab-v1' });
```

Retain all current tests for `--repo`, `--self`, `run`, `--prompt-file`, and resume as compatibility evidence.

- [x] **Step 2: Confirm the legacy stdin assertion passes before dispatcher work**

Run: `pnpm test -- test/e2e/direct-lab-cli-e2e.test.ts`

Expected: PASS. This is the backwards-compatibility baseline: no-argument non-TTY input currently accepts a valid piped Run Directive.

- [x] **Step 3: Add the bounded dispatcher change**

Create `shouldOpenWizard` near argument parsing. If it returns true, call `runLabWizard` before the existing progress UI. Return normally for `WizardCancelled`. If it returns `'advanced'`, invoke the existing raw directive capture only after the wizard has returned.

Extract the existing raw capture-and-submit block to a local helper only when necessary to support advanced mode. Preserve its `WAITING_FOR_INPUT` callback and post-EOF newline exactly. Do not alter `createLabUi` redraw logic. Pass `color: process.env.NO_COLOR === undefined` to the wizard and retain `createLabUi` for runtime progress after dispatch.

- [x] **Step 4: Verify compatibility and PTY safety**

Run: `pnpm test -- test/e2e/direct-lab-cli-e2e.test.ts test/dev/lab-input-pty.test.ts`

Expected: PASS. Explicit commands and valid no-argument piped directives retain JSON stdout contracts, and the PTY test retains byte equality with zero redraws during input.

### Task 5: Document the standard entrypoint and run final gates

**Files:**

- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-09-16-interactive-cli-wizard-design.md` only if implementation reveals a real specification mismatch

**Interfaces:** The public command contract is `pnpm run lab` for interactive use and `pnpm lab run --repo <path>` for advanced or automated use.

- [x] **Step 1: Add the quick start to README**

Add this near the first usage guidance:

```markdown
## Quick start

1. Enter the Agent Strategy Lab directory.
2. Run `pnpm run lab`.
3. Choose a project, describe the goal, review the summary, and start the run.

For scripts and advanced workflows, use `pnpm lab run --repo <path>` with the appropriate input flags. A valid Run Directive can also be piped to the legacy CLI; the guided wizard itself requires an interactive terminal.
```

Keep `target.type`, directive YAML, and storage details out of quick start; place them only in advanced documentation.

- [x] **Step 2: Run focused feature coverage**

Run: `pnpm test -- test/dev/lab-wizard-directive.test.ts test/dev/lab-project-selection.test.ts test/dev/lab-wizard.test.ts test/e2e/direct-lab-cli-e2e.test.ts test/dev/lab-input-pty.test.ts`

Expected: PASS without provider launch or writes outside temporary test fixtures.

- [x] **Step 3: Run native quality gates**

Run: `pnpm typecheck`, then `pnpm build`, then `pnpm test`, then `git diff --check`.

Expected: every command exits 0. If the Linux-only PTY test is skipped or a sandbox blocks it, report that exact limitation and do not describe end-to-end terminal verification as complete until its native result is available.

- [x] **Step 4: Inspect scope before handoff**

Run: `git diff -- package.json pnpm-lock.yaml dev/cli/lab.ts dev/lib/lab-wizard-directive.ts dev/lib/lab-project-selection.ts dev/lib/lab-wizard.ts test/dev/lab-wizard-directive.test.ts test/dev/lab-project-selection.test.ts test/dev/lab-wizard.test.ts test/e2e/direct-lab-cli-e2e.test.ts README.md`

Expected: only the CLI presentation, intake adapter, dependency, tests, and documentation changed; no scheduler, planner, authorization schema, or worker-policy edit appears.

## Plan self-review

| Specification requirement | Tasks |
| --- | --- |
| TTY welcome, standard prompts, accessibility | 3, 4 |
| Existing project validation and status | 2, 3 |
| Recent projects and resume | 2, 3 |
| Activity and natural-language objective | 1, 3 |
| Confirmed new project and initial Git commit | 2, 3 |
| Self and advanced flows | 1, 3, 4 |
| Non-TTY and flag compatibility | 4 |
| PTY regression, documentation, and final gates | 4, 5 |

All later-task interfaces are declared before use. This plan has no deferred implementation marker or unspecified test step.
