import {
  isTurnEndLifecycleEvent,
  type ConnectedServiceTurnLifecycleEvent,
} from '@/daemon/connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';

import type { RestartSessionRunnerResult } from './types';

const FAILED_STATUSES: ReadonlySet<RestartSessionRunnerResult['status']> = new Set([
  'stop_failed',
  'spawn_failed',
  'partial_failure',
]);

/**
 * After a daemon update, runners started by the previous CLI keep running it. The daemon moves each
 * one to the current CLI at its first turn boundary so the user never has to act on it; the restart
 * owner still re-checks every activity gate and does nothing for a runner that is already current.
 * A runner that cannot be moved stays stale, which is what keeps the stale-runner banner as the
 * fallback, and the failure is logged here.
 */
type RefreshStaleRunnerInput = Readonly<{
  sessionId: string;
  restartIfStale: (sessionId: string) => Promise<RestartSessionRunnerResult>;
  logWarning: (message: string, detail: unknown) => void;
}>;

export async function refreshStaleRunner(input: RefreshStaleRunnerInput): Promise<void> {
  const sessionId = input.sessionId.trim();
  if (!sessionId) return;
  try {
    const result = await input.restartIfStale(sessionId);
    if (FAILED_STATUSES.has(result.status)) {
      input.logWarning(`Failed to move stale session runner ${sessionId} to the current CLI (${result.status})`, result);
    }
  } catch (error) {
    input.logWarning(`Failed to move stale session runner ${sessionId} to the current CLI`, error);
  }
}

export async function refreshStaleRunnerAfterTurn(
  input: RefreshStaleRunnerInput & Readonly<{ event: ConnectedServiceTurnLifecycleEvent }>,
): Promise<void> {
  if (!isTurnEndLifecycleEvent(input.event)) return;
  await refreshStaleRunner(input);
}
