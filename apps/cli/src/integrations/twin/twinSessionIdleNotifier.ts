import type { SessionSchedulingLeaseV1 } from '@happier-dev/protocol';

import type { ConnectedServiceTurnLifecycleEvent } from '@/daemon/connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';

/** Events after which the runner has no turn in flight (a failed turn also ends with assistant_message_end). */
const TURN_END_EVENTS: ReadonlySet<ConnectedServiceTurnLifecycleEvent> = new Set(['assistant_message_end', 'turn_cancelled']);

/**
 * Worker side of the idle slot release: when a scheduled session finishes a turn, tell the
 * controller so it can return the shared queue slot while the session stays open for follow-ups.
 * Best effort by design — if the controller cannot be reached the slot is simply held until the
 * session exits, which is the behaviour before this existed; the failure is logged, not thrown into
 * the turn lifecycle.
 */
export async function notifyScheduledSessionIdle(input: Readonly<{
  event: ConnectedServiceTurnLifecycleEvent;
  sessionId: string;
  lease: SessionSchedulingLeaseV1 | null | undefined;
  callIdle: (call: Readonly<{
    controllerMachineId: string;
    request: Readonly<{ attemptLookupId: string; leaseId: string; sessionId: string }>;
  }>) => Promise<unknown>;
  logWarning: (message: string, error: unknown) => void;
}>): Promise<void> {
  const sessionId = input.sessionId.trim();
  if (!input.lease || !sessionId || !TURN_END_EVENTS.has(input.event)) return;
  try {
    await input.callIdle({
      controllerMachineId: input.lease.controllerMachineId,
      request: { attemptLookupId: input.lease.attemptLookupId, leaseId: input.lease.leaseId, sessionId },
    });
  } catch (error) {
    input.logWarning(`Failed to return the scheduler slot for idle session ${sessionId}`, error);
  }
}
