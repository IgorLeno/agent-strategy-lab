import type { Continuity, GitMode, PermissionMode, ProjectSettings, ProjectView } from '../../shared/ipc';
import { CONTINUITY_LABEL, GIT_LABEL, MODE_LABEL } from './format';

interface Props {
  readonly project: ProjectView;
  readonly onSettings: (patch: Partial<ProjectSettings>) => void;
  readonly onStart: () => void;
  readonly onPause: () => void;
}

function Segmented<T extends string>(props: {
  readonly label: string;
  readonly value: T;
  readonly options: Readonly<Record<T, string>>;
  readonly disabled?: boolean;
  readonly title?: string | undefined;
  readonly onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={props.label} title={props.title}>
      <span className="segmented-label">{props.label}</span>
      {(Object.keys(props.options) as T[]).map((option) => (
        <button
          key={option}
          role="radio"
          aria-checked={option === props.value}
          className={option === props.value ? 'active' : ''}
          disabled={props.disabled === true}
          onClick={() => option !== props.value && props.onChange(option)}
        >
          {props.options[option]}
        </button>
      ))}
    </div>
  );
}

export function Composer({ project, onSettings, onStart, onPause }: Props) {
  const running = project.state === 'running' || project.state === 'pausing';
  const resumable = project.state === 'paused' || project.state === 'error';
  return (
    <div className="composer">
      <div className="composer-controls">
        <Segmented<PermissionMode>
          label="Modo"
          value={project.settings.mode}
          options={MODE_LABEL}
          title="Vale a partir da próxima tentativa"
          onChange={(mode) => onSettings({ mode })}
        />
        <Segmented<Continuity>
          label="Continuidade"
          value={project.settings.continuity}
          options={CONTINUITY_LABEL}
          title="Vale a partir do próximo step"
          onChange={(continuity) => onSettings({ continuity })}
        />
        <Segmented<GitMode>
          label="Git"
          value={project.settings.gitMode}
          options={GIT_LABEL}
          disabled={running}
          title={running ? 'Git mode só muda com o loop parado' : undefined}
          onChange={(gitMode) => onSettings({ gitMode })}
        />
      </div>
      <div className="composer-actions">
        <button className="primary" disabled={running} onClick={onStart}>
          {resumable ? 'Retomar' : 'Iniciar'}
        </button>
        <button className="danger" disabled={project.state !== 'running'} onClick={onPause} title="Termina o step corrente e para">
          {project.state === 'pausing' ? 'Pausando…' : 'Pausar'}
        </button>
      </div>
    </div>
  );
}
