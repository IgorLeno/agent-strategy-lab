/**
 * Projetos cadastrados no app e a configuração de cada um, num JSON.
 * Só o daemon escreve (ele tem o lock de instância); escrita por arquivo
 * temporário + rename para não deixar JSON pela metade num crash.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { DEFAULT_SETTINGS, type ProjectSettings } from '../shared/ipc.js';

export interface ProjectRecord {
  readonly id: string;
  readonly repo: string;
  readonly name: string;
  readonly settings: ProjectSettings;
}

export class ProjectsStore {
  private records: ProjectRecord[];

  constructor(private readonly file: string) {
    this.records = ProjectsStore.load(file);
  }

  private static load(file: string): ProjectRecord[] {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const parsed = JSON.parse(text) as { projects?: ProjectRecord[] };
    // Campos novos de configuração ganham o padrão em arquivos antigos.
    return (parsed.projects ?? []).map((record) => ({ ...record, settings: { ...DEFAULT_SETTINGS, ...record.settings } }));
  }

  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ projects: this.records }, null, 2)}\n`);
    renameSync(tmp, this.file);
  }

  all(): readonly ProjectRecord[] {
    return this.records;
  }

  get(id: string): ProjectRecord {
    const record = this.records.find((candidate) => candidate.id === id);
    if (record === undefined) throw new Error(`projeto desconhecido: ${id}`);
    return record;
  }

  add(record: ProjectRecord): void {
    this.records = [...this.records, record];
    this.save();
  }

  remove(id: string): void {
    this.records = this.records.filter((record) => record.id !== id);
    this.save();
  }

  updateSettings(id: string, patch: Partial<ProjectSettings>): ProjectRecord {
    const current = this.get(id);
    const updated: ProjectRecord = { ...current, settings: { ...current.settings, ...patch } };
    this.records = this.records.map((record) => (record.id === id ? updated : record));
    this.save();
    return updated;
  }
}
