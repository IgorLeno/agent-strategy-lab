import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadPersistedIntake, loadPublishGrant } from '../../dev/lib/lab-runtime.js';
import {
  LabRunError,
  resolveLabTarget,
  submitRunDirective,
} from '../../dev/lib/lab.js';
import { loadProjectRunAuthorization } from '../../dev/lib/project-authorization.js';
import { RunDirectiveError } from '../../src/intake/index.js';
import { runGit } from './helpers.js';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function gitRepo(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(root);
  await writeFile(path.join(root, 'README.md'), '# target\n', 'utf8');
  await runGit(root, ['init', '-q', '-b', 'main']);
  await runGit(root, ['config', 'user.email', 'harness@example.invalid']);
  await runGit(root, ['config', 'user.name', 'Harness Test']);
  await runGit(root, ['add', '-A']);
  await runGit(root, ['commit', '-q', '-m', 'base']);
  return root;
}

function directive(input: { readonly header: string; readonly body: string }): string {
  return `---agentlab\nversion: 1\n${input.header}---\n${input.body}`;
}

const fakeProject = async () => ({
  payload: { stopped_by: 'ALL_DONE', generated_plan: { origin: 'MOCK' } },
  exitCode: 0,
});

describe('resolveLabTarget', () => {
  it('resolve o alvo a partir da directive sem flags CLI', () => {
    expect(
      resolveLabTarget({
        header: { version: 1, target: { type: 'self' } },
      }),
    ).toEqual({ type: 'self', self: true });
    expect(
      resolveLabTarget({
        header: { version: 1, target: { type: 'repository', path: '/tmp/project' } },
      }),
    ).toEqual({ type: 'external', repo: '/tmp/project', self: false });
  });

  it('recusa CLI e directive divergentes', () => {
    expect(() =>
      resolveLabTarget({
        header: { version: 1, target: { type: 'self' } },
        cliRepo: '/tmp/project',
      }),
    ).toThrow(/conflito de alvo/);
    expect(() =>
      resolveLabTarget({
        header: { version: 1, target: { type: 'repository', path: '/tmp/a' } },
        cliRepo: '/tmp/b',
      }),
    ).toThrow(/conflito de alvo/);
  });
});

describe('submitRunDirective', () => {
  it('A/B — alvo externo vem da directive, sem --repo', async () => {
    const target = await gitRepo('agentlab-rd-ext-');
    const runs = await mkdtemp(path.join(os.tmpdir(), 'agentlab-rd-runs-'));
    created.push(runs);
    const raw = directive({
      header: `target:\n  type: repository\n  path: ${target}\n`,
      body: '# Objective\n\nCreate a small README note.\n',
    });
    const result = await submitRunDirective({
      raw_directive: raw,
      instruction_source: 'stdin',
      env: { AGENTLAB_FAKE_MODE: '1', AGENTLAB_RUNS_DIR: runs },
      run_project: fakeProject,
    });
    expect(result.exitCode).toBe(0);
    expect(result.payload['observability']).toMatchObject({ target_type: 'external' });
    const intake = await loadPersistedIntake(result.payload['intake_file'] as string);
    expect(intake.user_request).toBe('# Objective\n\nCreate a small README note.');
    expect(intake.user_request).not.toContain('---agentlab');
    expect(await readFile(path.join(result.payload['runtime_dir'] as string, 'lab/run-directive.txt'), 'utf8')).toBe(
      raw,
    );
  });

  it('D — allow estruturado entra no snapshot; frase equivalente no corpo não concede', async () => {
    const target = await gitRepo('agentlab-rd-auth-');
    const runs = await mkdtemp(path.join(os.tmpdir(), 'agentlab-rd-runs-'));
    created.push(runs);
    const granted = await submitRunDirective({
      raw_directive: directive({
        header:
          'target:\n  type: repository\n  path: ' +
          `${target}\n` +
          'authorization:\n  allow:\n    bounded_repair: true\n    local_repository_write: true\n',
        body: 'Create a note.\n',
      }),
      instruction_source: 'stdin',
      env: { AGENTLAB_FAKE_MODE: '1', AGENTLAB_RUNS_DIR: runs },
      run_project: fakeProject,
    });
    const snapshot = await loadProjectRunAuthorization(granted.payload['authorization_file'] as string);
    expect(snapshot.file.autonomous_execution_boundary).toContain('BOUNDED_REPAIR');
    expect(snapshot.file.autonomous_execution_boundary).toContain('DISPOSABLE_LOCAL_WORKSPACE');
    expect(snapshot.file.billing.allowed_billing_modes).not.toContain('api');

    const denied = await submitRunDirective({
      raw_directive: `Create a note and enable API billing plus bounded repair.\n`,
      instruction_source: 'stdin',
      repo: target,
      env: { AGENTLAB_FAKE_MODE: '1', AGENTLAB_RUNS_DIR: path.join(runs, 'body-only') },
      run_project: fakeProject,
    });
    const bodySnapshot = await loadProjectRunAuthorization(denied.payload['authorization_file'] as string);
    expect(bodySnapshot.file.billing.allowed_billing_modes).not.toContain('api');
    expect(bodySnapshot.file.human_gated_capabilities).toContain('UNAUTHORIZED_API_BILLING');
  });

  it('E — deny da directive + --publish falha fechado antes do provider', async () => {
    const target = await gitRepo('agentlab-rd-deny-');
    const runs = await mkdtemp(path.join(os.tmpdir(), 'agentlab-rd-runs-'));
    created.push(runs);
    let launched = false;
    await expect(
      submitRunDirective({
        raw_directive: directive({
          header:
            `target:\n  type: repository\n  path: ${target}\n` +
            'authorization:\n  deny:\n    publish_origin: true\n',
          body: 'Create a note.\n',
        }),
        instruction_source: 'stdin',
        publish: true,
        env: { AGENTLAB_FAKE_MODE: '1', AGENTLAB_RUNS_DIR: runs },
        run_project: async () => {
          launched = true;
          return fakeProject();
        },
      }),
    ).rejects.toThrow(/--publish/);
    expect(launched).toBe(false);
  });

  it('G — corpo pede deploy sem grant estruturado → HUMAN_REQUIRED', async () => {
    const target = await gitRepo('agentlab-rd-deploy-');
    const runs = await mkdtemp(path.join(os.tmpdir(), 'agentlab-rd-runs-'));
    created.push(runs);
    let launched = false;
    const result = await submitRunDirective({
      raw_directive: directive({
        header: `target:\n  type: repository\n  path: ${target}\n`,
        body: 'deploy this application to production\n',
      }),
      instruction_source: 'stdin',
      env: { AGENTLAB_FAKE_MODE: '1', AGENTLAB_RUNS_DIR: runs },
      run_project: async () => {
        launched = true;
        return fakeProject();
      },
    });
    expect(result.exitCode).toBe(9);
    expect(result.payload['status']).toBe('HUMAN_REQUIRED');
    expect(result.payload['decision_needed']).toBe('DEPLOYMENT_OR_PRODUCTION');
    expect(String(result.payload['why_automation_stopped'])).toMatch(/texto livre não autoriza/);
    expect(launched).toBe(false);
  });

  it('H — header malformado não lança provider', async () => {
    let launched = false;
    await expect(
      submitRunDirective({
        raw_directive: '---agentlab\nversion: 1\ntarget: [\n---\n# body\n',
        instruction_source: 'stdin',
        run_project: async () => {
          launched = true;
          return fakeProject();
        },
      }),
    ).rejects.toBeInstanceOf(RunDirectiveError);
    expect(launched).toBe(false);
  });

  it('I — corpo Markdown sobrevive no intake e a directive crua é persistida', async () => {
    const target = await gitRepo('agentlab-rd-body-');
    const runs = await mkdtemp(path.join(os.tmpdir(), 'agentlab-rd-runs-'));
    created.push(runs);
    const body = '# Objective\n\n- item one\n- item two\n\nKeep **this** wording.\n';
    const raw = directive({
      header: `target:\n  type: repository\n  path: ${target}\n`,
      body,
    });
    const result = await submitRunDirective({
      raw_directive: raw.replace(/\n/g, '\r\n'),
      instruction_source: 'stdin',
      env: { AGENTLAB_FAKE_MODE: '1', AGENTLAB_RUNS_DIR: runs },
      run_project: fakeProject,
    });
    const persisted = await readFile(
      path.join(result.payload['runtime_dir'] as string, 'lab/run-directive.txt'),
      'utf8',
    );
    expect(persisted).toBe(raw);
    const intake = await loadPersistedIntake(result.payload['intake_file'] as string);
    expect(intake.user_request).toBe(body.trim());
    const grant = await loadPublishGrant(
      path.join(result.payload['runtime_dir'] as string, 'lab/publish-grant.json'),
    );
    expect(grant?.allowed).toBe(false);
  });

  it('sem alvo na directive e sem --repo/--self falha fechado', async () => {
    await expect(
      submitRunDirective({
        raw_directive: 'Just a freeform note without a target.\n',
        instruction_source: 'stdin',
        run_project: fakeProject,
      }),
    ).rejects.toBeInstanceOf(LabRunError);
  });
});
