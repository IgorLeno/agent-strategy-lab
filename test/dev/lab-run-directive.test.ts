import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadPersistedIntake, loadPublishGrant } from '../../dev/lib/lab-runtime.js';
import {
  executionScopeFromAuthorization,
  resolveImpliedHumanGatedFromRuntime,
} from '../../dev/lib/human-gated-intent.js';
import {
  LabRunError,
  resolveLabTarget,
  resumeHumanInstruction,
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
    // A autoridade que falta agora é ESTRUTURAL, não só a prosa de
    // `decision_needed`: é ela que prova que existe uma decisão humana aqui.
    expect(result.payload['human_authority']).toBe('DEPLOYMENT_OR_PRODUCTION');
    expect(result.payload['decision_needed']).toBe('DEPLOYMENT_OR_PRODUCTION');
    expect(String(result.payload['why_automation_stopped'])).toMatch(/texto livre não autoriza/);
    expect(launched).toBe(false);
  });

  it('HUMAN_REQUIRED em NEW continua HUMAN_REQUIRED no RESUME da mesma runtime', async () => {
    const target = await gitRepo('agentlab-rd-resume-gate-');
    const runs = await mkdtemp(path.join(os.tmpdir(), 'agentlab-rd-resume-gate-runs-'));
    created.push(runs);
    const raw = directive({
      header: `target:\n  type: repository\n  path: ${target}\n`,
      body: 'deploy this application to production\n',
    });
    let launched = 0;
    const spy = async () => {
      launched += 1;
      return fakeProject();
    };
    const createdRun = await submitRunDirective({
      raw_directive: raw,
      instruction_source: 'stdin',
      env: { AGENTLAB_FAKE_MODE: '1', AGENTLAB_RUNS_DIR: runs },
      run_project: spy,
    });
    expect(createdRun.exitCode).toBe(9);
    expect(createdRun.payload['status']).toBe('HUMAN_REQUIRED');
    expect(createdRun.payload['decision_needed']).toBe('DEPLOYMENT_OR_PRODUCTION');
    expect(launched).toBe(0);

    const runtimeDir = createdRun.payload['runtime_dir'] as string;
    const snapshot = await loadProjectRunAuthorization(
      path.join(runtimeDir, 'lab', 'authorization.yaml'),
    );
    expect(
      await resolveImpliedHumanGatedFromRuntime(
        runtimeDir,
        executionScopeFromAuthorization({
          requested_scope: snapshot.file.requested_scope,
          autonomous_execution_boundary: snapshot.file.autonomous_execution_boundary,
          human_gated_capabilities: snapshot.file.human_gated_capabilities,
        }),
      ),
    ).toEqual(['DEPLOYMENT_OR_PRODUCTION']);
    const authorizationBefore = await readFile(
      path.join(runtimeDir, 'lab', 'authorization.yaml'),
      'utf8',
    );

    const resumed = await resumeHumanInstruction({
      runtime_dir: runtimeDir,
      env: { AGENTLAB_FAKE_MODE: '1', AGENTLAB_RUNS_DIR: runs },
      run_project: spy,
    });
    expect(resumed.exitCode).toBe(9);
    expect(resumed.payload['status']).toBe('HUMAN_REQUIRED');
    expect(resumed.payload['decision_needed']).toBe('DEPLOYMENT_OR_PRODUCTION');
    expect(resumed.payload['resumed']).toBe(true);
    expect(launched).toBe(0);

    const resubmitted = await submitRunDirective({
      raw_directive: raw,
      instruction_source: 'stdin',
      runtime_dir: runtimeDir,
      env: { AGENTLAB_FAKE_MODE: '1', AGENTLAB_RUNS_DIR: runs },
      run_project: spy,
    });
    expect(resubmitted.exitCode).toBe(9);
    expect(resubmitted.payload['status']).toBe('HUMAN_REQUIRED');
    expect(resubmitted.payload['decision_needed']).toBe('DEPLOYMENT_OR_PRODUCTION');
    expect(launched).toBe(0);

    const authorizationAfter = await readFile(
      path.join(runtimeDir, 'lab', 'authorization.yaml'),
      'utf8',
    );
    expect(authorizationAfter).toBe(authorizationBefore);
    await expect(access(path.join(runtimeDir, 'project', 'generated-plan.yaml'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
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

describe('preflight de intenção — PROHIBITION != REQUEST e opções verdadeiras', () => {
  async function selfLikeExternal(bodyLines: readonly string[], header = 'target:\n  type: repository\n  path: TARGET\n') {
    const target = await gitRepo('agentlab-rd-gate-');
    const runs = await mkdtemp(path.join(os.tmpdir(), 'agentlab-rd-runs-'));
    created.push(runs);
    const raw = directive({
      header: header.replace('TARGET', target),
      body: `${bodyLines.join('\n')}\n`,
    });
    return submitRunDirective({
      raw_directive: raw,
      instruction_source: 'stdin',
      env: { AGENTLAB_FAKE_MODE: '1', AGENTLAB_RUNS_DIR: runs },
      run_project: fakeProject,
    });
  }

  it('salvaguardas NEGATIVAS no corpo (PT+EN) não geram gate humano', async () => {
    const result = await selfLikeExternal([
      '# Objective',
      'Fix the budget defect.',
      '# Safety',
      '- no force push.',
      '- não fazer ações destrutivas;',
      '- never use an API key;',
      '- do not deploy to production.',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.payload['stopped_by']).toBe('ALL_DONE');
  });

  it('pedido AFIRMATIVO destrutivo continua gated e as opções não oferecem grant impossível', async () => {
    const result = await selfLikeExternal([
      '# Objective',
      'Clean the repository history: do a force push of the rewritten branch.',
    ]);
    expect(result.exitCode).toBe(9);
    expect(result.payload['status']).toBe('HUMAN_REQUIRED');
    expect(result.payload['human_authority']).toBe('DESTRUCTIVE_ACTION');
    expect(result.payload['decision_needed']).toBe('DESTRUCTIVE_ACTION');
    const options = result.payload['options'] as string[];
    expect(options.join('\n')).not.toMatch(/conceder a categoria no header/);
    expect(options.join('\n')).toMatch(/nunca é concedível por Run Directive/);
  });

  it('intenção de push coberta por authorization.publish concedido não gera gate', async () => {
    const result = await selfLikeExternal(
      ['# Objective', 'Implement the fix and, at the end, git push to origin/main.'],
      'target:\n  type: repository\n  path: TARGET\nauthorization:\n  publish:\n    allowed: true\n    remote: origin\n    ref: main\n',
    );
    expect(result.exitCode).toBe(0);
    expect(result.payload['stopped_by']).toBe('ALL_DONE');
  });

  it('intenção de push SEM grant vira HUMAN_REQUIRED com a opção verdadeira de publish', async () => {
    const result = await selfLikeExternal([
      '# Objective',
      'Implement the fix and, at the end, git push to origin/main.',
    ]);
    expect(result.exitCode).toBe(9);
    expect(result.payload['decision_needed']).toBe('EXTERNAL_SIDE_EFFECT');
    const options = (result.payload['options'] as string[]).join('\n');
    expect(options).toMatch(/authorization\.publish/);
  });

  it('categoria never continua HUMAN_REQUIRED no resume; publish grant não gera falso gate no resume', async () => {
    const target = await gitRepo('agentlab-rd-resume-sem-');
    const runs = await mkdtemp(path.join(os.tmpdir(), 'agentlab-rd-resume-sem-runs-'));
    created.push(runs);
    let launched = 0;
    const spy = async () => {
      launched += 1;
      return fakeProject();
    };

    const destructive = await submitRunDirective({
      raw_directive: directive({
        header: `target:\n  type: repository\n  path: ${target}\n`,
        body: 'Clean the repository history: do a force push of the rewritten branch.\n',
      }),
      instruction_source: 'stdin',
      env: { AGENTLAB_FAKE_MODE: '1', AGENTLAB_RUNS_DIR: runs },
      run_project: spy,
    });
    expect(destructive.payload['decision_needed']).toBe('DESTRUCTIVE_ACTION');
    expect(launched).toBe(0);
    const destructiveResume = await resumeHumanInstruction({
      runtime_dir: destructive.payload['runtime_dir'] as string,
      env: { AGENTLAB_FAKE_MODE: '1', AGENTLAB_RUNS_DIR: runs },
      run_project: spy,
    });
    expect(destructiveResume.payload['decision_needed']).toBe('DESTRUCTIVE_ACTION');
    expect(destructiveResume.exitCode).toBe(9);
    expect(launched).toBe(0);

    const publishRuns = await mkdtemp(path.join(os.tmpdir(), 'agentlab-rd-resume-pub-runs-'));
    created.push(publishRuns);
    const published = await submitRunDirective({
      raw_directive: directive({
        header:
          `target:\n  type: repository\n  path: ${target}\n` +
          'authorization:\n  publish:\n    allowed: true\n    remote: origin\n    ref: main\n',
        body: 'Implement the fix and, at the end, git push to origin/main.\n',
      }),
      instruction_source: 'stdin',
      env: { AGENTLAB_FAKE_MODE: '1', AGENTLAB_RUNS_DIR: publishRuns },
      run_project: spy,
    });
    expect(published.exitCode).toBe(0);
    expect(launched).toBe(1);
    const publishedResume = await resumeHumanInstruction({
      runtime_dir: published.payload['runtime_dir'] as string,
      env: { AGENTLAB_FAKE_MODE: '1', AGENTLAB_RUNS_DIR: publishRuns },
      run_project: spy,
    });
    expect(publishedResume.exitCode).toBe(0);
    expect(launched).toBe(2);
    expect(publishedResume.payload['status']).not.toBe('HUMAN_REQUIRED');
  });
});

describe('instrução longa e progresso de lifecycle', () => {
  it('directive com corpo >10k atravessa o product path com corpo íntegro e eventos de progresso', async () => {
    const target = await gitRepo('agentlab-rd-long-');
    const runs = await mkdtemp(path.join(os.tmpdir(), 'agentlab-rd-runs-'));
    created.push(runs);
    const section = [
      '## Contexto',
      'O control plane orquestra; o worker implementa. Não fazer force push.',
      'Do not deploy to production. Nunca usar API key.',
    ].join('\n');
    const bodyLines = ['# Objective', 'Corrigir a fronteira de contrato do planner.'];
    while (bodyLines.join('\n').length < 12_000) bodyLines.push(section);
    const body = bodyLines.join('\n');
    const raw = directive({
      header: `target:\n  type: repository\n  path: ${target}\n`,
      body: `${body}\n`,
    });

    const stages: string[] = [];
    const result = await submitRunDirective({
      raw_directive: raw,
      instruction_source: 'stdin',
      env: { AGENTLAB_FAKE_MODE: '1', AGENTLAB_RUNS_DIR: runs },
      run_project: fakeProject,
      on_progress: (event) => stages.push(event.stage),
    });

    expect(result.exitCode).toBe(0);
    const intake = await loadPersistedIntake(result.payload['intake_file'] as string);
    // Byte equality: truncation silenciosa reprovaria aqui.
    expect(Buffer.from(intake.user_request, 'utf8').equals(Buffer.from(body, 'utf8'))).toBe(true);

    // Eventos semânticos, na ordem do lifecycle (subset ordenado, sem snapshot).
    const expected = ['PREFLIGHT', 'TARGET_READY', 'AUTHORIZED', 'ALL_DONE'];
    const positions = expected.map((stage) => stages.indexOf(stage));
    expect(positions.every((index) => index >= 0)).toBe(true);
    expect([...positions]).toEqual([...positions].sort((a, b) => a - b));
  });
});
