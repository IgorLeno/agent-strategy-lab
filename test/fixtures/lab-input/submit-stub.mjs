import { writeFileSync } from 'node:fs';

export class LabRunError extends Error {}
const forbidden = () => { throw new Error('Execution is forbidden in the input fixture'); };
export const authorizeAdditionalRepairForRuntime = forbidden;
export const authorizeProviderExpansionForRuntime = forbidden;
export const resumeHumanInstruction = forbidden;
export const formatRunSummary = forbidden;
export async function submitRunDirective(options) {
  writeFileSync(process.env.AGENTLAB_INPUT_CAPTURE, options.raw_directive);
  options.on_progress({ stage: 'PREFLIGHT' });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  return { payload: { input_fixture: true }, exitCode: 0 };
}
