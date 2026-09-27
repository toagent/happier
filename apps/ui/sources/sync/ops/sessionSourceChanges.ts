import {
    ScheduledSessionSourceChangesResultV1Schema,
    type ScheduledSessionSourceChangesActionV1,
    type ScheduledSessionSourceChangesResultV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

export type SessionSourceChangesResult =
    | ScheduledSessionSourceChangesResultV1
    | Readonly<{ status: 'unavailable'; error: string }>;

/**
 * Asks the scheduling controller about a task's changes in its source project: read the state, put
 * them into the project as uncommitted edits, or take them back out. The controller owns the task
 * workspace and the project checkout, so every decision (conflicts, ignored files) is made there.
 */
export async function requestSessionSourceChanges(request: Readonly<{
    controllerMachineId: string;
    serverId?: string | null;
    sessionId: string;
    action: ScheduledSessionSourceChangesActionV1;
}>): Promise<SessionSourceChangesResult> {
    try {
        const raw = await machineRpcWithServerScope<unknown, { sessionId: string; action: ScheduledSessionSourceChangesActionV1 }>({
            machineId: request.controllerMachineId,
            serverId: request.serverId ?? null,
            method: RPC_METHODS.DAEMON_SCHEDULED_SESSION_SOURCE_CHANGES_V1,
            payload: { sessionId: request.sessionId, action: request.action },
        });
        const parsed = ScheduledSessionSourceChangesResultV1Schema.safeParse(raw);
        return parsed.success ? parsed.data : { status: 'unavailable', error: 'malformed_source_changes_result' };
    } catch (error) {
        return { status: 'unavailable', error: error instanceof Error ? error.message : 'source_changes_failed' };
    }
}
