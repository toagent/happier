import * as React from 'react';
import { StyleSheet } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { SessionListViewItem } from '@/sync/domains/state/storage';

import { SESSION_LIST_NATIVE_TOUCH_TARGET_SIZE } from './sessionListRowHeights';

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'android' });
});

vi.mock('@/text', async () => {
    const { installTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return installTextModuleMock({ translate: (key: string) => key })();
});

vi.mock('react-native-unistyles', async () => {
    const { installUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return installUnistylesMock()();
});

// The menu's own popover behavior is covered by the DropdownMenu suite; render only its trigger.
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: { trigger: (api: { toggle: () => void }) => React.ReactNode }) =>
        props.trigger({ toggle: () => {} }),
}));

afterEach(() => {
    standardCleanup();
});

const projectHeader: Extract<SessionListViewItem, { type: 'header' }> = {
    type: 'header',
    title: 'happier',
    headerKind: 'project',
    groupKey: 'server:s1:project:p1',
    serverId: 's1',
    workspaceKey: 'ws1',
    workspaceScopeHint: { serverId: 's1', machineId: 'm1', rootPath: '/repo/happier' },
} as Extract<SessionListViewItem, { type: 'header' }>;

function touchBox(style: unknown): { width: number; height: number } {
    const flat = StyleSheet.flatten(style as never) as Record<string, unknown> | undefined;
    const read = (...keys: string[]) => Math.max(0, ...keys.map((key) => Number(flat?.[key] ?? 0)));
    return { width: read('width', 'minWidth'), height: read('height', 'minHeight') };
}

describe('ProjectGroupHeader on native touch', () => {
    it('sizes every tappable control for a finger and drops the pointer-only reorder handle', async () => {
        const { ProjectGroupHeader } = await import('./ProjectGroupHeader');
        const screen = await renderScreen(
            <ProjectGroupHeader
                item={projectHeader}
                hasMultipleMachines={false}
                workspaceLabelsV1={{}}
                onRenameWorkspace={vi.fn()}
                onResetWorkspaceName={vi.fn()}
                onCreateSession={vi.fn()}
                onAddFolder={vi.fn()}
                collapsed={false}
                onToggleCollapse={vi.fn()}
                headerTestId="project-header"
            />,
        );

        // Native reordering starts from a long press on the whole header, so the handle only eats taps.
        expect(screen.root.findAll((node) => String(node.props?.testID ?? '').startsWith('session-workspace-reorder-handle')))
            .toHaveLength(0);

        const controls = [
            screen.findByTestId('project-header'),
            ...screen.root.findAll((node) => typeof node.props?.onPress === 'function'
                && (node.props?.accessibilityLabel === 'common.moreActions'
                    || node.props?.accessibilityLabel === 'machine.launchNewSessionInDirectory')),
        ];
        const labels = new Set(controls.map((node) => node?.props.accessibilityLabel));
        expect(labels).toEqual(new Set(['happier', 'common.moreActions', 'machine.launchNewSessionInDirectory']));

        for (const control of controls) {
            const box = touchBox(control?.props.style);
            expect(box.height, String(control?.props.accessibilityLabel)).toBeGreaterThanOrEqual(SESSION_LIST_NATIVE_TOUCH_TARGET_SIZE);
            if (control?.props.accessibilityLabel !== 'happier') {
                expect(box.width, String(control?.props.accessibilityLabel)).toBeGreaterThanOrEqual(SESSION_LIST_NATIVE_TOUCH_TARGET_SIZE);
            }
        }
    });
});
