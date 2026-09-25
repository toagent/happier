import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { callMachineRpc } from '@/session/transport/rpc/machineRpc';
import type { Credentials } from '@/persistence';

import {
  createTwinSessionAttemptStore,
  createTwinSessionLeaseClient,
  createTwinSessionSchedulerAdapter,
  buildTwinSessionSchedulingCapability,
  resolveTwinSessionSchedulerConfig,
} from './twinSessionSchedulerAdapter';
import type { TwinSessionSchedulerAttempt } from './twinSessionScheduler';
import type { TwinSessionWorkspaceMetadataUpdate } from './twinSessionWorkspaceMaterializer';

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return result.stdout.trim();
}

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

    const resolved = resolveTwinSessionSchedulerConfig({
      HAPPIER_TWIN_SESSION_SCHEDULER_CONFIG_JSON: JSON.stringify({
        v: 1,
        executable: '/opt/wetamp/bin/twin-agent-remote',
        pollIntervalMs: 750,
        reviewRoot: '/tmp/happier-reviews',
        workers: {
          local: {
            machineId: 'machine-local',
            workspace: { kind: 'local', root: '/tmp/happier-local-workspaces' },
          },
          'twin-dev': {
            machineId: 'machine-dev',
            workspace: {
              kind: 'ssh',
              host: 'twin-dev',
              root: '/Users/dev/.happier/workspaces',
              diffExecutable: '/Users/dev/.lan-dev-machine/bin/twin-agent-workspace-diff',
            },
          },
          mini: {
            machineId: 'machine-mini',
            workspace: {
              kind: 'ssh',
              host: 'twin-mini',
              root: '/Users/mini/.happier/workspaces',
              diffExecutable: '/Users/mini/.lan-dev-machine/bin/twin-agent-workspace-diff',
            },
          },
        },
      }),
    });
    expect(resolved).toEqual({
      v: 1,
      executable: '/opt/wetamp/bin/twin-agent-remote',
      pollIntervalMs: 750,
      reviewRoot: '/tmp/happier-reviews',
      defaultWorkerId: 'local',
      workers: {
        local: {
          machineId: 'machine-local',
          workspace: { kind: 'local', root: '/tmp/happier-local-workspaces' },
        },
        'twin-dev': {
          machineId: 'machine-dev',
          workspace: {
            kind: 'ssh',
            host: 'twin-dev',
            root: '/Users/dev/.happier/workspaces',
            diffExecutable: '/Users/dev/.lan-dev-machine/bin/twin-agent-workspace-diff',
          },
        },
        mini: {
          machineId: 'machine-mini',
          workspace: {
            kind: 'ssh',
            host: 'twin-mini',
            root: '/Users/mini/.happier/workspaces',
            diffExecutable: '/Users/mini/.lan-dev-machine/bin/twin-agent-workspace-diff',
          },
        },
      },
    });
    expect(buildTwinSessionSchedulingCapability(resolved!)).toEqual({
      v: 1,
      defaultWorkerId: 'local',
      workers: [
        { workerId: 'local', machineId: 'machine-local' },
        { workerId: 'twin-dev', machineId: 'machine-dev' },
        { workerId: 'mini', machineId: 'machine-mini' },
      ],
    });

    expect(() => resolveTwinSessionSchedulerConfig({
      HAPPIER_TWIN_SESSION_SCHEDULER_CONFIG_JSON: JSON.stringify({
        v: 1,
        executable: '/opt/wetamp/bin/twin-agent-remote',
        pollIntervalMs: 750,
        reviewRoot: '/tmp/happier-reviews',
        defaultWorkerId: 'missing',
        workers: {
          local: {
            machineId: 'machine-local',
            workspace: { kind: 'local', root: '/tmp/happier-local-workspaces' },
          },
        },
      }),
    })).toThrow(/default scheduling worker/i);
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

    // An idle task keeps running with its slot returned; that state must survive a daemon restart.
    await store.save(attempt({ phase: 'running', slotReleased: true }));
    await expect(store.load('spawn-1')).resolves.toMatchObject({ phase: 'running', slotReleased: true });

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
    const sourceRoot = join(directory, 'source');
    await mkdir(sourceRoot, { recursive: true });
    await runGit(sourceRoot, ['init', '--initial-branch=main']);
    await runGit(sourceRoot, ['config', 'user.name', 'Test User']);
    await runGit(sourceRoot, ['config', 'user.email', 'test@example.com']);
    await writeFile(join(sourceRoot, 'tracked.txt'), 'base\n', 'utf8');
    await runGit(sourceRoot, ['add', '--all']);
    await runGit(sourceRoot, ['commit', '-m', 'base']);
    const methods: string[] = [];
    const rpcRequests: unknown[] = [];
    const updateSessionMetadata = vi.fn(async (_input: TwinSessionWorkspaceMetadataUpdate) => {});
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
        reviewRoot: join(directory, 'reviews'),
        defaultWorkerId: 'twin-dev',
        workers: {
          'twin-dev': {
            machineId: 'machine-dev',
            workspace: { kind: 'local', root: join(directory, 'targets') },
          },
        },
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
      updateSessionMetadata,
      logWarning: () => {},
    });

    await expect(adapter.spawn({ ...attempt().options, directory: sourceRoot })).resolves.toMatchObject({
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
      options: {
        directory: expect.stringContaining(`${join(directory, 'targets')}/session-`),
      },
      lease: {
        v: 1,
        attemptLookupId: 'spawn-1',
        leaseId: expect.any(String),
        controllerMachineId: 'machine-controller',
      },
    });
    const targetDirectory = (rpcRequests[0] as { options: { directory: string } }).options.directory;
    await writeFile(join(targetDirectory, 'tracked.txt'), 'agent change\n', 'utf8');

    const released = await adapter.observeRemoteSessionExit({
      attemptLookupId: 'spawn-1',
      leaseId: (rpcRequests[0] as any).lease.leaseId,
      sessionId: 'session-target',
    });
    expect(released).toMatchObject({ status: 'released', receipt: expect.any(String) });
    expect(updateSessionMetadata).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-target',
      machineId: 'machine-controller',
      path: expect.stringContaining(`${join(directory, 'reviews')}/session-`),
      scheduledWorkspace: expect.objectContaining({
        workerId: 'twin-dev',
        executionMachineId: 'machine-dev',
        reviewMachineId: 'machine-controller',
        reviewState: 'ready',
      }),
    }));
    const reviewDirectory = (updateSessionMetadata.mock.calls[0]?.[0] as { path: string }).path;
    await expect(readFile(join(reviewDirectory, 'tracked.txt'), 'utf8')).resolves.toBe('agent change\n');
    await expect(adapter.observeRemoteSessionExit({
      attemptLookupId: 'spawn-1',
      leaseId: (rpcRequests[0] as any).lease.leaseId,
      sessionId: 'session-target',
      receipt: (released as any).receipt,
    })).resolves.toEqual({ status: 'acknowledged' });
    await expect(adapter.resolve('spawn-1')).resolves.toEqual({ status: 'success', sessionId: 'session-target' });
  });
});
