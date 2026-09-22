import { describe, expect, it, vi } from 'vitest';
import type { SpawnSessionNonceResolution } from '@happier-dev/protocol';

import type { SpawnSessionOptions, SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';

import {
  createTwinSessionScheduler,
  deriveTwinSessionLeaseId,
  type TwinSessionSchedulerAttempt,
  type TwinSessionSchedulerAttemptStore,
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

  async delete(spawnNonce: string): Promise<void> {
    this.attempts.delete(spawnNonce);
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

function createHarness(params: Readonly<{
  store?: MemoryAttemptStore;
  leaseState?: 'queued' | 'acquired';
  spawnTarget?: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
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

  return {
    store,
    acquireLease,
    readLease,
    releaseLease,
    spawnTarget,
    resolveTargetSpawn,
    forgetLease,
    scheduler: createTwinSessionScheduler({
      controllerMachineId: 'controller-machine',
      store,
      resolveWorker: (workerId) => workerId === 'twin-dev'
        ? { machineId: 'target-machine' }
        : null,
      acquireLease,
      readLease,
      releaseLease,
      forgetLease,
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

  it('deletes released custody only after the target durably acknowledges an authenticated receipt', async () => {
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
    expect(harness.store.attempts.has('spawn-1')).toBe(false);

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
    expect(harness.store.attempts.has('spawn-1')).toBe(false);
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
