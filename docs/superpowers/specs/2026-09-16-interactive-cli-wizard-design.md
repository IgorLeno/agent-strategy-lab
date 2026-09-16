# Interactive CLI Wizard Design

## Purpose

Make `pnpm run lab` usable by a person who does not know the internal
Run Directive format, target types, or `--repo` and `--self` flags. The
wizard collects ordinary answers and converts them into the Run Directive
that the existing Lab runtime already accepts.

The change is limited to CLI presentation and intake. It does not change the
agent strategy, scheduler, runtime lifecycle, Git policy, planning, work
packages, or memory systems.

## Existing seams

`dev/cli/lab.ts` is the public `lab` entrypoint. It currently parses flags,
reads a directive or instruction from stdin, then delegates to
`submitRunDirective` or `resumeHumanInstruction` in `dev/lib/lab.ts`.

`submitRunDirective` parses the canonical directive, resolves its target, and
then delegates to the existing intake, authorization, and execution flow.
The wizard must stop at this seam: it builds a valid v1 directive and invokes
the existing function. It must not reimplement authorization or execution.

The current runtime already records project runs under the Lab data directory
and persists a `HumanInstruction` that identifies its target. Those artifacts
are the source for recent projects and resumable runs; no new database is
needed.

## Invocation and compatibility

| Invocation | Behavior |
| --- | --- |
| `pnpm run lab` in a TTY with no arguments | Open the wizard. |
| `pnpm lab` in a TTY with no arguments | Open the wizard. |
| `pnpm lab run`, `--repo`, `--self`, `--prompt-file`, `--resume`, or authorization subcommands | Preserve the existing advanced flow. |
| No-argument non-TTY invocation | Exit with a concise explanation that the wizard needs a terminal and show the required advanced flags. |

The `lab` package script already targets `dev/cli/lab.ts`; it stays in place.
The implementation adds `@inquirer/prompts` for standard keyboard navigation,
inline validation, and clean cancellation.

## Wizard UX

The opening is a real ASCII Agent Strategy Lab logo, a one-sentence product
description, and the primary question, “What do you want to do?” Wide terminals
receive the full logo; a compact `AGENT LAB` fallback is used in narrow
terminals. It emits no ANSI color when `NO_COLOR` is present and keeps all
essential information as plain text.

The primary choices are:

1. Work on an existing project.
2. Create a new project.
3. Continue a previous execution.
4. Work on Agent Strategy Lab.
5. Advanced mode.
6. Exit.

### Existing project

The user can choose a recent project, enter a local path, or go back. Paths
accept a leading `~`, resolve to absolute paths, and are checked before the
user can continue. The presentation layer reports the project name, Git
branch, clean or dirty state, and an available remote label.

A missing path, non-Git directory, dirty working tree, unreadable repository,
or a path that resolves to the Agent Lab control repository is an actionable
message with a route back to project selection. The wizard does not show
internal target terminology.

After selecting the project, the user chooses an activity such as implement a
feature, fix a problem, refactor, investigate, continue a plan, validate, or
other. This choice supplies context only; it never narrows the Lab's runtime
capabilities. The user then writes an objective. A normal input is available
for concise requests, and the library's editor prompt is available when the
user wants multiline context.

### New project

The user supplies a name, parent directory, whether to create the directory,
whether to initialize Git, and an initial objective. The final summary states
every pending local write. Only when the user selects Start does the wizard
create the directory, initialize `main`, and create an empty initial commit if
needed for the existing runtime's clean-HEAD requirement.

Git identity is never invented. Before creating the directory or repository,
the wizard checks `git user.name` and `git user.email`. If either is absent,
it reports the exact configuration needed and does not create a partial
project. A remote may be configured locally only when the user supplied its
URL and accepted it in the summary; the wizard never contacts the remote or
authenticates with GitHub.

### Resume, self, and advanced mode

Resume lists valid persisted runtimes and delegates directly to
`resumeHumanInstruction`; it never collects a replacement objective.

The self option produces a v1 directive with `target.type: self`; the user
never has to know the internal flag name. Existing isolated-worktree behavior
remains in the runtime.

Advanced mode offers the existing full Run Directive capture. It leaves the
documented command-line interface intact for scripts and power users.

### Confirmation and cancellation

Every new run shows project, path, Git state, remote, branch, activity, and
objective. The available choices are Start, Review, and Cancel. New-project
file and Git writes occur only after Start.

Cancelling a prompt or pressing Ctrl+C is a normal exit: the prompt library
restores the terminal, no stack trace is printed, and no runtime or project is
created. Predictable errors use human-facing messages; technical detail stays
available through the existing verbose path.

## Module boundaries

`dev/cli/lab.ts` remains the argument dispatcher. It recognizes the empty TTY
invocation as the wizard entrypoint and routes every explicit advanced command
through the current code path.

`dev/lib/lab-wizard.ts` owns prompt order, banner rendering, cancellation, and
the final dispatch. It depends on injected prompt and terminal adapters in
tests.

`dev/lib/lab-project-selection.ts` owns path expansion, read-only project
inspection, recent runtime discovery, and confirmed new-project preparation.
It reuses existing Git utilities and persisted Lab artifacts instead of adding
another Git runner or storage schema.

`dev/lib/lab-wizard-directive.ts` turns a selected target and objective into a
v1 directive. It contains no authorization defaults beyond the existing
default-policy behavior.

## Data flow

```text
answers -> selected target + objective -> Run Directive v1
        -> submitRunDirective -> existing intake/authorization/runtime

selected runtime -> resumeHumanInstruction -> existing runtime
```

For an external target, the generated header is `target.type: repository` and
contains the normalized local path. For self maintenance, it is
`target.type: self`. The objective is the directive body, prefixed only with
the human-readable activity context.

## Tests and verification

Unit tests cover directive construction, path expansion, project inspection,
recent-project filtering, new-project preparation, cancellation, and
human-facing errors. Prompt adapters make these tests independent of ANSI
frames and interactive timing.

CLI integration tests cover the no-argument TTY wizard with a fake runtime,
the non-TTY error, self selection, resume selection, and advanced-mode
dispatch. Existing tests for `--repo`, `--self`, `run`, `--prompt-file`, and
the PTY directive-input regression remain unchanged and must pass.

Required quality gates are `pnpm typecheck`, `pnpm build`, `pnpm test`, and
`git diff --check`. Tests use the fake execution seam and do not launch a
provider.

## Non-goals and risks

The first version does not clone GitHub repositories, authenticate with GitHub,
create a hosted repository, or contact a remote. It can display a local
repository's configured remote and can add a user-supplied remote to a newly
created local project after confirmation.

The main compatibility risk is treating an implicit command as interactive.
The dispatcher therefore enters the wizard only for no-argument TTY use;
all non-TTY input, including a valid Run Directive piped with no arguments,
continues through the existing legacy path. The main terminal risk is a
regression in the recent PTY capture repair, so the wizard must not repaint
while a legacy directive is being captured and the existing PTY test remains
mandatory.
