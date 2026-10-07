import { useState } from 'react';

import type { GitMode, ProjectSettings, ProjectView } from '../../shared/ipc';
import { GIT_LABEL } from './format';

interface Props {
  readonly project: ProjectView;
  readonly onSave: (patch: Partial<ProjectSettings>) => Promise<boolean>;
  readonly onRemove: () => void;
  readonly onClose: () => void;
}

export function SettingsDialog({ project, onSave, onRemove, onClose }: Props) {
  const running = project.state === 'running' || project.state === 'pausing';
  const [gate, setGate] = useState(project.settings.gateCommand ?? '');
  const [retries, setRetries] = useState(String(project.settings.maxRetries));
  const [planPath, setPlanPath] = useState(project.settings.planRelPath);
  const [allowed, setAllowed] = useState(project.settings.allowedCommands.join('\n'));
  const [gitMode, setGitMode] = useState<GitMode>(project.settings.gitMode);

  const save = async (): Promise<void> => {
    const patch: { -readonly [K in keyof ProjectSettings]?: ProjectSettings[K] } = {
      gateCommand: gate.trim() === '' ? null : gate,
      maxRetries: Number(retries),
      allowedCommands: allowed.split('\n'),
    };
    if (!running) {
      patch.planRelPath = planPath;
      patch.gitMode = gitMode;
    }
    if (await onSave(patch)) onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="Configuração do projeto" onClick={(event) => event.stopPropagation()}>
        <h2>{project.name}</h2>
        <p className="muted small">{project.repo}</p>

        <label>
          Comando de gate
          <input value={gate} onChange={(event) => setGate(event.target.value)} placeholder="ex.: npm run typecheck && npm test" />
          <span className="hint">Roda depois de cada step; exit 0 = verde. Vazio = sem gate.</span>
        </label>

        <label>
          Retries por step
          <input type="number" min={0} max={20} value={retries} onChange={(event) => setRetries(event.target.value)} />
        </label>

        <label>
          Caminho do plano
          <input value={planPath} disabled={running} onChange={(event) => setPlanPath(event.target.value)} />
        </label>

        <label>
          Comandos liberados no modo Edit (um prefixo por linha)
          <textarea rows={3} value={allowed} onChange={(event) => setAllowed(event.target.value)} />
        </label>

        <fieldset disabled={running}>
          <legend>Git mode</legend>
          {(Object.keys(GIT_LABEL) as GitMode[]).map((mode) => (
            <label key={mode} className="radio">
              <input type="radio" name="git" checked={gitMode === mode} onChange={() => setGitMode(mode)} />
              {GIT_LABEL[mode]}
            </label>
          ))}
          {gitMode === 'direct' ? (
            <p className="warn small">Direto: cada step commita na branch atual do repositório, sem branch de plano.</p>
          ) : null}
        </fieldset>

        <div className="modal-actions">
          <button className="danger-link" disabled={running} onClick={onRemove}>
            Remover projeto do app
          </button>
          <span className="spacer" />
          <button onClick={onClose}>Cancelar</button>
          <button className="primary" onClick={() => void save()}>
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}
