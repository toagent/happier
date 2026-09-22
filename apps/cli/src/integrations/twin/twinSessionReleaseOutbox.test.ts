import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createTwinSessionReleaseOutbox,
  resolveTwinSessionReleaseOutboxConfig,
} from './twinSessionReleaseOutbox';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await import('node:fs/promises').then(({ rm }) => rm(directory, { recursive: true, force: true }));
  }));
});

describe('twin session release outbox', () => {
  it('requires an explicit positive poll interval for target-only daemons', () => {
    expect(resolveTwinSessionReleaseOutboxConfig({})).toBeNull();
    expect(() => resolveTwinSessionReleaseOutboxConfig({
      HAPPIER_TWIN_SESSION_RELEASE_OUTBOX_CONFIG_JSON: JSON.stringify({ v: 1, pollIntervalMs: 0 }),
    })).toThrow();
    expect(resolveTwinSessionReleaseOutboxConfig({
      HAPPIER_TWIN_SESSION_RELEASE_OUTBOX_CONFIG_JSON: JSON.stringify({ v: 1, pollIntervalMs: 1_500 }),
    })).toEqual({ v: 1, pollIntervalMs: 1_500 });
  });

  it('persists a failed delivery and removes it only after a restart confirms receipt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-twin-release-outbox-'));
    temporaryDirectories.push(directory);
    const warning = vi.fn();
    const first = createTwinSessionReleaseOutbox({
      directory,
      pollIntervalMs: 1_000,
      deliver: async () => {
        throw new Error('controller offline');
      },
      logWarning: warning,
    });

    await first.enqueue({
      lease: { v: 1, attemptLookupId: 'attempt-1', leaseId: 'lease-1', controllerMachineId: 'machine-controller' },
      sessionId: 'session-1',
    });

    const persisted = (await readdir(directory)).filter((name) => name.endsWith('.json'));
    expect(persisted).toHaveLength(1);
    if (process.platform !== 'win32') {
      expect((await stat(join(directory, persisted[0]!))).mode & 0o777).toBe(0o600);
    }
    expect(warning).toHaveBeenCalledTimes(1);

    const deliver = vi.fn(async (notification: any) => notification.receipt
      ? { status: 'acknowledged' as const }
      : { status: 'released' as const, receipt: 'receipt-1' });
    const restarted = createTwinSessionReleaseOutbox({
      directory,
      pollIntervalMs: 1_000,
      deliver,
      logWarning: warning,
    });
    await restarted.start();
    restarted.stop();

    expect(deliver).toHaveBeenNthCalledWith(1, {
      lease: { v: 1, attemptLookupId: 'attempt-1', leaseId: 'lease-1', controllerMachineId: 'machine-controller' },
      sessionId: 'session-1',
    });
    expect(deliver).toHaveBeenNthCalledWith(2, {
      lease: { v: 1, attemptLookupId: 'attempt-1', leaseId: 'lease-1', controllerMachineId: 'machine-controller' },
      sessionId: 'session-1',
      receipt: 'receipt-1',
    });
    expect((await readdir(directory)).filter((name) => name.endsWith('.json'))).toEqual([]);
  });

  it('retains an early-exit notification until the controller can acknowledge cleanup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-twin-release-pending-'));
    temporaryDirectories.push(directory);
    const outbox = createTwinSessionReleaseOutbox({
      directory,
      pollIntervalMs: 1_000,
      deliver: async (notification: any) => notification.receipt
        ? { status: 'pending' as const, receipt: notification.receipt }
        : { status: 'pending' as const, receipt: 'receipt-early' },
      logWarning: () => {},
    });

    await outbox.enqueue({
      lease: { v: 1, attemptLookupId: 'attempt-early', leaseId: 'lease-early', controllerMachineId: 'machine-controller' },
      sessionId: 'session-early',
    });

    const entries = (await readdir(directory)).filter((name) => name.endsWith('.json'));
    expect(entries).toHaveLength(1);
    await expect(readFile(join(directory, entries[0]!), 'utf8')).resolves.toContain('receipt-early');
  });

  it('survives a crash after persisting the controller receipt and resumes with an ACK', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-twin-release-receipt-'));
    temporaryDirectories.push(directory);
    let calls = 0;
    const first = createTwinSessionReleaseOutbox({
      directory,
      pollIntervalMs: 1_000,
      deliver: async (notification: any) => {
        calls++;
        if (!notification.receipt) return { status: 'released' as const, receipt: 'receipt-crash' };
        throw new Error('target crashed before ACK response');
      },
      logWarning: () => {},
    });
    await first.enqueue({
      lease: { v: 1, attemptLookupId: 'attempt-crash', leaseId: 'lease-crash', controllerMachineId: 'machine-controller' },
      sessionId: 'session-crash',
    });
    expect(calls).toBe(2);
    const entries = (await readdir(directory)).filter((name) => name.endsWith('.json'));
    expect(entries).toHaveLength(1);
    await expect(readFile(join(directory, entries[0]!), 'utf8')).resolves.toContain('receipt-crash');

    const deliver = vi.fn(async () => ({ status: 'acknowledged' as const }));
    const restarted = createTwinSessionReleaseOutbox({
      directory,
      pollIntervalMs: 1_000,
      deliver,
      logWarning: () => {},
    });
    await restarted.drain();
    expect(deliver).toHaveBeenCalledWith({
      lease: { v: 1, attemptLookupId: 'attempt-crash', leaseId: 'lease-crash', controllerMachineId: 'machine-controller' },
      sessionId: 'session-crash',
      receipt: 'receipt-crash',
    });
    expect((await readdir(directory)).filter((name) => name.endsWith('.json'))).toEqual([]);
  });
});
