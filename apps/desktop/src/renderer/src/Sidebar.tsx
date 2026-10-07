import type { ProjectView } from '../../shared/ipc';
import { STATE_LABEL } from './format';

interface Props {
  readonly projects: readonly ProjectView[];
  readonly selectedId: string | null;
  readonly onSelect: (projectId: string) => void;
  readonly onAdd: () => void;
}

/** Pools da visão §2. Leitura real entra na Fase 3; até lá, desconhecido (nunca 0%). */
const POOLS = ['Claude 5h · 7d', 'OpenAI primary · semanal', 'OpenCode Go'];

export function Sidebar({ projects, selectedId, onSelect, onAdd }: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="brand">Agent Strategy Lab</span>
      </div>
      <div className="sidebar-section">
        <div className="section-title">
          <span>Projetos</span>
          <button className="icon-button" onClick={onAdd} title="Adicionar projeto" aria-label="Adicionar projeto">
            +
          </button>
        </div>
        {projects.length === 0 ? <p className="muted small pad">Nenhum projeto. Adicione um repositório Git.</p> : null}
        <ul className="project-list">
          {projects.map((project) => (
            <li key={project.id}>
              <button
                className={`project-item${project.id === selectedId ? ' selected' : ''}`}
                onClick={() => onSelect(project.id)}
                title={project.repo}
              >
                <span className={`dot state-${project.state}`} aria-hidden />
                <span className="project-name">{project.name}</span>
                <span className="project-meta">
                  {project.progress === null ? STATE_LABEL[project.state] : `${project.progress.done}/${project.progress.total}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="sidebar-foot">
        <div className="section-title">
          <span>Quota</span>
        </div>
        {POOLS.map((pool) => (
          <div className="meter" key={pool} title="Medidores entram na Fase 3">
            <span className="meter-name">{pool}</span>
            <span className="meter-value muted">desconhecido</span>
          </div>
        ))}
      </div>
    </aside>
  );
}
