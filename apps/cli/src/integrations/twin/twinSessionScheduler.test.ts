import { describe, expect, it, vi } from 'vitest';
import type { SpawnSessionNonceResolution } from '@happier-dev/protocol';

import type { SpawnSessionOptions, SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';

import {
  createTwinSessionScheduler,
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
    return Array.from(this.attempts.values(), (attempt) => structuredClone(attempt));
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

function createHarness(params: Readonly<{
  store?: MemoryAttemptStore;
  leaseState?: 'queued' | 'acquired';
  spawnTarget?: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
}> = {}) {
  const store = params.store ?? new MemoryAttemptStore();
  const acquireLease = vi.fn(async () => ({ state: params.leaseState ?? 'acquired' as const }));
  const readLease = vi.fn(async () => ({ state: params.leaseState ?? 'acquired' as const }));
  const releaseLease = vi.fn(async () => ({ state: 'released' as const }));
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
    scheduler: createTwinSessionScheduler({
      controllerMachineId: 'controller-machine',
      store,
      resolveWorker: (workerId) => workerId === 'twin-dev'
        ? { machineId: 'target-machine' }
        : null,
      acquireLease,
      readLease,
      releaseLease,
      spawnTarget: async ({ options }) => await spawnTarget(options),
      resolveTargetSpawn,
      createOwnerToken: () => 'owner-token',
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
});
