import * as React from 'react';
import { Pressable } from 'react-native';

import type { TwinSessionSchedulingV1 } from '@happier-dev/protocol';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { SelectionListStep } from '@/components/ui/selectionList';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';
import {
    AGENT_INPUT_CHIP_ICON_SIZE_PX,
    AGENT_INPUT_CHIP_ICON_STYLE,
    AGENT_INPUT_MENU_ICON_SIZE_PX,
} from './agentInputChipIconMetrics';

type SchedulingWorker = TwinSessionSchedulingV1['workers'][number];

function buildSchedulingWorkerRootStep(params: Readonly<{
    workers: ReadonlyArray<SchedulingWorker>;
    onSelect: (workerId: string) => void;
}>): SelectionListStep {
    const title = t('newSession.executionNode');
    return {
        id: 'new-session-scheduling-worker-root',
        title,
        sections: [{
            kind: 'static',
            id: 'new-session-scheduling-workers',
            options: params.workers.map((worker) => ({
                id: worker.workerId,
                label: worker.workerId,
                subtitle: worker.machineId,
                onSelect: () => params.onSelect(worker.workerId),
            })),
        }],
    };
}

export function createSchedulingWorkerActionChip(params: Readonly<{
    workers: ReadonlyArray<SchedulingWorker>;
    selectedWorkerId: string;
    onWorkerChange: (workerId: string) => void;
}>): AgentInputExtraActionChip {
    const title = t('newSession.executionNode');
    const rootStep = buildSchedulingWorkerRootStep({
        workers: params.workers,
        onSelect: params.onWorkerChange,
    });
    return {
        key: 'new-session-scheduling-worker',
        stabilityKey: params.selectedWorkerId,
        collapsedOptionsPopover: {
            presentation: 'list',
            title,
            label: params.selectedWorkerId,
            icon: (tint) => normalizeNodeForView(
                <Icon name="cpu" size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />,
            ),
            rootStep,
            selectedOptionId: params.selectedWorkerId,
            onSelect: () => {},
            maxHeightCap: 360,
        },
        render: ({ chipStyle, iconColor, showLabel, textStyle, chipAnchorRef, toggleCollapsedPopover }) => (
            <Pressable
                ref={chipAnchorRef}
                testID="agent-input-scheduling-worker-chip"
                accessibilityRole="button"
                accessibilityLabel={`${title}: ${params.selectedWorkerId}`}
                onPress={() => toggleCollapsedPopover?.('new-session-scheduling-worker')}
                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                style={({ pressed }) => chipStyle(pressed)}
            >
                {normalizeNodeForView(<Icon name="cpu" size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={iconColor} style={AGENT_INPUT_CHIP_ICON_STYLE} />)}
                {showLabel ? <Text numberOfLines={1} style={textStyle}>{params.selectedWorkerId}</Text> : null}
            </Pressable>
        ),
    };
}
