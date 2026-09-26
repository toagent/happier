import * as React from 'react';

import type { AgentId } from '@/agents/catalog/catalog';
import type { ActionListItem } from '@/components/ui/lists/ActionListSection';

import { flattenAgentInputActionMenuControlActions, resolveAgentInputActionMenuControlActions } from '../actionMenuActions';
import type { AgentInputControlId } from './agentInputControlTypes';
import type { AgentInputExtraActionChip } from '../agentInputContracts';
import { buildCollapsedExtraControlActions } from './buildCollapsedExtraControlActions';

export function useAgentInputActionMenuActions(params: Readonly<{
    actionBarIsCollapsed: boolean;
    hasAnyActions: boolean;
    tint: string;
    agentId: AgentId;
    profileLabel: string | null;
    profileIcon: string;
    envVarsCount?: number;
    engineLabel?: string | null;
    agentType?: AgentId;
    machineName?: string | null;
    currentPath?: string | null;
    resumeSessionId?: string | null;
    sessionId?: string;
    extraActionChips?: readonly AgentInputExtraActionChip[];
    dismissActionMenu: () => void;
    blurInput: () => void;
    openCollapsedOptionsPopover: (chipKey: string | null) => void;
    resetCorePopovers: () => void;
    permissionLabel?: string | null;
    onPermissionClick?: () => void;
    onProfileClick?: () => void;
    onEnvVarsClick?: () => void;
    onAgentClick?: () => void;
    sessionModeLabel?: string | null;
    onSessionModeClick?: () => void;
    onMachineClick?: () => void;
    onPathClick?: () => void;
    onResumeClick?: () => void;
    onFileViewerPress?: () => void;
    canStop?: boolean;
    onStop?: () => void;
}>): Readonly<{
    actions: ReadonlyArray<ActionListItem>;
    /** Controls the menu reaches, so the collapsed composer can leave their chips out. */
    menuControlIds: ReadonlySet<AgentInputControlId>;
}> {
    return React.useMemo(() => {
        const extraControlActions = buildCollapsedExtraControlActions({
            chips: params.extraActionChips,
            tint: params.tint,
            dismiss: params.dismissActionMenu,
            blurInput: params.blurInput,
            openCollapsedOptionsPopover: (chipKey) => params.openCollapsedOptionsPopover(chipKey),
            resetCorePopovers: params.resetCorePopovers,
        });

        const controlActionsById = resolveAgentInputActionMenuControlActions({
            actionBarIsCollapsed: params.actionBarIsCollapsed,
            hasAnyActions: params.hasAnyActions,
            tint: params.tint,
            agentId: params.agentId,
            profileLabel: params.profileLabel,
            profileIcon: params.profileIcon,
            envVarsCount: params.envVarsCount,
            engineLabel: params.engineLabel,
            agentType: params.agentType,
            machineName: params.machineName,
            currentPath: params.currentPath,
            resumeSessionId: params.resumeSessionId,
            sessionId: params.sessionId,
            permissionLabel: params.permissionLabel,
            onPermissionClick: params.onPermissionClick,
            onProfileClick: params.onProfileClick,
            onEnvVarsClick: params.onEnvVarsClick,
            onAgentClick: params.onAgentClick,
            sessionModeLabel: params.sessionModeLabel,
            onSessionModeClick: params.onSessionModeClick,
            onMachineClick: params.onMachineClick,
            onPathClick: params.onPathClick,
            onResumeClick: params.onResumeClick,
            onFileViewerPress: params.onFileViewerPress,
            canStop: params.canStop,
            onStop: params.onStop,
            extraControlActions,
            dismiss: params.dismissActionMenu,
            blurInput: params.blurInput,
        });
        return {
            actions: flattenAgentInputActionMenuControlActions(controlActionsById),
            menuControlIds: new Set(Object.keys(controlActionsById) as AgentInputControlId[]),
        };
    }, [
        params.actionBarIsCollapsed,
        params.agentId,
        params.agentType,
        params.blurInput,
        params.canStop,
        params.currentPath,
        params.dismissActionMenu,
        params.envVarsCount,
        params.engineLabel,
        params.extraActionChips,
        params.hasAnyActions,
        params.machineName,
        params.onAgentClick,
        params.onEnvVarsClick,
        params.onPermissionClick,
        params.permissionLabel,
        params.onFileViewerPress,
        params.onMachineClick,
        params.onPathClick,
        params.onProfileClick,
        params.onResumeClick,
        params.onSessionModeClick,
        params.onStop,
        params.openCollapsedOptionsPopover,
        params.profileIcon,
        params.profileLabel,
        params.resetCorePopovers,
        params.resumeSessionId,
        params.sessionId,
        params.sessionModeLabel,
        params.tint,
    ]);
}
