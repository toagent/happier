import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { useActiveSelectionMachineGroups } from '@/components/settings/server/hooks/useActiveSelectionMachineGroups';
import { getActiveServerSnapshot, listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { selectSyncErrorForServer } from '@/sync/runtime/connectivity/syncErrorScope';
import {
    useAllMachines,
    useAccountSettingsSyncStatus,
    useMachineListByServerId,
    useMachineListStatusByServerId,
    useSetting,
    useEndpointConnectivity,
    useSocketStatus,
    useSyncError,
} from '@/sync/domains/state/storage';
import { isAccountSettingsSyncAttentionStatus } from '@/sync/domains/settings/accountSettingsSyncStatus';
import { isMachineOnline } from '@/utils/sessions/machineUtils';

import { resolveConnectionHealthPresentation } from './connectionHealthPresentation';
import type { ServerLinkHealthKind } from './connectionHealthTypes';
import { resolveConnectionHealth, resolveServerLinkHealth, type ServerLinkHealthInput } from './resolveConnectionHealth';

function isMachineReadyForConnectionHealth(machine: Readonly<{ daemonState?: unknown }>): boolean {
    const daemonState = machine.daemonState;
    if (!daemonState || typeof daemonState !== 'object') {
        return true;
    }
    const status = (daemonState as { status?: unknown }).status;
    if (typeof status !== 'string') {
        return true;
    }
    return status === 'running';
}

/** The inputs of this client's link to the active server, shared by every link-health consumer. */
function useServerLinkHealthInput(): ServerLinkHealthInput {
    const socketStatus = useSocketStatus();
    const endpointConnectivity = useEndpointConnectivity();
    const syncError = useSyncError();
    const accountSettingsSyncStatus = useAccountSettingsSyncStatus();
    const activeServerId = getActiveServerSnapshot().serverId;
    const activeSyncError = React.useMemo(() => {
        return selectSyncErrorForServer(syncError, activeServerId);
    }, [activeServerId, syncError]);
    const activeAccountSettingsSyncIssue = isAccountSettingsSyncAttentionStatus(accountSettingsSyncStatus)
        ? accountSettingsSyncStatus
        : null;
    return React.useMemo(() => ({
        socketStatus: socketStatus.status,
        endpointStatus: endpointConnectivity.status,
        endpointReason: endpointConnectivity.reason,
        hasSyncError: Boolean(activeSyncError),
        syncErrorKind: activeSyncError?.kind,
        hasAccountSettingsSyncIssue: Boolean(activeAccountSettingsSyncIssue),
        accountSettingsSyncKind: activeAccountSettingsSyncIssue?.kind,
    }), [
        activeAccountSettingsSyncIssue,
        activeSyncError,
        endpointConnectivity.reason,
        endpointConnectivity.status,
        socketStatus.status,
    ]);
}

/** This client's link to the active server; null while connected and in sync. */
export function useServerLinkHealth(): ServerLinkHealthKind | null {
    const input = useServerLinkHealthInput();
    return React.useMemo(() => resolveServerLinkHealth(input), [input]);
}

export function useConnectionHealth() {
    const { theme } = useUnistyles();
    const serverLinkInput = useServerLinkHealthInput();
    const allMachines = useAllMachines();
    const machineListByServerId = useMachineListByServerId();
    const machineListStatusByServerId = useMachineListStatusByServerId();
    const serverSelectionGroups = useSetting('serverSelectionGroups');
    const serverSelectionActiveTargetKind = useSetting('serverSelectionActiveTargetKind');
    const serverSelectionActiveTargetId = useSetting('serverSelectionActiveTargetId');

    const activeServerSnapshot = getActiveServerSnapshot();
    const serverProfiles = React.useMemo(() => {
        try {
            return listServerProfiles().slice();
        } catch {
            return [];
        }
    }, [activeServerSnapshot.generation]);

    const activeSelectionMachineGroups = useActiveSelectionMachineGroups({
        activeServerSnapshot,
        allMachines,
        serverProfiles,
        machineListByServerId,
        machineListStatusByServerId,
        settings: {
            serverSelectionGroups,
            serverSelectionActiveTargetKind,
            serverSelectionActiveTargetId,
        },
    });
    const health = React.useMemo(() => {
        return resolveConnectionHealth({
            ...serverLinkInput,
            machineGroups: activeSelectionMachineGroups.visibleMachineGroups.map((group) => {
                if (group.status === 'loading' || group.status === 'signedOut') {
                    return {
                        machineCount: null,
                        onlineCount: null,
                        status: group.status,
                    };
                }

                const visibleMachines = group.machines.filter((machine) => !machine.revokedAt);
                const onlineMachines = visibleMachines.filter((machine) => isMachineOnline(machine));
                return {
                    machineCount: visibleMachines.length,
                    onlineCount: onlineMachines.length,
                    readyCount: onlineMachines.filter((machine) => isMachineReadyForConnectionHealth(machine)).length,
                    status: group.status,
                };
            }),
        });
    }, [activeSelectionMachineGroups.visibleMachineGroups, serverLinkInput]);

    const presentation = React.useMemo(() => {
        return resolveConnectionHealthPresentation(health, {
            connected: theme.colors.status.connected,
            connecting: theme.colors.status.connecting,
            actionRequired: theme.colors.status.actionRequired,
            disconnected: theme.colors.status.disconnected,
            error: theme.colors.status.error,
            default: theme.colors.status.default,
        });
    }, [health, theme.colors.status]);

    return {
        ...health,
        ...presentation,
    };
}
