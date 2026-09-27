import { z } from 'zod';

/** What the app asks the controller to do with a scheduled task's changes in its source project. */
export const ScheduledSessionSourceChangesActionV1Schema = z.enum(['status', 'apply', 'undo']);
export type ScheduledSessionSourceChangesActionV1 = z.infer<typeof ScheduledSessionSourceChangesActionV1Schema>;

/**
 * The controller's answer. `applied` means the changes sit in the project as uncommitted edits;
 * `conflict` means nothing was written because these files changed in the project since dispatch;
 * `not_found` means the session is not a scheduled task this controller owns.
 */
export const ScheduledSessionSourceChangesResultV1Schema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not_applied') }),
  z.object({
    status: z.literal('applied'),
    appliedAt: z.number(),
    fileCount: z.number().int().nonnegative(),
    skippedIgnoredCount: z.number().int().nonnegative(),
  }),
  z.object({ status: z.literal('no_changes') }),
  z.object({ status: z.literal('conflict'), files: z.array(z.string()) }),
  z.object({ status: z.literal('undone') }),
  z.object({ status: z.literal('not_found') }),
  z.object({ status: z.literal('invalid_request') }),
]);
export type ScheduledSessionSourceChangesResultV1 = z.infer<typeof ScheduledSessionSourceChangesResultV1Schema>;
