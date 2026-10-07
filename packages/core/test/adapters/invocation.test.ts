import { describe, expect, it } from 'vitest';

import { DEFAULT_CATALOG, type ModelProfile } from '../../src/catalog/catalog.js';
import {
  FORBIDDEN_FLAGS,
  buildInvocation,
  openCodePermissionForMode,
  type PermissionMode,
} from '../../src/adapters/invocation.js';
import { mutationStructurallyDenied, resolveAction } from '../../src/adapters/opencode-scaffold.js';

const MODES: readonly PermissionMode[] = ['plan', 'edit', 'auto'];
const ALLOWED = ['pnpm test', 'pnpm typecheck', 'git diff'];

function profile(id: string): ModelProfile {
  const found = DEFAULT_CATALOG.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`perfil ausente: ${id}`);
  return found;
}

function invoke(id: string, mode: PermissionMode) {
  return buildInvocation({
    profile: profile(id),
    mode,
    prompt: 'faça o step',
    allowedCommands: ALLOWED,
    sourceEnv: { PATH: '/usr/bin', HOME: '/home/u', ANTHROPIC_API_KEY: 'x', OPENAI_API_KEY: 'y' },
    extraEnv: { ASL_STEP_TAG: 'tag-1' },
  });
}

describe('invocação por scaffold e modo', () => {
  it('nenhum perfil, em nenhum modo, emite flag proibida ou credencial de API', () => {
    for (const entry of DEFAULT_CATALOG) {
      for (const mode of MODES) {
        const invocation = invoke(entry.id, mode);
        expect(invocation.argv.filter((token) => FORBIDDEN_FLAGS.includes(token))).toEqual([]);
        expect(invocation.env?.['ANTHROPIC_API_KEY']).toBeUndefined();
        expect(invocation.env?.['OPENAI_API_KEY']).toBeUndefined();
        expect(invocation.env?.['ASL_STEP_TAG']).toBe('tag-1');
        expect(invocation.env?.['PATH']).toBe('/usr/bin');
      }
    }
  });

  it('Claude: plan é modo plan; edit libera só a allowlist; auto libera Bash; commit e push negados', () => {
    const plan = invoke('claude-sonnet-5.5-medium', 'plan').argv;
    expect(plan).toContain('plan');
    expect(plan).not.toContain('Edit');
    expect(plan).toEqual(expect.arrayContaining(['--permission-prompts', 'none', '--no-session-persistence']));

    const edit = invoke('claude-sonnet-5.5-medium', 'edit');
    expect(edit.argv).toEqual(expect.arrayContaining(['acceptEdits', 'Bash(pnpm test:*)', 'Bash(git commit:*)']));
    expect(edit.argv).not.toContain('Bash');
    expect(edit.stdin).toBe('faça o step');

    const auto = invoke('claude-opus-5.5-medium', 'auto').argv;
    expect(auto).toContain('Bash');
    expect(auto.slice(auto.indexOf('--disallowedTools'))).toEqual(
      expect.arrayContaining(['Bash(git commit:*)', 'Bash(git push:*)', 'Bash(rm -rf:*)']),
    );
    expect(auto).toEqual(expect.arrayContaining(['--model', 'claude-opus-5-5', '--effort', 'medium']));
  });

  it('Codex: sandbox read-only no plan, workspace-write nos demais, rede só no auto', () => {
    const sandboxOf = (mode: PermissionMode) => {
      const argv = invoke('codex-sol-6-medium', mode).argv;
      return argv[argv.indexOf('--sandbox') + 1];
    };
    expect(sandboxOf('plan')).toBe('read-only');
    expect(sandboxOf('edit')).toBe('workspace-write');
    expect(sandboxOf('auto')).toBe('workspace-write');
    expect(invoke('codex-sol-6-medium', 'edit').argv.join(' ')).not.toContain('network_access');
    expect(invoke('codex-sol-6-medium', 'auto').argv).toContain('sandbox_workspace_write.network_access=true');
    const argv = invoke('codex-sol-6-medium', 'edit').argv;
    expect(argv.at(-1)).toBe('-');
    expect(argv).toContain('model_reasoning_effort="medium"');
  });

  it('OpenCode: prompt no argv e permissão completa no ambiente', () => {
    const invocation = invoke('opencode-go-glm-5.3', 'edit');
    expect(invocation.argv.at(-1)).toBe('faça o step');
    expect(invocation.stdin).toBeUndefined();
    expect(JSON.parse(invocation.env?.['OPENCODE_PERMISSION'] ?? '{}')).toEqual(
      openCodePermissionForMode('edit', ALLOWED),
    );
    expect(invocation.env?.['OPENCODE_DISABLE_PROJECT_CONFIG']).toBe('1');
    // Limite de uso não aparece no stdout (a sessão fica em retry); só no log.
    expect(invocation.argv.join(' ')).toContain('--print-logs --log-level ERROR');
  });

  it('OpenCode: semântica findLast de cada modo', () => {
    const plan = openCodePermissionForMode('plan', ALLOWED);
    expect(mutationStructurallyDenied(plan)).toBe(true);
    expect(resolveAction(plan, 'read')).toBe('allow');

    const edit = openCodePermissionForMode('edit', ALLOWED);
    expect(resolveAction(edit, 'edit')).toBe('allow');
    expect(resolveAction(edit, 'bash', 'pnpm test --run')).toBe('allow');
    expect(resolveAction(edit, 'bash', 'curl http://x')).toBe('deny');
    expect(resolveAction(edit, 'bash', 'git commit -m x')).toBe('deny');
    expect(resolveAction(edit, 'ferramenta-nova')).toBe('deny');

    const auto = openCodePermissionForMode('auto', ALLOWED);
    expect(resolveAction(auto, 'bash', 'curl http://x')).toBe('allow');
    expect(resolveAction(auto, 'bash', 'git push origin main')).toBe('deny');
    expect(resolveAction(auto, 'bash', 'rm -rf /')).toBe('deny');
    expect(resolveAction(auto, 'ferramenta-nova')).toBe('deny');
  });
});
