import { describe, expect, it } from 'vitest';
import { parseRunDirective } from '../../src/intake/index.js';
import { buildWizardRunDirective } from '../../dev/lib/lab-wizard-directive.js';

describe('buildWizardRunDirective', () => {
  it('builds a repository target without hidden defaults', () => {
    const parsed = parseRunDirective(buildWizardRunDirective({
      target: { type: 'repository', path: '/work/app' }, action: 'implement', objective: 'Add account recovery.',
    }));
    expect(parsed.header).toEqual({ version: 1, target: { type: 'repository', path: '/work/app' } });
    expect(parsed.body).toContain('Add account recovery.');
  });
  it('builds the canonical self target', () => {
    expect(parseRunDirective(buildWizardRunDirective({ target: { type: 'self' }, action: 'fix', objective: 'Correct CLI copy.' })).header?.target)
      .toEqual({ type: 'self' });
  });
});
