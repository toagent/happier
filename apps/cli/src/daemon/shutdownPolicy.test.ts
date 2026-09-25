import { describe, expect, it } from 'vitest';

import { getDaemonShutdownExitCode, getDaemonShutdownWatchdogTimeoutMs } from './shutdownPolicy';

describe('daemon shutdown policy', () => {
  it('exits 0 for non-exception shutdown sources', () => {
    expect(getDaemonShutdownExitCode('happier-app')).toBe(0);
    expect(getDaemonShutdownExitCode('happier-cli')).toBe(0);
    expect(getDaemonShutdownExitCode('os-signal')).toBe(0);
  });

  it('exits 1 for exception shutdown source', () => {
    expect(getDaemonShutdownExitCode('exception')).toBe(1);
  });

  it('uses a non-trivial watchdog timeout', () => {
    expect(getDaemonShutdownWatchdogTimeoutMs()).toBeGreaterThanOrEqual(5_000);
  });

  it('uses a stable watchdog timeout contract', () => {
    expect(getDaemonShutdownWatchdogTimeoutMs()).toBe(15_000);
  });

  it('keeps watchdog timeout finite and positive', () => {
    const timeoutMs = getDaemonShutdownWatchdogTimeoutMs();
    expect(Number.isFinite(timeoutMs)).toBe(true);
    expect(timeoutMs).toBeGreaterThan(0);
  });
});

describe('waitForShutdownWork', () => {
  it('holds shutdown until a signalled runner restart has respawned, so the session is not stranded', async () => {
    let pendingRestarts = 1;
    let polls = 0;
    const { waitForShutdownWork } = await import('./shutdownPolicy');

    const remaining = await waitForShutdownWork({
      inFlightSpawns: () => 0,
      pendingRunnerRestarts: () => pendingRestarts,
      graceMs: 10_000,
      pollMs: 1,
      sleep: async () => {
        polls += 1;
        if (polls === 3) pendingRestarts = 0;
      },
    });

    expect(polls).toBe(3);
    expect(remaining).toEqual({ inFlightSpawns: 0, pendingRunnerRestarts: 0 });
  });

  it('stops waiting at the grace budget and reports what is left', async () => {
    let now = 0;
    const { waitForShutdownWork } = await import('./shutdownPolicy');

    const remaining = await waitForShutdownWork({
      inFlightSpawns: () => 1,
      pendingRunnerRestarts: () => 2,
      graceMs: 50,
      pollMs: 10,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    });

    expect(now).toBe(50);
    expect(remaining).toEqual({ inFlightSpawns: 1, pendingRunnerRestarts: 2 });
  });
});
