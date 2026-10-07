import { useEffect, useRef } from 'react';

import type { StepHeader, StepHistoryView, TranscriptItem } from '../../shared/ipc';
import { duration, TIER_LETTER, tokens } from './format';

interface Props {
  readonly history: readonly StepHistoryView[];
  readonly header: StepHeader | null;
  readonly items: readonly TranscriptItem[];
  readonly running: boolean;
}

const HISTORY_ICON: Readonly<Record<StepHistoryView['status'], string>> = {
  done: '✓',
  failed: '⚠',
  interrupted: '⏹',
  running: '●',
  pending: '○',
};

function HistoryLine({ step }: { readonly step: StepHistoryView }) {
  return (
    <div className={`history-line history-${step.status}`}>
      <span className="step-icon">{HISTORY_ICON[step.status]}</span>
      <span className="step-id">{step.stepId}</span>
      <span className="history-title">{step.title}</span>
      <span className="history-meta">
        {step.commitSha !== null ? <code>{step.commitSha.slice(0, 7)}</code> : null}
        <span>{duration(step.durationMs)}</span>
        <span>{tokens(step.tokensTotal)}</span>
        {step.model !== null ? <span className="muted">{step.model}</span> : null}
        {step.attempts > 1 ? <span className="muted">{step.attempts} tentativas</span> : null}
      </span>
    </div>
  );
}

function Item({ item, previous }: { readonly item: TranscriptItem; readonly previous: TranscriptItem | undefined }) {
  switch (item.kind) {
    case 'attempt':
      return item.attemptNo > 1 ? (
        <div className="attempt-divider">
          tentativa {item.attemptNo} · {item.model}
        </div>
      ) : null;
    case 'message':
      return <div className={`message message-${item.role}`}>{item.text}</div>;
    case 'tool_call':
      return (
        <div className="tool">
          <span className="tool-name">{item.name}</span>
          <span className="tool-summary">{item.summary}</span>
        </div>
      );
    case 'tool_result':
      if (item.status === 'denied') {
        return (
          <div className="tool tool-denied">
            <span className="tool-name">negado</span>
            <span className="tool-summary">{item.summary}</span>
          </div>
        );
      }
      if (item.status === 'error') {
        return (
          <div className="tool tool-error">
            <span className="tool-name">{item.name} falhou</span>
            <span className="tool-summary">{item.summary}</span>
          </div>
        );
      }
      // Resultado ok logo depois da chamada não acrescenta nada; o OpenCode só emite o resultado.
      return previous?.kind === 'tool_call' ? null : (
        <div className="tool">
          <span className="tool-name">{item.name}</span>
          <span className="tool-summary">{item.summary}</span>
        </div>
      );
    case 'attempt_finished':
      return item.outcome === 'success' ? (
        <div className="outcome outcome-ok">tentativa concluída</div>
      ) : (
        <div className="outcome outcome-fail">
          <strong>{item.outcome}</strong>
          {item.error !== null ? <pre>{item.error}</pre> : null}
        </div>
      );
  }
}

export function Transcript({ history, header, items, running }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const element = scroller.current;
    if (element !== null && pinned.current) element.scrollTop = element.scrollHeight;
  }, [items, history]);

  // Steps anteriores ao corrente, numa linha cada.
  const previous = history.filter((step) => step.stepId !== header?.stepId && step.status !== 'pending');

  return (
    <div
      className="transcript"
      ref={scroller}
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
      }}
    >
      <div className="transcript-inner">
        {previous.map((step) => (
          <HistoryLine key={step.stepId} step={step} />
        ))}
        {header !== null ? (
          <div className="step-header">
            <span className={`tier tier-${header.tier}`}>{TIER_LETTER[header.tier]}</span>
            <span className="step-id">{header.stepId}</span>
            <span className="step-header-title">{header.title}</span>
            <span className="step-header-meta">
              {header.model} · tentativa {header.attemptNo}
            </span>
          </div>
        ) : null}
        {items.map((item, index) => (
          <Item key={index} item={item} previous={items[index - 1]} />
        ))}
        {running && header !== null ? <div className="working">trabalhando…</div> : null}
        {header === null && previous.length === 0 ? (
          <p className="muted empty">Nenhum step rodou ainda. Confira o plano à direita e clique em Iniciar.</p>
        ) : null}
      </div>
    </div>
  );
}
