/**
 * Estado da UI. A fonte da verdade é o daemon: o renderer guarda o último
 * DTO recebido e relê plano/histórico quando o daemon avisa `plan_changed`.
 */
import { useCallback, useEffect, useReducer, useRef } from 'react';

import type {
  DaemonEvent,
  PlanResult,
  ProjectSettings,
  ProjectView,
  StepHeader,
  StepHistoryView,
  TranscriptItem,
} from '../../shared/ipc';

const TRANSCRIPT_LIMIT = 2_000;

export interface UiState {
  readonly projects: readonly ProjectView[];
  readonly selectedId: string | null;
  readonly plan: PlanResult | null;
  readonly history: readonly StepHistoryView[];
  readonly header: StepHeader | null;
  readonly items: readonly TranscriptItem[];
  readonly warnings: readonly string[];
  readonly error: string | null;
}

type Action =
  | { type: 'projects'; projects: readonly ProjectView[] }
  | { type: 'project'; project: ProjectView }
  | { type: 'removed'; projectId: string }
  | { type: 'select'; projectId: string | null }
  | { type: 'plan'; projectId: string; plan: PlanResult; history: readonly StepHistoryView[] }
  | { type: 'transcript'; projectId: string; header: StepHeader | null; items: readonly TranscriptItem[] }
  | { type: 'event'; event: DaemonEvent }
  | { type: 'warnings'; warnings: readonly string[] }
  | { type: 'error'; error: string | null };

const initial: UiState = {
  projects: [],
  selectedId: null,
  plan: null,
  history: [],
  header: null,
  items: [],
  warnings: [],
  error: null,
};

function reduce(state: UiState, action: Action): UiState {
  switch (action.type) {
    case 'projects':
      return {
        ...state,
        projects: action.projects,
        selectedId: state.selectedId ?? action.projects[0]?.id ?? null,
      };
    case 'project': {
      const exists = state.projects.some((project) => project.id === action.project.id);
      return {
        ...state,
        projects: exists
          ? state.projects.map((project) => (project.id === action.project.id ? action.project : project))
          : [...state.projects, action.project],
        selectedId: state.selectedId ?? action.project.id,
      };
    }
    case 'removed': {
      const projects = state.projects.filter((project) => project.id !== action.projectId);
      return state.selectedId === action.projectId
        ? { ...state, projects, selectedId: projects[0]?.id ?? null, plan: null, history: [], header: null, items: [] }
        : { ...state, projects };
    }
    case 'select':
      return action.projectId === state.selectedId
        ? state
        : { ...state, selectedId: action.projectId, plan: null, history: [], header: null, items: [] };
    case 'plan':
      return action.projectId === state.selectedId ? { ...state, plan: action.plan, history: action.history } : state;
    case 'transcript':
      return action.projectId === state.selectedId ? { ...state, header: action.header, items: action.items } : state;
    case 'event': {
      const event = action.event;
      if (event.type === 'project') return reduce(state, { type: 'project', project: event.project });
      if (event.projectId !== state.selectedId) return state;
      if (event.type === 'step_header') {
        // Tentativa nova do mesmo step mantém o transcript; step novo começa limpo.
        const sameStep = state.header?.stepId === event.header.stepId;
        return { ...state, header: event.header, items: sameStep ? state.items : [] };
      }
      if (event.type === 'transcript') {
        const items = [...state.items, event.item];
        return { ...state, items: items.length > TRANSCRIPT_LIMIT ? items.slice(-TRANSCRIPT_LIMIT) : items };
      }
      return state;
    }
    case 'warnings':
      return { ...state, warnings: action.warnings };
    case 'error':
      return { ...state, error: action.error };
  }
}

export interface UiActions {
  select(projectId: string): void;
  addProject(): Promise<void>;
  removeProject(projectId: string): Promise<void>;
  start(projectId: string): Promise<void>;
  pause(projectId: string): Promise<void>;
  updateSettings(projectId: string, patch: Partial<ProjectSettings>): Promise<boolean>;
  openPath(path: string): Promise<void>;
  dismissError(): void;
}

export function useAsl(): [UiState, UiActions] {
  const [state, dispatch] = useReducer(reduce, initial);
  const selected = useRef<string | null>(null);
  selected.current = state.selectedId;

  const fail = useCallback((error: unknown) => {
    dispatch({ type: 'error', error: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error) });
  }, []);

  const refreshPlan = useCallback(
    async (projectId: string) => {
      try {
        const [plan, history] = await Promise.all([
          window.asl.invoke('getPlan', { projectId }),
          window.asl.invoke('getHistory', { projectId }),
        ]);
        dispatch({ type: 'plan', projectId, plan, history });
      } catch (error) {
        fail(error);
      }
    },
    [fail],
  );

  useEffect(() => {
    const unsubscribe = window.asl.onEvent((event) => {
      dispatch({ type: 'event', event });
      if (event.type === 'plan_changed' && event.projectId === selected.current) void refreshPlan(event.projectId);
    });
    window.asl.invoke('listProjects', {}).then((projects) => dispatch({ type: 'projects', projects }), fail);
    window.asl.invoke('getAppInfo', {}).then((info) => dispatch({ type: 'warnings', warnings: info.warnings }), fail);
    return unsubscribe;
  }, [fail, refreshPlan]);

  useEffect(() => {
    const projectId = state.selectedId;
    if (projectId === null) return;
    void refreshPlan(projectId);
    window.asl.invoke('getTranscript', { projectId }).then(
      (transcript) => dispatch({ type: 'transcript', projectId, header: transcript.header, items: transcript.items }),
      fail,
    );
  }, [state.selectedId, refreshPlan, fail]);

  const actions: UiActions = {
    select: (projectId) => dispatch({ type: 'select', projectId }),
    addProject: async () => {
      try {
        const dir = await window.asl.invoke('pickDirectory', {});
        if (dir === null) return;
        const project = await window.asl.invoke('addProject', { repo: dir });
        dispatch({ type: 'project', project });
        dispatch({ type: 'select', projectId: project.id });
      } catch (error) {
        fail(error);
      }
    },
    removeProject: async (projectId) => {
      try {
        await window.asl.invoke('removeProject', { projectId });
        dispatch({ type: 'removed', projectId });
      } catch (error) {
        fail(error);
      }
    },
    start: async (projectId) => {
      try {
        await window.asl.invoke('start', { projectId });
      } catch (error) {
        fail(error);
      }
    },
    pause: async (projectId) => {
      try {
        await window.asl.invoke('pause', { projectId });
      } catch (error) {
        fail(error);
      }
    },
    updateSettings: async (projectId, patch) => {
      try {
        const project = await window.asl.invoke('updateSettings', { projectId, patch });
        dispatch({ type: 'project', project });
        if (patch.planRelPath !== undefined) void refreshPlan(projectId);
        return true;
      } catch (error) {
        fail(error);
        return false;
      }
    },
    openPath: async (path) => {
      try {
        await window.asl.invoke('openPath', { path });
      } catch (error) {
        fail(error);
      }
    },
    dismissError: () => dispatch({ type: 'error', error: null }),
  };
  return [state, actions];
}
