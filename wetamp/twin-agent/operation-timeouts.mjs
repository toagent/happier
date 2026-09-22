export const REMOTE_HELPER_TIMEOUT_MS = 30_000;
export const SNAPSHOT_PREPARATION_TIMEOUT_MS = 300_000;

export function remoteStartTimeoutMs(workspaceMode) {
  return workspaceMode === "local_snapshot"
    ? SNAPSHOT_PREPARATION_TIMEOUT_MS
    : REMOTE_HELPER_TIMEOUT_MS;
}
