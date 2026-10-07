import { useState } from 'react';

import { Composer } from './Composer';
import { STATE_LABEL } from './format';
import { PlanPanel } from './PlanPanel';
import { SettingsDialog } from './SettingsDialog';
import { Sidebar } from './Sidebar';
import { useAsl } from './state';
import { Transcript } from './Transcript';

export function App() {
  const [state, actions] = useAsl();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const project = state.projects.find((candidate) => candidate.id === state.selectedId) ?? null;

  return (
    <div className="app">
      <Sidebar projects={state.projects} selectedId={state.selectedId} onSelect={actions.select} onAdd={() => void actions.addProject()} />

      <main className="center">
        {state.warnings.map((warning) => (
          <div className="banner warn" key={warning}>
            {warning}
          </div>
        ))}
        {state.error !== null ? (
          <div className="banner error" role="alert">
            <span>{state.error}</span>
            <button className="link-button" onClick={actions.dismissError}>
              fechar
            </button>
          </div>
        ) : null}

        {project === null ? (
          <div className="welcome">
            <h1>Executor de plano</h1>
            <p className="muted">Adicione um repositório Git com um <code>.asl/plan.md</code> para começar.</p>
            <button className="primary" onClick={() => void actions.addProject()}>
              Adicionar projeto
            </button>
          </div>
        ) : (
          <>
            <header className="center-head">
              <div className="center-title">
                <h1>{project.name}</h1>
                <span className={`badge state-${project.state}`}>{STATE_LABEL[project.state]}</span>
                {project.stateDetail !== null ? <span className="state-detail">{project.stateDetail}</span> : null}
              </div>
              <button className="icon-button" onClick={() => setSettingsOpen(true)} title="Configuração do projeto" aria-label="Configuração do projeto">
                ⚙
              </button>
            </header>
            <Transcript
              history={state.history}
              header={state.header}
              items={state.items}
              running={project.state === 'running' || project.state === 'pausing'}
            />
            <Composer
              project={project}
              onSettings={(patch) => void actions.updateSettings(project.id, patch)}
              onStart={() => void actions.start(project.id)}
              onPause={() => void actions.pause(project.id)}
            />
          </>
        )}
      </main>

      {project !== null ? (
        <PlanPanel plan={state.plan} gateCommand={project.settings.gateCommand} onOpen={(path) => void actions.openPath(path)} />
      ) : (
        <aside className="plan-panel" />
      )}

      {settingsOpen && project !== null ? (
        <SettingsDialog
          project={project}
          onSave={(patch) => actions.updateSettings(project.id, patch)}
          onRemove={() => {
            setSettingsOpen(false);
            void actions.removeProject(project.id);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </div>
  );
}
