import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

const run = promisify(execFile);
const APP_DIR = path.resolve(import.meta.dirname, '..');
const FAKE_AGENT = path.resolve(APP_DIR, '../../packages/core/test/fixtures/fake-agent.mjs');
const SHOTS = path.join(APP_DIR, 'test-results', 'screens');

async function git(cwd: string, args: string[]): Promise<string> {
  return (await run('git', args, { cwd })).stdout.trim();
}

let app: ElectronApplication;
let repo: string;

test.beforeEach(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'asl-ui-'));
  repo = path.join(root, 'demo-ui');
  await mkdir(path.join(repo, '.asl'), { recursive: true });
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 't@t']);
  await git(repo, ['config', 'user.name', 't']);
  await writeFile(path.join(repo, 'README.md'), 'demo\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'inicial']);
  await writeFile(
    path.join(repo, '.asl', 'plan.md'),
    '# Plano: Demo UI\n\n## Fase 1 — Base\n- [ ] 1.1 [economy] Primeiro\n- [ ] 1.2 Segundo\n\n## Fase 2 — Fim\n- [ ] 2.1 [premium] Terceiro\n',
  );
  const script = path.join(root, 'script.json');
  await writeFile(
    script,
    JSON.stringify({
      calls: [
        { files: { 'a.txt': '1' }, final: 'fiz 1.1', tokens: 1200 },
        { files: { 'b.txt': '2' }, final: 'fiz 1.2', tokens: 800, sleepMs: 2500 },
        { files: { 'c.txt': '3' }, final: 'fiz 2.1', tokens: 500 },
      ],
    }),
  );
  app = await electron.launch({
    args: [APP_DIR],
    env: {
      ...process.env,
      ASL_DATA_DIR: path.join(root, 'data'),
      ASL_FAKE_AGENT: FAKE_AGENT,
      ASL_FAKE_SCRIPT: script,
    },
  });
  // Diálogo nativo não é dirigível: o main devolve o repo de teste.
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog;
  }, repo);
});

test.afterEach(async () => {
  await app.close();
});

test('adicionar projeto, Step a step, pausar no meio, retomar e terminar', async () => {
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByRole('button', { name: 'Adicionar projeto' }).first().click();
  const sidebarItem = page.locator('.project-item', { hasText: 'demo-ui' });
  await expect(sidebarItem).toContainText('0/3');
  await expect(page.locator('.plan-step')).toHaveCount(3);
  await expect(page.locator('.plan-title')).toHaveText('Demo UI');

  // Step a step (padrão): roda um step e pausa na fronteira.
  await page.getByRole('button', { name: 'Iniciar' }).click();
  await expect(page.locator('.badge')).toHaveText('pausado');
  await expect(sidebarItem).toContainText('1/3');
  await expect(page.locator('.message', { hasText: 'chamada 0' })).toBeVisible();
  await expect(page.locator('.step-header')).toContainText('Primeiro');
  await expect(page.locator('.plan-step.step-done')).toHaveCount(1);
  await page.screenshot({ path: path.join(SHOTS, '1-step-a-step.png') });

  // Contínuo, e Pausar com o step 1.2 em curso: termina 1.2 e para.
  await page.getByRole('radio', { name: 'Contínuo' }).click();
  await page.getByRole('button', { name: 'Retomar' }).click();
  await expect(page.locator('.step-header')).toContainText('Segundo');
  await expect(page.locator('.plan-step.step-running')).toContainText('Segundo');
  await page.screenshot({ path: path.join(SHOTS, '2-rodando.png') });
  await page.getByRole('button', { name: 'Pausar' }).click();
  await expect(page.locator('.badge')).toHaveText('pausado');
  await expect(page.locator('.state-detail')).toHaveText('pausa pedida');
  await expect(sidebarItem).toContainText('2/3');

  // Retomar até o fim.
  await page.getByRole('button', { name: 'Retomar' }).click();
  await expect(page.locator('.badge')).toHaveText('concluído');
  await expect(sidebarItem).toContainText('3/3');
  await expect(page.locator('.history-line.history-done')).toHaveCount(2);
  await page.screenshot({ path: path.join(SHOTS, '3-concluido.png') });

  expect(await git(repo, ['log', '--format=%s'])).toBe(
    '2.1: Terceiro\n1.2: Segundo\n1.1: Primeiro\nasl: plano demo-ui\ninicial',
  );
});
