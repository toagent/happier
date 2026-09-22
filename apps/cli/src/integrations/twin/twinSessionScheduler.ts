import { createHash } from 'node:crypto';

import {
  SPAWN_SESSION_ERROR_CODES,
  type SessionSchedulingLeaseV1,
  type SpawnSessionNonceResolution,
} from '@happier-dev/protocol';

import type { SpawnSessionOptions, SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';

export type TwinSessionLeaseState = Readonly<{
  state: 'queued' | 'acquired' | 'released';
  queuePosition?: number;
}>;

export type TwinSessionSchedulerAttempt = Readonly<{
  v: 1;
  spawnNonce: string;
  requestDigest: string;
  workerId: string;
  machineId: string;
  leaseId: string;
  ownerToken: string;
  phase: 'created' | 'queued' | 'dispatching' | 'running' | 'failed' | 'released';
  options: SpawnSessionOptions;
  result?: SpawnSessionResult;
}>;

export type TwinSessionSchedulerAttemptStore = Readonly<{
  createIfAbsent: (attempt: TwinSessionSchedulerAttempt) => Promise<TwinSessionSchedulerAttempt>;
  load: (spawnNonce: string) => Promise<TwinSessionSchedulerAttempt | null>;
  listRecoverable: () => Promise<readonly TwinSessionSchedulerAttempt[]>;
  save: (attempt: TwinSessionSchedulerAttempt) => Promise<void>;
}>;

type TwinSessionSchedulerDeps = Readonly<{
  controllerMachineId: string;
  store: TwinSessionSchedulerAttemptStore;
  resolveWorker: (workerId: string) => Readonly<{ machineId: string }> | null;
  acquireLease: (input: Readonly<{ leaseId: string; workerId: string; ownerToken: string }>) => Promise<TwinSessionLeaseState>;
  readLease: (input: Readonly<{ leaseId: string; ownerToken: string }>) => Promise<TwinSessionLeaseState>;
  releaseLease: (input: Readonly<{ leaseId: string; ownerToken: string }>) => Promise<TwinSessionLeaseState>;
  spawnTarget: (input: Readonly<{
    machineId: string;
    options: SpawnSessionOptions;
    lease: SessionSchedulingLeaseV1;
  }>) => Promise<SpawnSessionResult>;
  resolveTargetSpawn: (input: Readonly<{ machineId: string; spawnNonce: string }>) => Promise<SpawnSessionNonceResolution>;
  createOwnerToken: () => string;
}>;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

function digestRequest(options: SpawnSessionOptions): string {
  return createHash('sha256').update(JSON.stringify(stableValue(options))).digest('hex');
}

export function deriveTwinSessionLeaseId(spawnNonce: string, workerId: string): string {
  const digest = createHash('sha256')
    .update('happier-twin-session-v1\0')
    .update(spawnNonce)
    .update('\0')
    .update(workerId)
    .digest('hex');
  return `happier-session-${digest.slice(0, 32)}`;
}

function pendingResult(spawnNonce: string): SpawnSessionResult {
  return {
    type: 'success',
    sessionIdStatus: 'pending',
    spawnNonce,
    runnerAcceptance: 'same_request_runner',
  };
}

function resolutionFromResult(result: SpawnSessionResult | undefined): SpawnSessionNonceResolution {
  if (!result) return { status: 'pending' };
  if (result.type === 'error') {
    return {
      status: 'error',
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      ...(result.errorDetail ? { errorDetail: result.errorDetail } : {}),
    };
  }
  if (result.type !== 'success') return { status: 'pending' };
  const sessionId = typeof result.sessionId === 'string' ? result.sessionId.trim() : '';
  return sessionId ? { status: 'success', sessionId } : { status: 'pending' };
}

function invalidRequest(message: string): SpawnSessionResult {
  return {
    type: 'error',
    errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
    errorMessage: message,
  };
}

export function createTwinSessionScheduler(deps: TwinSessionSchedulerDeps) {
  const release = async (attempt: TwinSessionSchedulerAttempt): Promise<TwinSessionSchedulerAttempt> => {
    if (attempt.phase === 'released') return attempt;
    await deps.releaseLease({ leaseId: attempt.leaseId, ownerToken: attempt.ownerToken });
    const released = { ...attempt, phase: 'released' as const };
    await deps.store.save(released);
    return released;
  };

  const settleTargetResolution = async (
    attempt: TwinSessionSchedulerAttempt,
    resolution: SpawnSessionNonceResolution,
  ): Promise<TwinSessionSchedulerAttempt | null> => {
    if (resolution.status === 'success') {
      const running = {
        ...attempt,
        phase: 'running' as const,
        result: {
          type: 'success' as const,
          sessionId: resolution.sessionId,
          spawnNonce: attempt.spawnNonce,
          runnerAcceptance: 'same_request_runner' as const,
        },
      };
      await deps.store.save(running);
      return running;
    }
    if (resolution.status === 'error') {
      const failed = {
        ...attempt,
        phase: 'failed' as const,
        result: {
          type: 'error' as const,
          errorCode: resolution.errorCode,
          errorMessage: resolution.errorMessage,
          ...(resolution.errorDetail ? { errorDetail: resolution.errorDetail } : {}),
        },
      };
      await deps.store.save(failed);
      return await release(failed);
    }
    return null;
  };

  const progress = async (
    initial: TwinSessionSchedulerAttempt,
    options: Readonly<{ acquire: boolean }>,
  ): Promise<TwinSessionSchedulerAttempt> => {
    let attempt = initial;
    if (attempt.phase === 'running' || attempt.phase === 'failed' || attempt.phase === 'released') return attempt;

    if (attempt.phase === 'created' || attempt.phase === 'queued') {
      const lease = options.acquire && attempt.phase === 'created'
        ? await deps.acquireLease({
            leaseId: attempt.leaseId,
            workerId: attempt.workerId,
            ownerToken: attempt.ownerToken,
          })
        : await deps.readLease({ leaseId: attempt.leaseId, ownerToken: attempt.ownerToken });
      attempt = {
        ...attempt,
        phase: lease.state === 'acquired'
          ? 'dispatching'
          : lease.state === 'queued'
            ? 'queued'
            : 'released',
      };
      await deps.store.save(attempt);
      if (attempt.phase !== 'dispatching') return attempt;
    }

    if (initial.phase === 'dispatching') {
      const resolution = await deps.resolveTargetSpawn({
        machineId: attempt.machineId,
        spawnNonce: attempt.spawnNonce,
      });
      const settled = await settleTargetResolution(attempt, resolution);
      if (settled) return settled;
      if (resolution.status !== 'not_found') return attempt;
    }

    try {
      const result = await deps.spawnTarget({
        machineId: attempt.machineId,
        options: attempt.options,
        lease: {
          v: 1,
          leaseId: attempt.leaseId,
          controllerMachineId: deps.controllerMachineId,
        },
      });
      if (result.type === 'error') {
        const failed = { ...attempt, phase: 'failed' as const, result };
        await deps.store.save(failed);
        return await release(failed);
      }
      const sessionId = result.type === 'success' && typeof result.sessionId === 'string'
        ? result.sessionId.trim()
        : '';
      const next = {
        ...attempt,
        phase: sessionId ? 'running' as const : 'dispatching' as const,
        result: result.type === 'success'
          ? { ...result, spawnNonce: attempt.spawnNonce }
          : result,
      };
      await deps.store.save(next);
      return next;
    } catch {
      const resolution = await deps.resolveTargetSpawn({
        machineId: attempt.machineId,
        spawnNonce: attempt.spawnNonce,
      });
      return (await settleTargetResolution(attempt, resolution)) ?? attempt;
    }
  };

  const releaseBySessionId = async (sessionIdRaw: string): Promise<void> => {
    const sessionId = sessionIdRaw.trim();
    if (!sessionId) return;
    for (const attempt of await deps.store.listRecoverable()) {
      if (resolutionFromResult(attempt.result).status !== 'success') continue;
      const result = resolutionFromResult(attempt.result);
      if (result.status !== 'success' || result.sessionId !== sessionId) continue;
      await release(attempt);
    }
  };

  return {
    spawn: async (options: SpawnSessionOptions): Promise<SpawnSessionResult> => {
      const spawnNonce = typeof options.spawnNonce === 'string' ? options.spawnNonce.trim() : '';
      const workerId = options.schedulingTarget?.workerId.trim() ?? '';
      if (!spawnNonce) return invalidRequest('Scheduled session spawn requires a spawnNonce');
      if (!workerId) return invalidRequest('Scheduled session spawn requires a worker target');
      const worker = deps.resolveWorker(workerId);
      if (!worker) {
        return {
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.SCHEDULING_TARGET_UNAVAILABLE,
          errorMessage: `Unknown scheduled session worker ${workerId}`,
        };
      }
      const requested: TwinSessionSchedulerAttempt = {
        v: 1,
        spawnNonce,
        requestDigest: digestRequest(options),
        workerId,
        machineId: worker.machineId,
        leaseId: deriveTwinSessionLeaseId(spawnNonce, workerId),
        ownerToken: deps.createOwnerToken(),
        phase: 'created',
        options: { ...options, spawnNonce },
      };
      const attempt = await deps.store.createIfAbsent(requested);
      if (attempt.requestDigest !== requested.requestDigest) {
        return invalidRequest('The spawnNonce is already bound to a different scheduled session request');
      }
      const progressed = await progress(attempt, { acquire: attempt.phase === 'created' });
      return progressed.result ?? pendingResult(spawnNonce);
    },
    recover: async (): Promise<void> => {
      for (const attempt of await deps.store.listRecoverable()) {
        if (attempt.phase === 'created' || attempt.phase === 'queued' || attempt.phase === 'dispatching') {
          await progress(attempt, { acquire: attempt.phase === 'created' });
        }
      }
    },
    resolve: async (spawnNonceRaw: string): Promise<SpawnSessionNonceResolution> => {
      const spawnNonce = spawnNonceRaw.trim();
      if (!spawnNonce) return { status: 'not_found' };
      const attempt = await deps.store.load(spawnNonce);
      if (!attempt) return { status: 'not_found' };
      const progressed = await progress(attempt, { acquire: false });
      return resolutionFromResult(progressed.result);
    },
    observeSessionExit: async (input: Readonly<{ sessionId: string; unexpected: boolean }>): Promise<void> => {
      if (!input.unexpected) await releaseBySessionId(input.sessionId);
    },
    observeRespawnSuccess: async (_input: Readonly<{ sessionId: string }>): Promise<void> => {},
    observeRespawnTerminal: async (input: Readonly<{ sessionId: string }>): Promise<void> => {
      await releaseBySessionId(input.sessionId);
    },
  };
}
