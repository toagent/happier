import type { Metadata } from '@/api/types';
import { updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';

import { buildClaudeSessionModelsMetadataWithCurrentModelId } from '../remote/buildClaudeSessionModelsMetadataFromSupportedModels';

export type ClaudeEffectiveModelUpdateSource = 'statusline' | 'transcript' | 'sdk';

type ClaudeEffectiveModelUpdateClient = Readonly<{
  sendSessionEvent(event: { type: 'message'; message: string }, id?: string): void;
  updateMetadata(updater: (metadata: Metadata) => Metadata): void | Promise<void>;
  getMetadataSnapshot?: () => Metadata | null;
}>;

type EffectiveModelState = {
  lastSeenModelId: string | null;
  lastMetadataRequestKey: string | null;
  lastEmittedTransitionKey: string | null;
};

const stateByClient = new WeakMap<object, EffectiveModelState>();

function stateFor(client: object): EffectiveModelState {
  const existing = stateByClient.get(client);
  if (existing) return existing;
  const created: EffectiveModelState = {
    lastSeenModelId: null,
    lastMetadataRequestKey: null,
    lastEmittedTransitionKey: null,
  };
  stateByClient.set(client, created);
  return created;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readPositiveTokens(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
}

type SessionModelsState = NonNullable<Metadata['sessionModelsV1']>;
type SessionModelEntry = NonNullable<SessionModelsState['availableModels']>[number];

function readClaudeSessionModelsState(metadata: Metadata | null | undefined): SessionModelsState | null {
  const primary = metadata?.sessionModelsV1;
  if (primary?.provider === 'claude') return primary;
  const legacy = metadata?.acpSessionModelsV1;
  if (legacy?.provider === 'claude') return legacy;
  return null;
}

function readActiveClaudeModelId(metadata: Metadata | null | undefined): string | null {
  return readString(readClaudeSessionModelsState(metadata)?.currentModelId);
}

function findSessionModelEntry(
  metadata: Metadata | null | undefined,
  modelId: string,
): SessionModelEntry | null {
  const state = readClaudeSessionModelsState(metadata);
  const entries = Array.isArray(state?.availableModels) ? state.availableModels : [];
  return entries.find((entry) => entry.id === modelId) ?? null;
}

function hasRequestedModelDetails(params: Readonly<{
  metadata: Metadata | null | undefined;
  modelId: string;
  displayName: string | null;
  contextWindowTokens: number | null;
}>): boolean {
  if (params.displayName === null && params.contextWindowTokens === null) return true;
  const entry = findSessionModelEntry(params.metadata, params.modelId);
  if (!entry) return false;
  if (params.displayName !== null && entry.name !== params.displayName) return false;
  if (params.contextWindowTokens !== null && entry.contextWindowTokens !== params.contextWindowTokens) return false;
  return true;
}

function readMetadataSnapshot(client: ClaudeEffectiveModelUpdateClient): Metadata | null {
  try {
    return client.getMetadataSnapshot?.() ?? null;
  } catch {
    return null;
  }
}

function buildMetadataRequestKey(params: Readonly<{
  modelId: string;
  displayName: string | null;
  contextWindowTokens: number | null;
}>): string {
  return `${params.modelId}|${params.displayName ?? ''}|${params.contextWindowTokens ?? ''}`;
}

function buildModelChangedEventId(params: Readonly<{
  fromModelId: string;
  toModelId: string;
}>): string {
  return `claude:model-changed:${encodeURIComponent(params.fromModelId)}:${encodeURIComponent(params.toModelId)}`;
}

/**
 * Claude Code names one model two ways: the selector in the SDK init record carries a context
 * window suffix ("claude-opus-5-5[1m]") while assistant rows carry the API model id
 * ("claude-opus-5-5"). Both describe the same effective model.
 */
function stripContextSuffix(modelId: string): string {
  return modelId.replace(/\[[^\]]*\]$/u, '');
}

function isSameClaudeModel(left: string | null, right: string): boolean {
  return left !== null && stripContextSuffix(left) === stripContextSuffix(right);
}

function resolveModelLabel(params: Readonly<{
  metadata: Metadata | null | undefined;
  modelId: string;
  displayName: string | null;
}>): string {
  return params.displayName ?? readString(findSessionModelEntry(params.metadata, params.modelId)?.name) ?? params.modelId;
}

export function applyClaudeEffectiveModelUpdate(params: Readonly<{
  client: ClaudeEffectiveModelUpdateClient;
  modelId: string;
  displayName?: string | null;
  contextWindowTokens?: number | null;
  source: ClaudeEffectiveModelUpdateSource;
  logPrefix: string;
}>): void {
  const reportedModelId = readString(params.modelId);
  if (!reportedModelId) return;

  const displayName = readString(params.displayName);
  const contextWindowTokens = readPositiveTokens(params.contextWindowTokens);
  const metadataSnapshot = readMetadataSnapshot(params.client);
  const state = stateFor(params.client);
  const previousModelId = readActiveClaudeModelId(metadataSnapshot) ?? state.lastSeenModelId;
  // Keep the more specific spelling of the same model so its context window is not dropped.
  const modelId = isSameClaudeModel(previousModelId, reportedModelId)
    && stripContextSuffix(reportedModelId) === reportedModelId
    && previousModelId
    ? previousModelId
    : reportedModelId;
  const metadataRequestKey = buildMetadataRequestKey({ modelId, displayName, contextWindowTokens });

  const alreadyAppliedInMemory = state.lastSeenModelId === modelId;
  const shouldUpdateMetadata =
    (!alreadyAppliedInMemory && previousModelId !== modelId)
    || !hasRequestedModelDetails({ metadata: metadataSnapshot, modelId, displayName, contextWindowTokens });
  if (shouldUpdateMetadata && state.lastMetadataRequestKey !== metadataRequestKey) {
    state.lastMetadataRequestKey = metadataRequestKey;
    updateMetadataBestEffort(
      params.client,
      (metadata) => ({
        ...metadata,
        ...(buildClaudeSessionModelsMetadataWithCurrentModelId({
          currentModelId: modelId,
          metadata,
          currentModel: {
            ...(displayName ? { name: displayName } : {}),
            ...(contextWindowTokens !== null ? { contextWindowTokens } : {}),
          },
        }) ?? {}),
      }),
      params.logPrefix,
      'runtime_model_update',
    );
  }

  // Only a change of the model this runtime already observed is news. The first observation merely
  // resolves the session's selection (e.g. "default"), which is not a change the user made or saw.
  const observedModelId = state.lastSeenModelId;
  if (observedModelId && !isSameClaudeModel(observedModelId, modelId)) {
    const transitionKey = `${observedModelId}\u0000${modelId}`;
    if (state.lastEmittedTransitionKey !== transitionKey) {
      state.lastEmittedTransitionKey = transitionKey;
      params.client.sendSessionEvent(
        {
          type: 'message',
          message: `Model changed to ${resolveModelLabel({ metadata: metadataSnapshot, modelId, displayName })}`,
        },
        buildModelChangedEventId({ fromModelId: observedModelId, toModelId: modelId }),
      );
    }
  }

  state.lastSeenModelId = modelId;
}
