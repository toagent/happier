import { createHash } from 'node:crypto';

import {
  SPAWN_SESSION_ERROR_CODES,
  type SessionSchedulingLeaseV1,
  type SpawnSessionNonceResolution,
} from '@happier-dev/protocol';

import type {
  SpawnSessionOptions,
  SpawnSessionResult,
  SpawnSessionRunnerAcceptanceHooks,
} from '@/rpc/handlers/registerSessionHandlers';

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
  terminalSessionId?: string;
  runnerAcceptanceRequired?: boolean;
  runnerAcceptanceRecorded?: boolean;
  leaseForgotten?: boolean;
}>;

export type TwinSessionSchedulerAttemptStore = Readonly<{
  createIfAbsent: (attempt: TwinSessionSchedulerAttempt) => Promise<TwinSessionSchedulerAttempt>;
  load: (spawnNonce: string) => Promise<TwinSessionSchedulerAttempt | null>;
  listRecoverable: () => Promise<readonly TwinSessionSchedulerAttempt[]>;
  update: (
    spawnNonce: string,
    transition: (current: TwinSessionSchedulerAttempt) => TwinSessionSchedulerAttempt,
  ) => Promise<TwinSessionSchedulerAttempt | null>;
  save: (attempt: TwinSessionSchedulerAttempt) => Promise<void>;
}>;

export type TwinSessionReleaseReceiptPayload = Readonly<{
  v: 1;
  purpose: 'twin_session_release_ack';
  attemptLookupId: string;
  leaseId: string;
  sessionId: string;
}>;

export type TwinSessionReleaseResult =
  | Readonly<{ status: 'released' | 'pending'; receipt: string }>
  | Readonly<{ status: 'acknowledged' | 'not_found' | 'mismatch' }>;

type TwinSessionSchedulerDeps = Readonly<{
  controllerMachineId: string;
  store: TwinSessionSchedulerAttemptStore;
  resolveWorker: (workerId: string) => Readonly<{ machineId: string }> | null;
  acquireLease: (input: Readonly<{ leaseId: string; workerId: string; ownerToken: string }>) => Promise<TwinSessionLeaseState>;
  readLease: (input: Readonly<{ leaseId: string; ownerToken: string }>) => Promise<TwinSessionLeaseState>;
  releaseLease: (input: Readonly<{ leaseId: string; ownerToken: string }>) => Promise<TwinSessionLeaseState>;
  forgetLease: (input: Readonly<{ leaseId: string; ownerToken: string }>) => Promise<void>;
  spawnTarget: (input: Readonly<{
    machineId: string;
    options: SpawnSessionOptions;
    lease: SessionSchedulingLeaseV1;
  }>) => Promise<SpawnSessionResult>;
  resolveTargetSpawn: (input: Readonly<{ machineId: string; spawnNonce: string }>) => Promise<SpawnSessionNonceResolution>;
  createOwnerToken: () => string;
  sealReleaseReceipt: (input: Readonly<{
    attempt: TwinSessionSchedulerAttempt;
    sessionId: string;
  }>) => string;
  openReleaseReceipt: (receipt: string) => TwinSessionReleaseReceiptPayload | null;
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
    return (await deps.store.update(attempt.spawnNonce, (current) => ({
      ...current,
      phase: 'released' as const,
    }))) ?? { ...attempt, phase: 'released' as const };
  };

  const releaseIfTerminal = async (
    attempt: TwinSessionSchedulerAttempt,
  ): Promise<TwinSessionSchedulerAttempt> => {
    const terminalSessionId = attempt.terminalSessionId?.trim() ?? '';
    const resolution = resolutionFromResult(attempt.result);
    if (!terminalSessionId || resolution.status !== 'success' || resolution.sessionId !== terminalSessionId) {
      return attempt;
    }
    return await release(attempt);
  };

  const settleTargetResolution = async (
    attempt: TwinSessionSchedulerAttempt,
    resolution: SpawnSessionNonceResolution,
  ): Promise<TwinSessionSchedulerAttempt | null> => {
    if (resolution.status === 'success') {
      const running = (await deps.store.update(attempt.spawnNonce, (current) => ({
        ...current,
        phase: current.phase === 'released' ? current.phase : 'running' as const,
        result: current.phase === 'released'
          ? current.result
          : {
              type: 'success' as const,
              sessionId: resolution.sessionId,
              spawnNonce: current.spawnNonce,
              runnerAcceptance: 'same_request_runner' as const,
            },
      }))) ?? attempt;
      return await releaseIfTerminal(running);
    }
    if (resolution.status === 'error') {
      const failed = (await deps.store.update(attempt.spawnNonce, (current) => ({
        ...current,
        phase: current.phase === 'released' ? current.phase : 'failed' as const,
        result: current.phase === 'released'
          ? current.result
          : {
              type: 'error' as const,
              errorCode: resolution.errorCode,
              errorMessage: resolution.errorMessage,
              ...(resolution.errorDetail ? { errorDetail: resolution.errorDetail } : {}),
            },
      }))) ?? attempt;
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
      attempt = (await deps.store.update(attempt.spawnNonce, (current) => {
        if (current.phase !== 'created' && current.phase !== 'queued') return current;
        return {
          ...current,
          phase: lease.state === 'acquired'
            ? 'dispatching'
            : lease.state === 'queued'
              ? 'queued'
              : 'released',
        };
      })) ?? attempt;
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
          attemptLookupId: attempt.spawnNonce,
          leaseId: attempt.leaseId,
          controllerMachineId: deps.controllerMachineId,
        },
      });
      if (result.type === 'error') {
        const failed = (await deps.store.update(attempt.spawnNonce, (current) => ({
          ...current,
          phase: current.phase === 'released' ? current.phase : 'failed' as const,
          result: current.phase === 'released' ? current.result : result,
        }))) ?? attempt;
        return await release(failed);
      }
      const sessionId = result.type === 'success' && typeof result.sessionId === 'string'
        ? result.sessionId.trim()
        : '';
      const next = (await deps.store.update(attempt.spawnNonce, (current) => ({
        ...current,
        phase: current.phase === 'released'
          ? current.phase
          : sessionId
            ? 'running' as const
            : 'dispatching' as const,
        result: current.phase === 'released'
          ? current.result
          : result.type === 'success'
            ? { ...result, spawnNonce: current.spawnNonce }
            : result,
      }))) ?? attempt;
      return await releaseIfTerminal(next);
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
    spawn: async (
      options: SpawnSessionOptions,
      acceptanceHooks?: SpawnSessionRunnerAcceptanceHooks,
    ): Promise<SpawnSessionResult> => {
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
        ...(acceptanceHooks ? { runnerAcceptanceRequired: true } : {}),
      };
      const attempt = await deps.store.createIfAbsent(requested);
      if (attempt.requestDigest !== requested.requestDigest) {
        return invalidRequest('The spawnNonce is already bound to a different scheduled session request');
      }
      if (Boolean(attempt.runnerAcceptanceRequired) !== Boolean(acceptanceHooks)) {
        return invalidRequest('The spawnNonce is already bound to a different runner acceptance contract');
      }
      let acceptedAttempt = attempt;
      if (acceptanceHooks) {
        await acceptanceHooks.onBeforeRunnerLaunchAccepted();
        acceptedAttempt = (await deps.store.update(attempt.spawnNonce, (current) => ({
          ...current,
          runnerAcceptanceRequired: true,
          runnerAcceptanceRecorded: true,
        }))) ?? attempt;
      }
      const progressed = await progress(acceptedAttempt, { acquire: acceptedAttempt.phase === 'created' });
      return progressed.result ?? pendingResult(spawnNonce);
    },
    recover: async (): Promise<void> => {
      for (const attempt of await deps.store.listRecoverable()) {
        if (attempt.runnerAcceptanceRequired && !attempt.runnerAcceptanceRecorded) continue;
        if (attempt.phase === 'failed') {
          await release(attempt);
          continue;
        }
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
    observeRemoteSessionExit: async (input: Readonly<{
      attemptLookupId: string;
      leaseId: string;
      sessionId: string;
      receipt?: string;
    }>): Promise<TwinSessionReleaseResult> => {
      const attemptLookupId = input.attemptLookupId.trim();
      const leaseId = input.leaseId.trim();
      const sessionId = input.sessionId.trim();
      if (!attemptLookupId || !leaseId || !sessionId) return { status: 'not_found' };

      if (input.receipt !== undefined) {
        const receipt = input.receipt.trim();
        const payload = receipt ? deps.openReleaseReceipt(receipt) : null;
        if (
          !payload
          || payload.v !== 1
          || payload.purpose !== 'twin_session_release_ack'
          || payload.attemptLookupId !== attemptLookupId
          || payload.leaseId !== leaseId
          || payload.sessionId !== sessionId
        ) {
          return { status: 'mismatch' };
        }
        const acknowledgedAttempt = await deps.store.load(attemptLookupId);
        if (!acknowledgedAttempt) return { status: 'acknowledged' };
        if (
          acknowledgedAttempt.leaseId !== leaseId
          || acknowledgedAttempt.spawnNonce !== attemptLookupId
          || acknowledgedAttempt.terminalSessionId !== sessionId
        ) {
          return { status: 'mismatch' };
        }
        if (acknowledgedAttempt.phase !== 'released') return { status: 'pending', receipt };
        if (acknowledgedAttempt.leaseForgotten) return { status: 'acknowledged' };
        await deps.forgetLease({
          leaseId: acknowledgedAttempt.leaseId,
          ownerToken: acknowledgedAttempt.ownerToken,
        });
        await deps.store.update(attemptLookupId, (current) => ({
          ...current,
          leaseForgotten: true,
        }));
        return { status: 'acknowledged' };
      }

      const attempt = await deps.store.load(attemptLookupId);
      if (!attempt) return { status: 'not_found' };
      if (attempt.leaseId !== leaseId || attempt.spawnNonce !== attemptLookupId) {
        return { status: 'mismatch' };
      }
      const receipt = deps.sealReleaseReceipt({ attempt, sessionId });
      const resolution = resolutionFromResult(attempt.result);
      if (resolution.status === 'success') {
        if (resolution.sessionId !== sessionId) return { status: 'mismatch' };
        const withTerminalIdentity = (await deps.store.update(attemptLookupId, (current) => ({
          ...current,
          terminalSessionId: sessionId,
        }))) ?? attempt;
        await release(withTerminalIdentity);
        return { status: 'released', receipt };
      }
      if (attempt.phase !== 'dispatching') return { status: 'mismatch' };
      const updated = await deps.store.update(attemptLookupId, (current) => {
        if (current.terminalSessionId && current.terminalSessionId !== sessionId) return current;
        return { ...current, terminalSessionId: sessionId };
      });
      if (!updated) return { status: 'not_found' };
      if (updated.terminalSessionId !== sessionId) return { status: 'mismatch' };
      return { status: 'pending', receipt };
    },
  };
}
