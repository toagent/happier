export type DaemonShutdownSource = 'happier-app' | 'happier-cli' | 'os-signal' | 'exception';

export function getDaemonShutdownExitCode(source: DaemonShutdownSource): 0 | 1 {
  return source === 'exception' ? 1 : 0;
}

// A watchdog is useful to avoid hanging forever on shutdown if some cleanup path stalls.
// This should be long enough to not fire during normal shutdown, so the daemon does not
// incorrectly exit with a failure code (which can trigger restart loops + extra log files).
export function getDaemonShutdownWatchdogTimeoutMs(): number {
  return 15_000;
}

export type ShutdownWorkRemaining = Readonly<{ inFlightSpawns: number; pendingRunnerRestarts: number }>;

/**
 * Work a shutdown waits for, within one grace budget: spawns still awaiting their session webhook,
 * and planned runner restarts that were signalled but have not respawned yet. Exiting in between
 * strands the session, since the next daemon only finds a dead runner and ends it.
 */
export async function waitForShutdownWork(input: Readonly<{
  inFlightSpawns: () => number;
  pendingRunnerRestarts: () => number;
  graceMs: number;
  pollMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}>): Promise<ShutdownWorkRemaining> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? (async (ms: number) => await new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const read = (): ShutdownWorkRemaining => ({
    inFlightSpawns: input.inFlightSpawns(),
    pendingRunnerRestarts: input.pendingRunnerRestarts(),
  });
  const start = now();
  let remaining = read();
  while ((remaining.inFlightSpawns > 0 || remaining.pendingRunnerRestarts > 0) && now() - start < input.graceMs) {
    // eslint-disable-next-line no-await-in-loop
    await sleep(input.pollMs);
    remaining = read();
  }
  return remaining;
}
