import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { SessionSchedulingLeaseV1Schema, type SessionSchedulingLeaseV1 } from '@happier-dev/protocol';
import * as z from 'zod';

import { startSingleFlightIntervalLoop, type SingleFlightIntervalLoopHandle } from '@/daemon/lifecycle/singleFlightIntervalLoop';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import type { TwinSessionReleaseResult } from './twinSessionScheduler';

export type { TwinSessionReleaseResult } from './twinSessionScheduler';

export const TWIN_SESSION_RELEASE_OUTBOX_CONFIG_ENV_KEY = 'HAPPIER_TWIN_SESSION_RELEASE_OUTBOX_CONFIG_JSON';

const TwinSessionReleaseOutboxConfigSchema = z.object({
  v: z.literal(1),
  pollIntervalMs: z.number().int().positive(),
}).strict();

export type TwinSessionReleaseOutboxConfig = z.infer<typeof TwinSessionReleaseOutboxConfigSchema>;

export function resolveTwinSessionReleaseOutboxConfig(
  env: NodeJS.ProcessEnv = process.env,
): TwinSessionReleaseOutboxConfig | null {
  const raw = env[TWIN_SESSION_RELEASE_OUTBOX_CONFIG_ENV_KEY]?.trim() ?? '';
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid ${TWIN_SESSION_RELEASE_OUTBOX_CONFIG_ENV_KEY} JSON`);
  }
  return TwinSessionReleaseOutboxConfigSchema.parse(parsed);
}

export type TwinSessionReleaseNotification = Readonly<{
  lease: SessionSchedulingLeaseV1;
  sessionId: string;
  receipt?: string;
}>;

const ReleaseNotificationSchema = z.object({
  v: z.literal(1),
  lease: SessionSchedulingLeaseV1Schema,
  sessionId: z.string().trim().min(1),
  receipt: z.string().trim().min(1).optional(),
}).strict();

function notificationPath(directory: string, notification: TwinSessionReleaseNotification): string {
  const digest = createHash('sha256')
    .update(notification.lease.controllerMachineId)
    .update('\0')
    .update(notification.lease.leaseId)
    .update('\0')
    .update(notification.sessionId)
    .digest('hex');
  return join(directory, `${digest}.json`);
}

export function createTwinSessionReleaseOutbox(params: Readonly<{
  directory: string;
  pollIntervalMs: number;
  deliver: (notification: TwinSessionReleaseNotification) => Promise<TwinSessionReleaseResult>;
  logWarning: (message: string, error: unknown) => void;
}>) {
  let loop: SingleFlightIntervalLoopHandle | null = null;
  let drainInFlight: Promise<void> | null = null;
  const ensureDirectory = async (): Promise<void> => {
    await mkdir(params.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(params.directory, 0o700);
  };
  const drainOnce = async (): Promise<void> => {
    await ensureDirectory();
    const entries = (await readdir(params.directory)).filter((name) => name.endsWith('.json')).sort();
    for (const entry of entries) {
      const path = join(params.directory, entry);
      try {
        const parsed = ReleaseNotificationSchema.parse(JSON.parse(await readFile(path, 'utf8')));
        const notification: TwinSessionReleaseNotification = {
          lease: parsed.lease,
          sessionId: parsed.sessionId,
          ...(parsed.receipt ? { receipt: parsed.receipt } : {}),
        };
        const result = await params.deliver(notification);
        // The controller holds no attempt this notification can ever match (for example a child that
        // crashed before its webhook reported a placeholder id after a retry already released), so
        // redelivery can never succeed; drop it loudly instead of retrying every poll forever.
        if (result.status === 'mismatch' || result.status === 'not_found') {
          params.logWarning(
            `Twin session release outbox dropped an unmatched notification (${result.status}, `
              + `attempt ${notification.lease.attemptLookupId}, session ${notification.sessionId})`,
            null,
          );
          await unlink(path).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
          continue;
        }
        if (result.status === 'acknowledged') {
          await unlink(path).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
          continue;
        }
        if ((result.status === 'released' || result.status === 'pending') && result.receipt) {
          const acknowledgedNotification = ReleaseNotificationSchema.parse({
            v: 1,
            ...notification,
            receipt: result.receipt,
          });
          await writeJsonAtomic(path, acknowledgedNotification);
          if (!notification.receipt) {
            const acknowledgement = await params.deliver({
              lease: acknowledgedNotification.lease,
              sessionId: acknowledgedNotification.sessionId,
              receipt: acknowledgedNotification.receipt,
            });
            if (acknowledgement.status === 'acknowledged') {
              await unlink(path).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== 'ENOENT') throw error;
              });
            }
          }
        }
      } catch (error) {
        params.logWarning('Twin session release outbox delivery failed', error);
      }
    }
  };
  const drain = async (): Promise<void> => {
    if (drainInFlight) return await drainInFlight;
    drainInFlight = drainOnce().finally(() => {
      drainInFlight = null;
    });
    return await drainInFlight;
  };

  return {
    enqueue: async (notification: TwinSessionReleaseNotification): Promise<void> => {
      const parsed = ReleaseNotificationSchema.parse({ v: 1, ...notification });
      await ensureDirectory();
      await writeJsonAtomic(notificationPath(params.directory, notification), parsed);
      await drain();
    },
    drain,
    start: async (): Promise<void> => {
      if (loop) return;
      await drain();
      loop = startSingleFlightIntervalLoop({
        intervalMs: params.pollIntervalMs,
        task: drain,
        onError: (error) => params.logWarning('Twin session release outbox drain failed', error),
        unref: true,
      });
    },
    stop: (): void => {
      loop?.stop();
      loop = null;
    },
  };
}
