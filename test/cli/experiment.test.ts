import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ExecutionStatus } from '../../src/core/index.js';
import { runPilotCli } from '../../src/cli/experiment.js';
import { buildPilotExperimentSpec } from '../../src/experiment/index.js';
import { runAgentlabCli } from './helpers.js';

const FIVE_HOUR = 'Aug 16, 7am (America/Sao_Paulo)';
const SEVEN_DAY = 'Aug 18, 3am (America/Sao_Paulo)';
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-experiment-cli-'));
  temporaryRoots.push(root);
  return root;
}

function authorization() {
  return {
    authorization: { value: 'AUTHORIZED', provenance: 'human_operator_fixture' },
    billing_mode: { value: 'SUBSCRIPTION', provenance: 'pilot_billing_policy' },
    quota: {
      availability: { value: null, provenance: 'not_yet_observed' },
      remaining: { value: null, provenance: 'not_yet_observed' },
      unit: null,
    },
    cost: {
      api_equivalent_usd: { value: null, provenance: 'subscription' },
      projected_incremental_charge_usd: { value: null, provenance: 'subscription' },
      actual_incremental_charge_usd: { value: null, provenance: 'subscription' },
      actual_incremental_charge_authoritative: false,
    },
    budget: { maximum_incremental_charge_usd: { value: null, provenance: 'subscription' } },
  };
}

describe('agentlab experiment --pilot (processo)', () => {
  it('dry-run inspeciona o spec congelado sem provider e sem autorizar', async () => {
    const frozen = await buildPilotExperimentSpec(path.resolve('.'));
    const result = await runAgentlabCli(['experiment', '--pilot', '--dry-run']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('experiment: dry-run');
    expect(result.stdout).toContain(`hash=${frozen.hash}`);
    expect(result.stdout).toContain('planned_slot_count=12');
    expect(result.stdout).toContain('quota_stop_threshold_pct=80');
    expect(result.stdout).toContain('observe_quota=claude_quota_probe');
    expect(result.stdout).toContain('authorizes_real_inference=false');
    expect(result.stdout).toContain('NÃO autoriza o piloto');
  });

  it('sem --pilot, falha e não executa slots', async () => {
    const result = await runAgentlabCli(['experiment']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--pilot');
  });

  it('--execute sem --confirm-real-inference não lança slot real', async () => {
    const result = await runAgentlabCli(['experiment', '--pilot', '--execute']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--confirm-real-inference');
  });

  it('--execute com confirm mas sem --input não lança slot real', async () => {
    const result = await runAgentlabCli(['experiment', '--pilot', '--execute', '--confirm-real-inference']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--input');
  });
});

describe('runPilotCli --execute (sem provider real)', () => {
  it('injeta a quota observer Claude e bloqueia em 80% antes do executor', async () => {
    const dir = await temporaryRoot();
    const inputPath = path.join(dir, 'authorization.json');
    await writeFile(
      inputPath,
      JSON.stringify({
        source_repo: dir,
        base_sha: 'a'.repeat(40),
        real_execution_authorization: authorization(),
      }),
      'utf8',
    );

    const executed: string[] = [];
    let probes = 0;
    const chunks: string[] = [];

    const code = await runPilotCli({
      args: ['--pilot', '--execute', '--confirm-real-inference', '--input', inputPath],
      stdout: (chunk) => chunks.push(chunk),
      stderr: (chunk) => chunks.push(chunk),
      quotaProbe: {
        binary: 'claude-fixture',
        env: {},
        cwd: '/',
        runner: async () => {
          probes += 1;
          expect(executed).toEqual([]);
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              is_error: false,
              total_cost_usd: 0,
              num_turns: 0,
              usage: { input_tokens: 0, output_tokens: 0 },
              modelUsage: {},
              result:
                `Current session: 80% used · resets ${FIVE_HOUR}\n` +
                `Current week (all models): 10% used · resets ${SEVEN_DAY}\n`,
            }),
            stderr: '',
          };
        },
      },
      executeSlot: (slot) => {
        executed.push(slot.slot_id);
        return ExecutionStatus.COMPLETED;
      },
    });

    expect(code).toBe(1);
    expect(executed).toEqual([]);
    expect(probes).toBe(1);
    expect(chunks.join('')).toContain('observe_quota=claude_quota_probe');
    expect(chunks.join('')).toContain('QUOTA_INSUFFICIENT');
  });

  it('sem autorização humana não fabrica AUTHORIZED e bloqueia antes de qualquer probe', async () => {
    let probes = 0;
    const executed: string[] = [];
    const chunks: string[] = [];
    const dir = await temporaryRoot();
    const inputPath = path.join(dir, 'authorization.json');
    await writeFile(
      inputPath,
      JSON.stringify({
        source_repo: dir,
        base_sha: 'a'.repeat(40),
        real_execution_authorization: {
          ...authorization(),
          authorization: { value: 'DENIED', provenance: 'human_operator_fixture' },
        },
      }),
      'utf8',
    );

    const code = await runPilotCli({
      args: ['--pilot', '--execute', '--confirm-real-inference', '--input', inputPath],
      stdout: (chunk) => chunks.push(chunk),
      stderr: (chunk) => chunks.push(chunk),
      quotaProbe: {
        binary: 'claude-fixture',
        env: {},
        cwd: '/',
        runner: async () => {
          probes += 1;
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      },
      executeSlot: (slot) => {
        executed.push(slot.slot_id);
        return ExecutionStatus.COMPLETED;
      },
    });

    expect(code).toBe(1);
    expect(executed).toEqual([]);
    expect(probes).toBe(0);
    expect(chunks.join('')).toContain('AUTHORIZATION_DENIED');
  });
});
