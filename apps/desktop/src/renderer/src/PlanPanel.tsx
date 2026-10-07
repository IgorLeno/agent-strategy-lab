import type { PlanResult, PlanStepView } from '../../shared/ipc';
import { TIER_LETTER, TIER_NAME } from './format';

interface Props {
  readonly plan: PlanResult | null;
  readonly gateCommand: string | null;
  readonly onOpen: (path: string) => void;
}

const STEP_ICON: Readonly<Record<PlanStepView['state'], string>> = { pending: '○', running: '●', done: '✓', failed: '⚠' };

function groupByPhase(steps: readonly PlanStepView[]): [string | null, PlanStepView[]][] {
  const groups: [string | null, PlanStepView[]][] = [];
  for (const step of steps) {
    const last = groups.at(-1);
    if (last !== undefined && last[0] === step.phase) last[1].push(step);
    else groups.push([step.phase, [step]]);
  }
  return groups;
}

export function PlanPanel({ plan, gateCommand, onOpen }: Props) {
  return (
    <aside className="plan-panel">
      <div className="panel-head">
        <span className="section-title-text">Plano</span>
        {plan?.plan != null ? (
          <button className="link-button" onClick={() => onOpen(plan.plan.path)} title={plan.plan.path}>
            Abrir plan.md
          </button>
        ) : null}
      </div>
      <div className="plan-body">
        {plan === null ? <p className="muted small pad">Carregando…</p> : null}
        {plan?.error != null ? <p className="warn small pad">{plan.error}</p> : null}
        {plan?.plan != null ? (
          <>
            {plan.plan.title !== null ? <h2 className="plan-title">{plan.plan.title}</h2> : null}
            {groupByPhase(plan.plan.steps).map(([phase, steps]) => (
              <section className="phase" key={`${phase ?? ''}-${steps[0]?.id ?? ''}`}>
                {phase !== null ? <h3 className="phase-title">{phase}</h3> : null}
                <ul className="step-list">
                  {steps.map((step) => (
                    <li key={step.id} className={`plan-step step-${step.state}`} title={step.body || step.title}>
                      <span className="step-icon" aria-label={step.state}>
                        {STEP_ICON[step.state]}
                      </span>
                      <span className="step-id">{step.id}</span>
                      <span className="step-title">{step.title}</span>
                      <span className={`tier tier-${step.tier}`} title={TIER_NAME[step.tier]}>
                        {TIER_LETTER[step.tier]}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </>
        ) : null}
      </div>
      <div className="panel-foot">
        <span className="muted small">Gate</span>
        <code className="gate">{gateCommand ?? 'sem gate'}</code>
      </div>
    </aside>
  );
}
