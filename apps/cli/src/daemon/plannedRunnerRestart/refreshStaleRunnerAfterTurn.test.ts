import { describe, expect, it, vi } from 'vitest';

import { refreshStaleRunnerAfterTurn } from './refreshStaleRunnerAfterTurn';

describe('refreshStaleRunnerAfterTurn', () => {
  it('moves a stale runner to the current CLI once its turn ends, never mid-turn', async () => {
    const restartIfStale = vi.fn(async (sessionId: string) => ({ ok: true, status: 'restarted' as const, sessionId }));
    const logWarning = vi.fn();

    await refreshStaleRunnerAfterTurn({ event: 'task_started', sessionId: 'session-1', restartIfStale, logWarning });
    await refreshStaleRunnerAfterTurn({ event: 'prompt_or_steer', sessionId: 'session-1', restartIfStale, logWarning });
    expect(restartIfStale).not.toHaveBeenCalled();

    await refreshStaleRunnerAfterTurn({ event: 'assistant_message_end', sessionId: 'session-1', restartIfStale, logWarning });
    await refreshStaleRunnerAfterTurn({ event: 'turn_cancelled', sessionId: 'session-2', restartIfStale, logWarning });
    expect(restartIfStale.mock.calls).toEqual([['session-1'], ['session-2']]);
    expect(logWarning).not.toHaveBeenCalled();
  });

  it('reports a failed switch (the banner stays as the fallback) without throwing into the turn lifecycle', async () => {
    const logWarning = vi.fn();

    await refreshStaleRunnerAfterTurn({
      event: 'assistant_message_end',
      sessionId: 'session-1',
      restartIfStale: async (sessionId) => ({ ok: false, status: 'spawn_failed' as const, sessionId }),
      logWarning,
    });
    await expect(refreshStaleRunnerAfterTurn({
      event: 'assistant_message_end',
      sessionId: 'session-1',
      restartIfStale: async () => { throw new Error('daemon shutting down'); },
      logWarning,
    })).resolves.toBeUndefined();

    expect(logWarning).toHaveBeenCalledTimes(2);
  });
});
