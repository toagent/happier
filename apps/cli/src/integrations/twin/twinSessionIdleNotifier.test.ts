import { describe, expect, it, vi } from 'vitest';

import { notifyScheduledSessionIdle } from './twinSessionIdleNotifier';

const lease = { v: 1 as const, attemptLookupId: 'spawn-1', leaseId: 'lease-1', controllerMachineId: 'controller' };

describe('notifyScheduledSessionIdle', () => {
  it.each(['assistant_message_end', 'turn_cancelled'] as const)(
    'tells the controller a scheduled task went idle after %s',
    async (event) => {
      const callIdle = vi.fn(async () => ({ status: 'released' }));

      await notifyScheduledSessionIdle({ event, sessionId: 'session-1', lease, callIdle, logWarning: vi.fn() });

      expect(callIdle).toHaveBeenCalledWith({
        controllerMachineId: 'controller',
        request: { attemptLookupId: 'spawn-1', leaseId: 'lease-1', sessionId: 'session-1' },
      });
    },
  );

  it('stays quiet while a turn is running or for sessions the scheduler does not own', async () => {
    const callIdle = vi.fn(async () => ({ status: 'released' }));

    await notifyScheduledSessionIdle({ event: 'prompt_or_steer', sessionId: 'session-1', lease, callIdle, logWarning: vi.fn() });
    await notifyScheduledSessionIdle({ event: 'task_started', sessionId: 'session-1', lease, callIdle, logWarning: vi.fn() });
    await notifyScheduledSessionIdle({ event: 'assistant_message_end', sessionId: 'session-1', lease: undefined, callIdle, logWarning: vi.fn() });

    expect(callIdle).not.toHaveBeenCalled();
  });

  it('reports a failed notification instead of throwing into the turn lifecycle', async () => {
    // The slot then stays held until the session exits: the pre-existing behaviour, made visible.
    const logWarning = vi.fn();

    await notifyScheduledSessionIdle({
      event: 'assistant_message_end',
      sessionId: 'session-1',
      lease,
      callIdle: async () => { throw new Error('controller unreachable'); },
      logWarning,
    });

    expect(logWarning).toHaveBeenCalledWith(expect.stringContaining('session-1'), expect.any(Error));
  });
});
