import { z } from 'zod';

export const CommitOwner = z.enum(['worker', 'orchestrator']);
export type CommitOwner = z.infer<typeof CommitOwner>;

export const OfficialValidationOwner = z.enum(['worker', 'orchestrator']);
export type OfficialValidationOwner = z.infer<typeof OfficialValidationOwner>;

export const WorkerValidationPolicy = z.enum(['full', 'targeted']);
export type WorkerValidationPolicy = z.infer<typeof WorkerValidationPolicy>;

export const LEGACY_EXECUTION_POLICY = {
  commit_owner: 'worker',
  official_validation_owner: 'worker',
  worker_validation_policy: 'full',
} as const;

export const ORCHESTRATED_EXECUTION_POLICY = {
  commit_owner: 'orchestrator',
  official_validation_owner: 'orchestrator',
  worker_validation_policy: 'targeted',
} as const;

function isImplementedPolicy(policy: {
  readonly commit_owner: CommitOwner;
  readonly official_validation_owner: OfficialValidationOwner;
  readonly worker_validation_policy: WorkerValidationPolicy;
}): boolean {
  return (
    (policy.commit_owner === 'worker' &&
      policy.official_validation_owner === 'worker' &&
      policy.worker_validation_policy === 'full') ||
    (policy.commit_owner === 'orchestrator' &&
      policy.official_validation_owner === 'orchestrator' &&
      policy.worker_validation_policy === 'targeted')
  );
}

export const ExecutionPolicy = z
  .object({
    commit_owner: CommitOwner,
    official_validation_owner: OfficialValidationOwner,
    worker_validation_policy: WorkerValidationPolicy,
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (!isImplementedPolicy(policy)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'combinação de execution policy não suportada',
      });
    }
  });
export type ExecutionPolicy = z.infer<typeof ExecutionPolicy>;

export function executionPolicyOf(profile: {
  readonly commit_owner: CommitOwner;
  readonly official_validation_owner: OfficialValidationOwner;
  readonly worker_validation_policy: WorkerValidationPolicy;
}): ExecutionPolicy {
  return ExecutionPolicy.parse({
    commit_owner: profile.commit_owner,
    official_validation_owner: profile.official_validation_owner,
    worker_validation_policy: profile.worker_validation_policy,
  });
}
