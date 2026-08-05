import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { canonicalSha256 } from './canonical.js';
import { PlanFile, type PlanTask } from './schemas.js';

export interface LoadedPlan {
  readonly plan: PlanFile;
  /** Hash canônico do plano parseado — reformatar o YAML não muda o hash. */
  readonly planSha256: string;
  readonly byId: ReadonlyMap<string, PlanTask>;
}

export function parsePlan(source: string): LoadedPlan {
  const plan = PlanFile.parse(parseYaml(source));
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  return { plan, planSha256: canonicalSha256(plan), byId };
}

export async function loadPlan(planFile: string): Promise<LoadedPlan> {
  return parsePlan(await readFile(planFile, 'utf8'));
}
