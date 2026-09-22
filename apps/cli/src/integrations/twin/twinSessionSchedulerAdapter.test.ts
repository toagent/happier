import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { callMachineRpc } from '@/session/transport/rpc/machineRpc';
import type { Credentials } from '@/persistence';

import {
  createTwinSessionAttemptStore,
  createTwinSessionLeaseClient,
  createTwinSessionSchedulerAdapter,
  resolveTwinSessionSchedulerConfig,
} from './twinSessionSchedulerAdapter';
import type { TwinSessionSchedulerAttempt } from './twinSessionScheduler';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await import('node:fs/promises').then(({ rm }) => rm(directory, { recursive: true, force: true }));
  }));
});

function attempt(overrides: Partial<TwinSessionSchedulerAttempt> = {}): TwinSessionSchedulerAttempt {
  const options: SpawnSessionOptions = {
    directory: '/workspace/project',
    environmentVariables: { PRIVATE_TOKEN: 'must-not-be-plaintext' },
    spawnNonce: 'spawn-1',
    schedulingTarget: { v: 1, workerId: 'twin-dev' },
  };
  return {
    v: 1,
    spawnNonce: 'spawn-1',
    requestDigest: 'digest-1',
    workerId: 'twin-dev',
    machineId: 'machine-dev',
    leaseId: 'lease-1',
    ownerToken: 'private-owner-token',
    phase: 'created',
    options,
    ...overrides,
  };
}

describe('twin session scheduler adapter', () => {
  it('fails closed unless an explicit absolute executable and worker map are configured', () => {
    expect(resolveTwinSessionSchedulerConfig({})).toBeNull();
    expect(() => resolveTwinSessionSchedulerConfig({
      HAPPIER_TWIN_SESSION_SCHEDULER_CONFIG_JSON: JSON.stringify({
        v: 1,
        executable: 'twin-agent-remote',
        pollIntervalMs: 1000,
        workers: { 'twin-dev': { machineId: 'machine-dev' } },
      }),
    })).toThrow(/absolute executable/i);

    expect(resolveTwinSessionSchedulerConfig({
      HAPPIER_TWIN_SESSION_SCHEDULER_CONFIG_JSON: JSON.stringify({
        v: 1,
        executable: '/opt/wetamp/bin/twin-agent-remote',
        pollIntervalMs: 750,
        workers: {
          local: { machineId: 'machine-local' },
          'twin-dev': { machineId: 'machine-dev' },
          mini: { machineId: 'machine-mini' },
        },
      }),
    })).toEqual({
      v: 1,
      executable: '/opt/wetamp/bin/twin-agent-remote',
      pollIntervalMs: 750,
      workers: {
        local: { machineId: 'machine-local' },
        'twin-dev': { machineId: 'machine-dev' },
        mini: { machineId: 'machine-mini' },
      },
    });
  });

  it('invokes lease commands without a shell and parses queue state', async () => {
    const runCommand = vi.fn(async () => ({
      stdout: 'lease_id=lease-1\nstate=queued\nworker_id=twin-dev\nqueue_position=2\n',
    }));
    const client = createTwinSessionLeaseClient({
      executable: '/opt/wetamp/bin/twin-agent-remote',
      runCommand,
    });

    await expect(client.acquire({
      leaseId: 'lease-1',
      workerId: 'twin-dev',
      ownerToken: 'private-owner-token',
    })).resolves.toEqual({ state: 'queued', queuePosition: 2 });
    expect(runCommand).toHaveBeenCalledWith({
      executable: '/opt/wetamp/bin/twin-agent-remote',
      args: ['lease-acquire', 'lease-1', 'twin-dev', 'private-owner-token'],
    });
  });

  it('never includes the owner token in command failures', async () => {
    const client = createTwinSessionLeaseClient({
      executable: '/opt/wetamp/bin/twin-agent-remote',
      runCommand: async ({ args }) => {
        throw new Error(`command failed: ${args.join(' ')}`);
      },
    });

    const error = await client.release({
      leaseId: 'lease-1',
      ownerToken: 'private-owner-token',
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('lease-release');
    expect(String(error)).not.toContain('private-owner-token');
  });

  it('stores attempts encrypted with mode 0600 and preserves create-if-absent identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-twin-attempts-'));
    temporaryDirectories.push(directory);
    const store = createTwinSessionAttemptStore({
      directory,
      encryptionMaterial: { type: 'dataKey', machineKey: new Uint8Array(32).fill(4) },
      randomBytes: (length) => new Uint8Array(length).fill(7),
    });

    const created = await store.createIfAbsent(attempt());
    const repeated = await store.createIfAbsent(attempt({ ownerToken: 'replacement-token' }));
    expect(repeated.ownerToken).toBe(created.ownerToken);
    await expect(store.load('spawn-1')).resolves.toEqual(created);
    await expect(store.listRecoverable()).resolves.toEqual([created]);

    await store.save(attempt({ phase: 'released', leaseForgotten: true }));
    await expect(store.load('spawn-1')).resolves.toMatchObject({ phase: 'released', leaseForgotten: true });
    await expect(store.listRecoverable()).resolves.toEqual([]);

    const files = await import('node:fs/promises').then(({ readdir }) => readdir(directory));
    expect(files).toHaveLength(1);
    const path = join(directory, files[0]!);
    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain('private-owner-token');
    expect(raw).not.toContain('must-not-be-plaintext');
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it('resolves a target spawn through the dedicated non-recursive target RPC', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-twin-adapter-'));
    temporaryDirectories.push(directory);
    const methods: string[] = [];
    const rpcRequests: unknown[] = [];
    const callMachineRpcFn: typeof callMachineRpc = async (input) => {
      methods.push(input.method);
      rpcRequests.push(input.request);
      if (input.method === 'daemon.scheduledSession.spawnTarget.v1') {
        return {
          type: 'success',
          sessionIdStatus: 'pending',
          spawnNonce: 'spawn-1',
        };
      }
      if (input.method === 'daemon.scheduledSession.resolveTarget.v1') {
        return { status: 'success', sessionId: 'session-target' };
      }
      throw new Error(`Unexpected RPC ${input.method}`);
    };
    const credentials: Credentials = {
      token: 'test-token',
      encryption: {
        type: 'dataKey',
        publicKey: new Uint8Array(32).fill(3),
        machineKey: new Uint8Array(32).fill(4),
      },
    };
    const adapter = createTwinSessionSchedulerAdapter({
      config: {
        v: 1,
        executable: '/opt/wetamp/bin/twin-agent-remote',
        pollIntervalMs: 1_000,
        workers: { 'twin-dev': { machineId: 'machine-dev' } },
      },
      attemptDirectory: directory,
      encryptionMaterial: credentials.encryption,
      credentials,
      controllerMachineId: 'machine-controller',
      runCommand: async ({ args }) => ({
        stdout: args[0] === 'lease-forget'
          ? 'state=forgotten\n'
          : `state=${args[0] === 'lease-release' ? 'released' : 'acquired'}\n`,
      }),
      callMachineRpcFn,
      logWarning: () => {},
    });

    await expect(adapter.spawn(attempt().options)).resolves.toMatchObject({
      type: 'success',
      sessionIdStatus: 'pending',
    });
    await expect(adapter.resolve('spawn-1')).resolves.toEqual({
      status: 'success',
      sessionId: 'session-target',
    });

    expect(methods).toEqual([
      'daemon.scheduledSession.spawnTarget.v1',
      'daemon.scheduledSession.resolveTarget.v1',
    ]);
    expect(rpcRequests[0]).toMatchObject({
      lease: {
        v: 1,
        attemptLookupId: 'spawn-1',
        leaseId: expect.any(String),
        controllerMachineId: 'machine-controller',
      },
    });

    const released = await adapter.observeRemoteSessionExit({
      attemptLookupId: 'spawn-1',
      leaseId: (rpcRequests[0] as any).lease.leaseId,
      sessionId: 'session-target',
    });
    expect(released).toMatchObject({ status: 'released', receipt: expect.any(String) });
    await expect(adapter.observeRemoteSessionExit({
      attemptLookupId: 'spawn-1',
      leaseId: (rpcRequests[0] as any).lease.leaseId,
      sessionId: 'session-target',
      receipt: (released as any).receipt,
    })).resolves.toEqual({ status: 'acknowledged' });
    await expect(adapter.resolve('spawn-1')).resolves.toEqual({ status: 'success', sessionId: 'session-target' });
  });
});
