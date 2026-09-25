import { computeMachinesSummary } from '@/components/sessions/guidance/gettingStartedModel';
import type { EndpointConnectivityStatus } from '@/sync/store/domains/realtime';

import type {
    ConnectionHealth,
    ConnectionHealthMachineGroup,
    ConnectionSocketStatus,
    ServerLinkHealthKind,
} from './connectionHealthTypes';

type ConnectionSyncErrorKind = 'auth' | 'config' | 'network' | 'server' | 'unknown';
type ConnectionEndpointReason = 'server_restarting' | string | null;

export type ServerLinkHealthInput = Readonly<{
    socketStatus: ConnectionSocketStatus;
    endpointStatus?: EndpointConnectivityStatus;
    endpointReason?: ConnectionEndpointReason;
    hasSyncError?: boolean;
    syncErrorKind?: ConnectionSyncErrorKind;
    hasAccountSettingsSyncIssue?: boolean;
    accountSettingsSyncKind?: ConnectionSyncErrorKind;
}>;

/** This client's link to the active server; null when it is connected and in sync. */
export function resolveServerLinkHealth(params: ServerLinkHealthInput): ServerLinkHealthKind | null {
    if (
        params.endpointReason === 'server_restarting'
        && (params.endpointStatus === 'offline' || params.endpointStatus === 'connecting')
    ) {
        return 'server_restarting';
    }
    if (params.endpointStatus === 'connecting' && params.socketStatus !== 'connected') return 'connecting';
    if (params.endpointStatus === 'auth_failed') return 'auth_required';
    if (params.endpointStatus === 'offline') return 'server_unreachable';

    const effectiveSyncErrorKind =
        params.syncErrorKind === 'auth' || params.accountSettingsSyncKind === 'auth'
            ? 'auth'
            : params.syncErrorKind ?? params.accountSettingsSyncKind;
    const hasAnySyncIssue = params.hasSyncError === true || params.hasAccountSettingsSyncIssue === true;

    if (effectiveSyncErrorKind === 'auth') return 'auth_required';
    if (hasAnySyncIssue || params.socketStatus === 'error') return 'server_error';
    if (params.socketStatus === 'connecting') return 'connecting';
    // The supervisor reports idle only before its first attempt (an outage is offline/connecting),
    // so a socket that is not up yet is starting, not lost.
    if (params.socketStatus !== 'connected' && params.endpointStatus === 'idle') return 'connecting';
    if (params.socketStatus !== 'connected') return 'server_unreachable';
    return null;
}

export function resolveConnectionHealth(params: ServerLinkHealthInput & Readonly<{
    machineGroups: ReadonlyArray<ConnectionHealthMachineGroup>;
}>): ConnectionHealth {
    let hasUnknownReadyCount = false;
    let readyCount = 0;
    const machines = computeMachinesSummary(
        params.machineGroups.map((group) => ({
            machineCount: group.machineCount,
            onlineCount: group.onlineCount,
        })),
    );

    for (const group of params.machineGroups) {
        const onlineCount = group.onlineCount;
        const groupReadyCount = group.readyCount === undefined ? onlineCount : group.readyCount;
        if (onlineCount === null || groupReadyCount === null) {
            hasUnknownReadyCount = true;
            continue;
        }
        readyCount += groupReadyCount;
    }

    const hasUnknownMachines = machines.hasUnknownServers || hasUnknownReadyCount;

    const serverLink = resolveServerLinkHealth(params);
    if (serverLink) {
        return {
            kind: serverLink,
            machineCount: machines.machineCount,
            onlineCount: machines.onlineCount,
            hasUnknownMachines,
            socketStatus: params.socketStatus,
        };
    }

    if (machines.machineCount === 0 && machines.hasUnknownServers) {
        return {
            kind: 'connecting',
            machineCount: machines.machineCount,
            onlineCount: machines.onlineCount,
            hasUnknownMachines,
            socketStatus: params.socketStatus,
        };
    }

    if (machines.machineCount === 0) {
        return {
            kind: 'no_machine',
            machineCount: machines.machineCount,
            onlineCount: machines.onlineCount,
            hasUnknownMachines,
            socketStatus: params.socketStatus,
        };
    }

    if (machines.onlineCount === 0) {
        return {
            kind: 'machine_offline',
            machineCount: machines.machineCount,
            onlineCount: machines.onlineCount,
            hasUnknownMachines,
            socketStatus: params.socketStatus,
        };
    }

    if (!hasUnknownMachines && readyCount < machines.onlineCount) {
        return {
            kind: 'machine_not_ready',
            machineCount: machines.machineCount,
            onlineCount: machines.onlineCount,
            hasUnknownMachines,
            socketStatus: params.socketStatus,
        };
    }

    return {
        kind: 'healthy',
        machineCount: machines.machineCount,
        onlineCount: machines.onlineCount,
        hasUnknownMachines,
        socketStatus: params.socketStatus,
    };
}
