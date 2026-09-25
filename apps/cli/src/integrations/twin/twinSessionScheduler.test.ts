import { describe, expect, it, vi } from 'vitest';
import type { SpawnSessionNonceResolution } from '@happier-dev/protocol';

import type { SpawnSessionOptions, SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';

import {
  createTwinSessionScheduler,
  deriveTwinSessionLeaseId,
  type TwinSessionSchedulerAttempt,
  type TwinSessionSchedulerAttemptStore,
  type TwinSessionWorkspaceMaterialization,
} from './twinSessionScheduler';

class MemoryAttemptStore implements TwinSessionSchedulerAttemptStore {
  readonly attempts = new Map<string, TwinSessionSchedulerAttempt>();

  async createIfAbsent(attempt: TwinSessionSchedulerAttempt): Promise<TwinSessionSchedulerAttempt> {
    const current = this.attempts.get(attempt.spawnNonce);
    if (current) return structuredClone(current);
    this.attempts.set(attempt.spawnNonce, structuredClone(attempt));
    return structuredClone(attempt);
  }

  async load(spawnNonce: string): Promise<TwinSessionSchedulerAttempt | null> {
    const attempt = this.attempts.get(spawnNonce);
    return attempt ? structuredClone(attempt) : null;
  }

  async listRecoverable(): Promise<readonly TwinSessionSchedulerAttempt[]> {
    return Array.from(this.attempts.values())
      .filter((attempt) => attempt.phase !== 'released')
      .map((attempt) => structuredClone(attempt));
  }

  async update(
    spawnNonce: string,
    transition: (current: TwinSessionSchedulerAttempt) => TwinSessionSchedulerAttempt,
  ): Promise<TwinSessionSchedulerAttempt | null> {
    const current = this.attempts.get(spawnNonce);
    if (!current) return null;
    const next = transition(structuredClone(current));
    this.attempts.set(spawnNonce, structuredClone(next));
    return structuredClone(next);
  }

  async save(attempt: TwinSessionSchedulerAttempt): Promise<void> {
    this.attempts.set(attempt.spawnNonce, structuredClone(attempt));
  }

}

function scheduledOptions(overrides: Partial<SpawnSessionOptions> = {}): SpawnSessionOptions {
  return {
    directory: '/workspace/project',
    spawnNonce: 'spawn-1',
    schedulingTarget: { v: 1, workerId: 'twin-dev' },
    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    ...overrides,
  };
}

const WORKER_MACHINES: Record<string, string> = {
  'twin-dev': 'target-machine',
  'twin-control': 'controller-machine',
  'mac-mini': 'mini-machine',
};

function occupyWorker(store: MemoryAttemptStore, workerId: string, spawnNonce: string, phase: TwinSessionSchedulerAttempt['phase'] = 'running'): void {
  store.attempts.set(spawnNonce, {
    v: 1,
    spawnNonce,
    requestDigest: `digest-${spawnNonce}`,
    workerId,
    machineId: WORKER_MACHINES[workerId]!,
    leaseId: `lease-${spawnNonce}`,
    ownerToken: 'owner-token',
    phase,
    options: scheduledOptions({ spawnNonce, schedulingTarget: { v: 1, workerId } }),
  });
}

function createHarness(params: Readonly<{
  store?: MemoryAttemptStore;
  leaseState?: 'queued' | 'acquired';
  spawnTarget?: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  prepareWorkspace?: (attempt: TwinSessionSchedulerAttempt) => Promise<Readonly<{
    options: SpawnSessionOptions;
    workspace: TwinSessionWorkspaceMaterialization;
  }>>;
  finalizeWorkspace?: (attempt: TwinSessionSchedulerAttempt, sessionId: string) => Promise<TwinSessionWorkspaceMaterialization>;
}> = {}) {
  const store = params.store ?? new MemoryAttemptStore();
  const acquireLease = vi.fn(async () => ({ state: params.leaseState ?? 'acquired' as const }));
  const readLease = vi.fn(async () => ({ state: params.leaseState ?? 'acquired' as const }));
  const releaseLease = vi.fn(async () => ({ state: 'released' as const }));
  const forgetLease = vi.fn(async () => undefined);
  const spawnTarget = vi.fn(params.spawnTarget ?? (async () => ({
    type: 'success' as const,
    sessionId: 'session-1',
  })));
  const resolveTargetSpawn = vi.fn(async (): Promise<SpawnSessionNonceResolution> => ({ status: 'pending' }));
  const prepareWorkspace = vi.fn(params.prepareWorkspace ?? (async (attempt: TwinSessionSchedulerAttempt) => ({
    options: {
      ...attempt.options,
      directory: `/target/${attempt.spawnNonce}`,
    },
    workspace: {
      v: 1 as const,
      state: 'prepared' as const,
      sourceDirectory: attempt.options.directory,
      sourceRootDirectory: attempt.options.directory,
      sourceRelativeDirectory: '.',
      reviewDirectory: `/review/${attempt.spawnNonce}`,
      reviewRootDirectory: `/review/${attempt.spawnNonce}`,
      targetDirectory: `/target/${attempt.spawnNonce}`,
      targetRootDirectory: `/target/${attempt.spawnNonce}`,
      sourceHead: 'source-head',
      sourceSnapshot: 'source-snapshot',
      baselineCommit: 'baseline-commit',
    },
  })));
  const finalizeWorkspace = vi.fn(params.finalizeWorkspace ?? (async (attempt: TwinSessionSchedulerAttempt) => ({
    ...attempt.workspace!,
    state: 'finalized' as const,
  })));

  return {
    store,
    acquireLease,
    readLease,
    releaseLease,
    spawnTarget,
    resolveTargetSpawn,
    forgetLease,
    prepareWorkspace,
    finalizeWorkspace,
    scheduler: createTwinSessionScheduler({
      controllerMachineId: 'controller-machine',
      store,
      resolveWorker: (workerId) => WORKER_MACHINES[workerId] ? { machineId: WORKER_MACHINES[workerId]! } : null,
      autoWorkerOrder: () => ['twin-control', 'twin-dev', 'mac-mini'],
      acquireLease,
      readLease,
      releaseLease,
      forgetLease,
      prepareWorkspace: async ({ attempt }) => await prepareWorkspace(attempt),
      finalizeWorkspace: async ({ attempt, sessionId }) => await finalizeWorkspace(attempt, sessionId),
      spawnTarget: async ({ options }) => await spawnTarget(options),
      resolveTargetSpawn,
      createOwnerToken: () => 'owner-token',
      sealReleaseReceipt: ({ attempt, sessionId }) => `receipt:${attempt.spawnNonce}:${attempt.leaseId}:${sessionId}`,
      openReleaseReceipt: (receipt: string) => {
        const match = /^receipt:([^:]+):([^:]+):([^:]+)$/u.exec(receipt);
        return match
          ? { v: 1 as const, purpose: 'twin_session_release_ack' as const, attemptLookupId: match[1]!, leaseId: match[2]!, sessionId: match[3]! }
          : null;
      },
    }),
  };
}

describe('twin session scheduler', () => {
  describe('automatic worker selection', () => {
    const autoOptions = (spawnNonce: string) => scheduledOptions({ spawnNonce, schedulingTarget: { v: 1, auto: true } });

    it('runs on the controller while it has no scheduled task, dispatching a concrete worker target', async () => {
      const harness = createHarness();

      await harness.scheduler.spawn(autoOptions('auto-1'));

      expect(harness.store.attempts.get('auto-1')).toMatchObject({ workerId: 'twin-control', machineId: 'controller-machine' });
      expect(harness.acquireLease).toHaveBeenCalledWith(expect.objectContaining({ workerId: 'twin-control' }));
      // Workers and the persisted session metadata only ever see the worker actually chosen.
      expect(harness.spawnTarget).toHaveBeenCalledWith(expect.objectContaining({
        schedulingTarget: { v: 1, workerId: 'twin-control' },
      }));
    });

    it('overflows to the next idle worker while the controller is busy', async () => {
      const store = new MemoryAttemptStore();
      occupyWorker(store, 'twin-control', 'busy-control');
      const harness = createHarness({ store });

      await harness.scheduler.spawn(autoOptions('auto-2'));
      expect(harness.store.attempts.get('auto-2')?.workerId).toBe('twin-dev');

      await harness.scheduler.spawn(autoOptions('auto-3'));
      expect(harness.store.attempts.get('auto-3')?.workerId).toBe('mac-mini');
    });

    it('queues on the least busy worker, preferring the controller, once every worker is busy', async () => {
      const store = new MemoryAttemptStore();
      occupyWorker(store, 'twin-control', 'c1');
      occupyWorker(store, 'twin-dev', 'd1');
      occupyWorker(store, 'twin-dev', 'd2', 'queued');
      occupyWorker(store, 'mac-mini', 'm1', 'dispatching');
      const harness = createHarness({ store });

      await harness.scheduler.spawn(autoOptions('auto-4'));

      expect(harness.store.attempts.get('auto-4')?.workerId).toBe('twin-control');
    });

    it('does not count released or failed attempts as load', async () => {
      const store = new MemoryAttemptStore();
      occupyWorker(store, 'twin-control', 'old-released', 'released');
      occupyWorker(store, 'twin-control', 'old-failed', 'failed');
      const harness = createHarness({ store });

      await harness.scheduler.spawn(autoOptions('auto-5'));

      expect(harness.store.attempts.get('auto-5')?.workerId).toBe('twin-control');
    });

    it('keeps the first choice when the same spawn nonce is retried after load changed', async () => {
      const harness = createHarness();
      await harness.scheduler.spawn(autoOptions('auto-6'));
      occupyWorker(harness.store, 'twin-control', 'later-busy');

      const retried = await harness.scheduler.spawn(autoOptions('auto-6'));

      expect(retried).toMatchObject({ type: 'success', sessionId: 'session-1' });
      expect(harness.store.attempts.get('auto-6')?.workerId).toBe('twin-control');
      expect(harness.spawnTarget).toHaveBeenCalledTimes(1);
    });
  });

  it('prepares one isolated workspace before spawning and reuses it for the same attempt', async () => {
    const harness = createHarness();

    await harness.scheduler.spawn(scheduledOptions());
    await harness.scheduler.spawn(scheduledOptions());

    expect(harness.prepareWorkspace).toHaveBeenCalledTimes(1);
    expect(harness.spawnTarget).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/target/spawn-1',
    }));
    expect(harness.prepareWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
      harness.spawnTarget.mock.invocationCallOrder[0]!,
    );
    expect(harness.store.attempts.get('spawn-1')).toMatchObject({
      workspace: {
        state: 'prepared',
        reviewDirectory: '/review/spawn-1',
        targetDirectory: '/target/spawn-1',
      },
      dispatchOptions: { directory: '/target/spawn-1' },
    });
  });

  it('creates one durable lease and one target runner for repeated use of the same spawn nonce', async () => {
    const harness = createHarness();

    const first = await harness.scheduler.spawn(scheduledOptions());
    const repeated = await harness.scheduler.spawn(scheduledOptions());

    expect(first).toMatchObject({ type: 'success', sessionId: 'session-1' });
    expect(repeated).toMatchObject({ type: 'success', sessionId: 'session-1' });
    expect(harness.acquireLease).toHaveBeenCalledTimes(1);
    expect(harness.spawnTarget).toHaveBeenCalledTimes(1);
    expect(harness.store.attempts.size).toBe(1);
  });

  it('returns pending while queued and resumes the same lease after daemon restart', async () => {
    const store = new MemoryAttemptStore();
    const queued = createHarness({ store, leaseState: 'queued' });

    await expect(queued.scheduler.spawn(scheduledOptions())).resolves.toMatchObject({
      type: 'success',
      sessionIdStatus: 'pending',
      spawnNonce: 'spawn-1',
    });
    expect(queued.spawnTarget).not.toHaveBeenCalled();

    const restarted = createHarness({ store, leaseState: 'acquired' });
    await restarted.scheduler.recover();

    expect(restarted.acquireLease).not.toHaveBeenCalled();
    expect(restarted.readLease).toHaveBeenCalledTimes(1);
    expect(restarted.spawnTarget).toHaveBeenCalledTimes(1);
    await expect(restarted.scheduler.resolve('spawn-1')).resolves.toEqual({
      status: 'success',
      sessionId: 'session-1',
    });
  });

  it('does not recover a handoff attempt until runner acceptance is durably recorded', async () => {
    const store = new MemoryAttemptStore();
    const interrupted = createHarness({ store });
    const interruptedAcceptance = vi.fn(async () => {
      throw new Error('daemon stopped after attempt creation');
    });

    await expect(interrupted.scheduler.spawn(scheduledOptions(), {
      onBeforeRunnerLaunchAccepted: interruptedAcceptance,
    })).rejects.toThrow('daemon stopped after attempt creation');
    expect(store.attempts.get('spawn-1')).toMatchObject({
      runnerAcceptanceRequired: true,
    });
    expect(store.attempts.get('spawn-1')).not.toHaveProperty('runnerAcceptanceRecorded');

    const restarted = createHarness({ store });
    await restarted.scheduler.recover();
    expect(restarted.acquireLease).not.toHaveBeenCalled();
    expect(restarted.readLease).not.toHaveBeenCalled();
    expect(restarted.spawnTarget).not.toHaveBeenCalled();

    const recoveredAcceptance = vi.fn(async () => {});
    await expect(restarted.scheduler.spawn(scheduledOptions(), {
      onBeforeRunnerLaunchAccepted: recoveredAcceptance,
    })).resolves.toMatchObject({ type: 'success', sessionId: 'session-1' });
    expect(recoveredAcceptance).toHaveBeenCalledTimes(1);
    expect(store.attempts.get('spawn-1')).toMatchObject({
      runnerAcceptanceRequired: true,
      runnerAcceptanceRecorded: true,
      phase: 'running',
    });
  });

  it('resolves an unknown target RPC outcome by nonce instead of launching a duplicate runner', async () => {
    const harness = createHarness({
      spawnTarget: async () => {
        throw new Error('response lost');
      },
    });
    harness.resolveTargetSpawn.mockResolvedValue({ status: 'success', sessionId: 'session-recovered' });

    await expect(harness.scheduler.spawn(scheduledOptions())).resolves.toMatchObject({
      type: 'success',
      sessionId: 'session-recovered',
    });
    expect(harness.spawnTarget).toHaveBeenCalledTimes(1);
    expect(harness.resolveTargetSpawn).toHaveBeenCalledTimes(1);
  });

  describe('idle slot release', () => {
    const lease = () => ({ attemptLookupId: 'spawn-1', leaseId: deriveTwinSessionLeaseId('spawn-1', 'twin-dev'), sessionId: 'session-1' });

    it('returns the queue slot when the task goes idle but keeps the session running', async () => {
      // A finished task whose session stays open for follow-ups is not work; holding its slot let
      // three idle sessions block every new task behind the shared FIFO.
      const harness = createHarness();
      await harness.scheduler.spawn(scheduledOptions());

      await expect(harness.scheduler.observeSessionIdle(lease())).resolves.toEqual({ status: 'released' });
      await expect(harness.scheduler.observeSessionIdle(lease())).resolves.toEqual({ status: 'released' });

      expect(harness.releaseLease).toHaveBeenCalledTimes(1);
      expect(harness.finalizeWorkspace).not.toHaveBeenCalled();
      expect(harness.store.attempts.get('spawn-1')).toMatchObject({ phase: 'running', slotReleased: true });
    });

    it('does not count an idle session as load when choosing a worker', async () => {
      const harness = createHarness({
        spawnTarget: async () => ({ type: 'success' as const, sessionId: 'session-control' }),
      });
      await harness.scheduler.spawn(scheduledOptions({ spawnNonce: 'first', schedulingTarget: { v: 1, auto: true } }));
      await harness.scheduler.observeSessionIdle({
        attemptLookupId: 'first',
        leaseId: deriveTwinSessionLeaseId('first', 'twin-control'),
        sessionId: 'session-control',
      });

      await harness.scheduler.spawn(scheduledOptions({ spawnNonce: 'second', schedulingTarget: { v: 1, auto: true } }));

      expect(harness.store.attempts.get('second')?.workerId).toBe('twin-control');
    });

    it('still materializes the review on exit without releasing the slot twice', async () => {
      const harness = createHarness();
      await harness.scheduler.spawn(scheduledOptions());
      await harness.scheduler.observeSessionIdle(lease());

      await harness.scheduler.observeSessionExit({ sessionId: 'session-1', unexpected: false });

      expect(harness.finalizeWorkspace).toHaveBeenCalledTimes(1);
      expect(harness.releaseLease).toHaveBeenCalledTimes(1);
      expect(harness.store.attempts.get('spawn-1')?.phase).toBe('released');
    });

    it('settles a still-pending session identity before matching an idle report', async () => {
      // The target accepts the spawn before the session id exists; a quick task can finish (and
      // report idle) before anyone has resolved that id, which left the slot held.
      const harness = createHarness({
        spawnTarget: async () => ({ type: 'success' as const, sessionIdStatus: 'pending' as const, spawnNonce: 'spawn-1' }),
      });
      harness.resolveTargetSpawn.mockResolvedValue({ status: 'success', sessionId: 'session-1' });
      await harness.scheduler.spawn(scheduledOptions());

      await expect(harness.scheduler.observeSessionIdle(lease())).resolves.toEqual({ status: 'released' });

      expect(harness.releaseLease).toHaveBeenCalledTimes(1);
      expect(harness.store.attempts.get('spawn-1')).toMatchObject({ phase: 'running', slotReleased: true });
    });

    it('ignores an idle report that does not match the attempt', async () => {
      const harness = createHarness();
      await harness.scheduler.spawn(scheduledOptions());

      await expect(harness.scheduler.observeSessionIdle({ ...lease(), sessionId: 'someone-else' }))
        .resolves.toEqual({ status: 'not_found' });
      await expect(harness.scheduler.observeSessionIdle({ ...lease(), leaseId: 'forged' }))
        .resolves.toEqual({ status: 'not_found' });
      expect(harness.releaseLease).not.toHaveBeenCalled();
    });
  });

  it('reports why workspace preparation failed instead of a bare failure', async () => {
    // The user only sees this message; the generic text alone left the cause unrecoverable.
    const harness = createHarness({
      prepareWorkspace: async () => {
        throw new Error('git commit failed (exit 1): blocked-by-user-hook');
      },
    });

    const result = await harness.scheduler.spawn(scheduledOptions());

    expect(result).toMatchObject({ type: 'error' });
    expect(result.type === 'error' ? result.errorMessage : '').toContain('blocked-by-user-hook');
    expect(harness.releaseLease).toHaveBeenCalledTimes(1);
  });

  it('releases the lease after a target spawn failure', async () => {
    const harness = createHarness({
      spawnTarget: async () => ({
        type: 'error',
        errorCode: 'SPAWN_FAILED',
        errorMessage: 'target failed',
      }),
    });

    await expect(harness.scheduler.spawn(scheduledOptions())).resolves.toMatchObject({
      type: 'error',
      errorCode: 'SPAWN_FAILED',
    });
    expect(harness.releaseLease).toHaveBeenCalledTimes(1);
  });

  it('releases a persisted failed attempt after daemon restart', async () => {
    const store = new MemoryAttemptStore();
    const interrupted = createHarness({
      store,
      spawnTarget: async () => ({
        type: 'error',
        errorCode: 'SPAWN_FAILED',
        errorMessage: 'target failed',
      }),
    });
    interrupted.releaseLease.mockRejectedValueOnce(new Error('daemon stopped before release'));

    await expect(interrupted.scheduler.spawn(scheduledOptions())).resolves.toMatchObject({
      type: 'success',
      sessionIdStatus: 'pending',
    });
    expect(store.attempts.get('spawn-1')).toMatchObject({ phase: 'failed' });

    const restarted = createHarness({ store });
    await restarted.scheduler.recover();

    expect(restarted.releaseLease).toHaveBeenCalledTimes(1);
    expect(store.attempts.get('spawn-1')).toMatchObject({ phase: 'released' });
  });

  it('releases only for a normal exit or terminal respawn outcome', async () => {
    const harness = createHarness();
    await harness.scheduler.spawn(scheduledOptions());

    await harness.scheduler.observeSessionExit({ sessionId: 'session-1', unexpected: true });
    await harness.scheduler.observeRespawnSuccess({ sessionId: 'session-1' });
    expect(harness.releaseLease).not.toHaveBeenCalled();

    await harness.scheduler.observeRespawnTerminal({ sessionId: 'session-1' });
    expect(harness.releaseLease).toHaveBeenCalledTimes(1);

    const second = createHarness();
    await second.scheduler.spawn(scheduledOptions({ spawnNonce: 'spawn-2' }));
    await second.scheduler.observeSessionExit({ sessionId: 'session-1', unexpected: false });
    expect(second.releaseLease).toHaveBeenCalledTimes(1);
  });

  it('finalizes the review workspace before releasing the lease', async () => {
    const harness = createHarness();
    await harness.scheduler.spawn(scheduledOptions());

    await harness.scheduler.observeSessionExit({ sessionId: 'session-1', unexpected: false });

    expect(harness.finalizeWorkspace).toHaveBeenCalledTimes(1);
    expect(harness.finalizeWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
      harness.releaseLease.mock.invocationCallOrder[0]!,
    );
    expect(harness.store.attempts.get('spawn-1')).toMatchObject({
      phase: 'released',
      workspace: { state: 'finalized' },
    });
  });

  it('retains lease custody when review workspace finalization fails and retries it', async () => {
    const harness = createHarness();
    harness.finalizeWorkspace.mockRejectedValueOnce(new Error('review patch failed'));
    await harness.scheduler.spawn(scheduledOptions());

    await expect(harness.scheduler.observeRemoteSessionExit({
      attemptLookupId: 'spawn-1',
      leaseId: deriveTwinSessionLeaseId('spawn-1', 'twin-dev'),
      sessionId: 'session-1',
    })).rejects.toThrow('review patch failed');
    expect(harness.releaseLease).not.toHaveBeenCalled();
    expect(harness.store.attempts.get('spawn-1')).toMatchObject({
      phase: 'running',
      terminalSessionId: 'session-1',
      workspace: { state: 'prepared' },
    });

    await expect(harness.scheduler.observeRemoteSessionExit({
      attemptLookupId: 'spawn-1',
      leaseId: deriveTwinSessionLeaseId('spawn-1', 'twin-dev'),
      sessionId: 'session-1',
    })).resolves.toMatchObject({ status: 'released' });
    expect(harness.finalizeWorkspace).toHaveBeenCalledTimes(2);
    expect(harness.releaseLease).toHaveBeenCalledTimes(1);
  });

  it('persists an early target exit and releases after the target session identity settles', async () => {
    const harness = createHarness({
      spawnTarget: async () => ({
        type: 'success',
        sessionIdStatus: 'pending',
        spawnNonce: 'spawn-1',
      }),
    });

    await harness.scheduler.spawn(scheduledOptions());
    await expect(harness.scheduler.observeRemoteSessionExit({
      attemptLookupId: 'spawn-1',
      leaseId: deriveTwinSessionLeaseId('spawn-1', 'twin-dev'),
      sessionId: 'session-late',
    })).resolves.toMatchObject({ status: 'pending', receipt: expect.any(String) });
    expect(harness.releaseLease).not.toHaveBeenCalled();

    harness.resolveTargetSpawn.mockResolvedValue({ status: 'success', sessionId: 'session-late' });

    await expect(harness.scheduler.resolve('spawn-1')).resolves.toEqual({
      status: 'success',
      sessionId: 'session-late',
    });
    expect(harness.releaseLease).toHaveBeenCalledTimes(1);
    expect(harness.store.attempts.get('spawn-1')).toMatchObject({
      phase: 'released',
      terminalSessionId: 'session-late',
    });
  });

  it('does not lose an early target exit while the target spawn RPC is settling', async () => {
    let settleTargetSpawn!: (result: SpawnSessionResult) => void;
    const targetSpawn = new Promise<SpawnSessionResult>((resolve) => {
      settleTargetSpawn = resolve;
    });
    const harness = createHarness({
      spawnTarget: async () => await targetSpawn,
    });

    const spawn = harness.scheduler.spawn(scheduledOptions());
    await vi.waitFor(() => {
      expect(harness.store.attempts.get('spawn-1')).toMatchObject({ phase: 'dispatching' });
    });

    await expect(harness.scheduler.observeRemoteSessionExit({
      attemptLookupId: 'spawn-1',
      leaseId: deriveTwinSessionLeaseId('spawn-1', 'twin-dev'),
      sessionId: 'session-raced',
    })).resolves.toMatchObject({ status: 'pending', receipt: expect.any(String) });

    settleTargetSpawn({ type: 'success', sessionId: 'session-raced' });
    await expect(spawn).resolves.toMatchObject({
      type: 'success',
      sessionId: 'session-raced',
    });

    expect(harness.releaseLease).toHaveBeenCalledTimes(1);
    expect(harness.store.attempts.get('spawn-1')).toMatchObject({
      phase: 'released',
      terminalSessionId: 'session-raced',
    });
  });

  it('forgets released custody but retains the spawn result after an authenticated target acknowledgement', async () => {
    const harness = createHarness();
    await harness.scheduler.spawn(scheduledOptions());

    const notification = {
      attemptLookupId: 'spawn-1',
      leaseId: deriveTwinSessionLeaseId('spawn-1', 'twin-dev'),
      sessionId: 'session-1',
    };
    const recorded = await harness.scheduler.observeRemoteSessionExit(notification as any);
    expect(recorded).toMatchObject({ status: 'released', receipt: expect.any(String) });
    expect(harness.store.attempts.get('spawn-1')).toMatchObject({ phase: 'released' });

    await expect(harness.scheduler.observeRemoteSessionExit({
      ...notification,
      receipt: (recorded as any).receipt,
    } as any)).resolves.toEqual({ status: 'acknowledged' });

    expect(harness.releaseLease).toHaveBeenCalledTimes(1);
    expect(harness.forgetLease).toHaveBeenCalledTimes(1);
    expect(harness.store.attempts.get('spawn-1')).toMatchObject({
      phase: 'released',
      terminalSessionId: 'session-1',
      leaseForgotten: true,
    });

    await expect(harness.scheduler.spawn(scheduledOptions())).resolves.toMatchObject({
      type: 'success',
      sessionId: 'session-1',
    });
    expect(harness.acquireLease).toHaveBeenCalledTimes(1);
    expect(harness.spawnTarget).toHaveBeenCalledTimes(1);

    await expect(harness.scheduler.observeRemoteSessionExit({
      ...notification,
      receipt: (recorded as any).receipt,
    } as any)).resolves.toEqual({ status: 'acknowledged' });
    expect(harness.forgetLease).toHaveBeenCalledTimes(1);
  });

  it('does not delete an early-exit attempt until spawn identity settles and lease release completes', async () => {
    const harness = createHarness({
      spawnTarget: async () => ({
        type: 'success',
        sessionIdStatus: 'pending',
        spawnNonce: 'spawn-1',
      }),
    });
    await harness.scheduler.spawn(scheduledOptions());

    const notification = {
      attemptLookupId: 'spawn-1',
      leaseId: deriveTwinSessionLeaseId('spawn-1', 'twin-dev'),
      sessionId: 'session-late',
    };
    const recorded = await harness.scheduler.observeRemoteSessionExit(notification as any);
    expect(recorded).toMatchObject({ status: 'pending', receipt: expect.any(String) });
    await expect(harness.scheduler.observeRemoteSessionExit({
      ...notification,
      receipt: (recorded as any).receipt,
    } as any)).resolves.toMatchObject({ status: 'pending', receipt: (recorded as any).receipt });
    expect(harness.store.attempts.has('spawn-1')).toBe(true);
    expect(harness.forgetLease).not.toHaveBeenCalled();

    harness.resolveTargetSpawn.mockResolvedValue({ status: 'success', sessionId: 'session-late' });
    await harness.scheduler.resolve('spawn-1');
    await expect(harness.scheduler.observeRemoteSessionExit({
      ...notification,
      receipt: (recorded as any).receipt,
    } as any)).resolves.toEqual({ status: 'acknowledged' });
    expect(harness.store.attempts.get('spawn-1')).toMatchObject({
      phase: 'released',
      terminalSessionId: 'session-late',
      leaseForgotten: true,
    });
  });

  it('rejects a forged or cross-session release receipt without deleting custody', async () => {
    const harness = createHarness();
    await harness.scheduler.spawn(scheduledOptions());

    await expect(harness.scheduler.observeRemoteSessionExit({
      attemptLookupId: 'spawn-1',
      leaseId: deriveTwinSessionLeaseId('spawn-1', 'twin-dev'),
      sessionId: 'session-1',
      receipt: 'receipt:spawn-1:wrong-lease:session-1',
    } as any)).resolves.toEqual({ status: 'mismatch' });
    expect(harness.store.attempts.has('spawn-1')).toBe(true);
    expect(harness.forgetLease).not.toHaveBeenCalled();
  });
});
