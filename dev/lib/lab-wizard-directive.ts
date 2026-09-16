import { stringify } from 'yaml';

import {
  AgentLabRunDirectiveHeader,
  parseRunDirective,
} from '../../src/intake/index.js';

export type WizardTarget =
  | { readonly type: 'repository'; readonly path: string }
  | { readonly type: 'self' };

export type WizardAction =
  | 'implement'
  | 'fix'
  | 'refactor'
  | 'investigate'
  | 'continue-plan'
  | 'validate'
  | 'other';

const labels: Record<WizardAction, string> = {
  implement: 'Implement feature',
  fix: 'Fix problem',
  refactor: 'Refactor',
  investigate: 'Investigate or audit',
  'continue-plan': 'Continue plan',
  validate: 'Run validation',
  other: 'Other',
};

export function buildWizardRunDirective(input: {
  readonly target: WizardTarget;
  readonly action: WizardAction;
  readonly objective: string;
}): string {
  const objective = input.objective.trim();
  if (!objective) throw new Error('Descreva o objetivo antes de continuar.');

  const header: AgentLabRunDirectiveHeader = { version: 1, target: input.target };
  const raw = `---agentlab\n${stringify(header)}---\nActivity: ${labels[input.action]}\n\n${objective}\n`;
  parseRunDirective(raw);
  return raw;
}
