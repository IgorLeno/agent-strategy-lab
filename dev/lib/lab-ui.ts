/**
 * Escolha de interface do `pnpm lab run` / `dev-run-project`.
 *
 * `auto` usa a TUI num terminal interativo e o log plain em qualquer outro
 * lugar (CI, pipe, redirecionamento). A saída de MÁQUINA nunca é afetada: os
 * dois modos escrevem em stderr, e stdout continua reservado ao payload JSON.
 *
 * A TUI repinta por evento e, num terminal, também a cada segundo — é o que
 * torna um worker demorado distinguível de um Lab travado sem que o renderer
 * precise consultar processo, arquivo ou Git para descobrir isso.
 */
import { createProgressRenderer, type LabProgressListener } from './lab-progress.js';
import { createLabProjection, type LabRunProjection } from './lab-projection.js';
import { createLabTuiWriter, resolveLabUiMode, type LabUiMode } from './lab-tui.js';

export interface LabUiOptions {
  readonly mode: LabUiMode;
  readonly isTTY: boolean;
  readonly write: (chunk: string) => void;
  readonly title: string;
  readonly columns?: number;
  readonly now?: () => number;
  /** Intervalo de repintura; `0` desliga (usado nos testes). */
  readonly repaintIntervalMs?: number;
}

export interface LabUi {
  readonly listener: LabProgressListener;
  readonly resolved: 'tui' | 'plain';
  /** Frame final e liberação do timer; idempotente. */
  finish(): void;
  /** Projeção corrente; `null` no modo plain. */
  snapshot(): LabRunProjection | null;
}

export function createLabUi(options: LabUiOptions): LabUi {
  const resolved = resolveLabUiMode(options.mode, options.isTTY);
  if (resolved === 'plain') {
    const listener = createProgressRenderer(options.write, options.now);
    return { listener, resolved, finish: () => {}, snapshot: () => null };
  }

  const projection = createLabProjection(options.now);
  const writer = createLabTuiWriter({
    write: options.write,
    title: options.title,
    ansi: options.isTTY,
    ...(options.columns === undefined ? {} : { columns: options.columns }),
  });
  const intervalMs = options.repaintIntervalMs ?? 1_000;
  let waitingForInput = false;
  const timer =
    intervalMs > 0 ? setInterval(() => {
      if (!waitingForInput) writer.paint(projection.snapshot());
    }, intervalMs) : null;
  timer?.unref();
  let finished = false;

  return {
    resolved,
    listener: (event) => {
      if (finished) return;
      projection.listener(event);
      if (event.stage === 'WAITING_FOR_INPUT') {
        // The prompt and terminal echo take ownership of the cursor. Seal the
        // frame so the first post-input repaint cannot erase the directive.
        if (!waitingForInput) writer.finish(projection.snapshot());
        waitingForInput = true;
        return;
      }
      waitingForInput = false;
      writer.paint(projection.snapshot());
    },
    finish: () => {
      if (finished) return;
      finished = true;
      if (timer !== null) clearInterval(timer);
      if (!waitingForInput) writer.finish(projection.snapshot());
    },
    snapshot: () => projection.snapshot(),
  };
}
