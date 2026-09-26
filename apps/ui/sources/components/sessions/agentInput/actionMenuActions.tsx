import * as React from 'react';
import type { AgentId } from '@/agents/catalog/catalog';
import type { ActionListItem } from '@/components/ui/lists/ActionListSection';
import { resolveAgentInputControlLines } from './controls/resolveAgentInputControlLines';
import type { AgentInputControlId } from './controls/agentInputControlTypes';
import { buildCoreCollapsedControlActions } from './controls/buildCoreCollapsedControlActions';

export function buildAgentInputActionMenuActions(opts: {
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
    extraControlActions?: Partial<Record<AgentInputControlId, ActionListItem | ReadonlyArray<ActionListItem>>>;
    dismiss: () => void;
    blurInput: () => void;
}): ActionListItem[] {
    return flattenAgentInputActionMenuControlActions(resolveAgentInputActionMenuControlActions(opts));
}

export type AgentInputActionMenuControlActions = Partial<Record<AgentInputControlId, ReadonlyArray<ActionListItem>>>;

/**
 * The collapsed action menu, grouped by the control each entry stands in for. A control with an entry
 * here is reachable from the menu, which is what lets the collapsed composer drop its chip.
 */
export function resolveAgentInputActionMenuControlActions(
    opts: Parameters<typeof buildAgentInputActionMenuActions>[0],
): AgentInputActionMenuControlActions {
    if (!opts.actionBarIsCollapsed || !opts.hasAnyActions) return {};

    const controlActionsById: Partial<Record<AgentInputControlId, ReadonlyArray<ActionListItem>>> = {
        ...buildCoreCollapsedControlActions(opts),
    };
    for (const [controlId, actionOrActions] of Object.entries(opts.extraControlActions ?? {}) as Array<[AgentInputControlId, ActionListItem | ReadonlyArray<ActionListItem>]>) {
        controlActionsById[controlId] = Array.isArray(actionOrActions) ? actionOrActions : [actionOrActions];
    }
    return controlActionsById;
}

export function flattenAgentInputActionMenuControlActions(
    controlActionsById: AgentInputActionMenuControlActions,
): ActionListItem[] {
    const orderedControlIds = resolveAgentInputControlLines({
        layout: 'collapsed',
        controlIds: Object.keys(controlActionsById) as AgentInputControlId[],
    }).collapsed;

    return [
        ...orderedControlIds.flatMap((controlId) => {
            return controlActionsById[controlId] ?? [];
        }),
    ];
}
