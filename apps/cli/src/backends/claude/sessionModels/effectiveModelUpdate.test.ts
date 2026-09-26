import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';

import { applyClaudeEffectiveModelUpdate } from './effectiveModelUpdate';

function createClient(initialCurrentModelId: string) {
  let metadata = {
    sessionModelsV1: {
      v: 1,
      provider: 'claude',
      updatedAt: 1,
      currentModelId: initialCurrentModelId,
      availableModels: [{ id: initialCurrentModelId, name: initialCurrentModelId }],
    },
  } as unknown as Metadata;
  const events: Array<{ message: string; id?: string }> = [];
  return {
    events,
    currentModelId: () => metadata.sessionModelsV1?.currentModelId,
    client: {
      sendSessionEvent: (event: { type: 'message'; message: string }, id?: string) => {
        events.push({ message: event.message, ...(id ? { id } : {}) });
      },
      updateMetadata: (updater: (current: Metadata) => Metadata) => {
        metadata = updater(metadata);
      },
      getMetadataSnapshot: () => metadata,
    },
  };
}

describe('applyClaudeEffectiveModelUpdate', () => {
  it('does not report a change when the SDK spells one model with and without its context suffix', () => {
    // Session start: the init record names the selector ("[1m]" = 1M context window) and every
    // assistant row names the API model. Both are the same effective model the session started on.
    const harness = createClient('default');

    applyClaudeEffectiveModelUpdate({ client: harness.client, modelId: 'claude-opus-5-5[1m]', source: 'sdk', logPrefix: 'test' });
    applyClaudeEffectiveModelUpdate({ client: harness.client, modelId: 'claude-opus-5-5', source: 'sdk', logPrefix: 'test' });
    applyClaudeEffectiveModelUpdate({ client: harness.client, modelId: 'claude-opus-5-5', source: 'sdk', logPrefix: 'test' });

    expect(harness.events).toEqual([]);
    // The more specific spelling is kept, so the 1M context window is not lost.
    expect(harness.currentModelId()).toBe('claude-opus-5-5[1m]');
  });

  it('still reports a real switch of the effective model while the runtime is running', () => {
    const harness = createClient('default');

    applyClaudeEffectiveModelUpdate({ client: harness.client, modelId: 'claude-opus-5-5[1m]', source: 'sdk', logPrefix: 'test' });
    applyClaudeEffectiveModelUpdate({ client: harness.client, modelId: 'claude-sonnet-5', source: 'sdk', logPrefix: 'test' });

    expect(harness.events.map((event) => event.message)).toEqual(['Model changed to claude-sonnet-5']);
    expect(harness.currentModelId()).toBe('claude-sonnet-5');
  });
});
