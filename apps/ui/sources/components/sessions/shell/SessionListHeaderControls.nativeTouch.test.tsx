import * as React from 'react';
import { StyleSheet } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

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

type HitSlop = number | { top?: number; bottom?: number; left?: number; right?: number } | undefined;

/** The area a finger can actually land on: the layout box grown by hitSlop. */
function touchExtent(node: { props: { style?: unknown; hitSlop?: HitSlop } } | null | undefined) {
    const flat = StyleSheet.flatten(node?.props.style as never) as Record<string, unknown> | undefined;
    // Animated sizes are not plain numbers in the test environment; only fixed bounds count here.
    const read = (...keys: string[]) => Math.max(0, ...keys.map((key) => Number(flat?.[key] ?? 0)).filter(Number.isFinite));
    const slop = node?.props.hitSlop;
    const side = (key: 'top' | 'bottom' | 'left' | 'right') => typeof slop === 'number' ? slop : slop?.[key] ?? 0;
    return {
        width: read('width', 'minWidth') + side('left') + side('right'),
        height: read('height', 'minHeight') + side('top') + side('bottom'),
    };
}

describe('session list header controls on native touch', () => {
    it('gives search, tag filter and view options a finger-sized touch area', async () => {
        const { SessionListHeaderControls } = await import('./SessionListHeaderControls');
        const { SessionListViewMenuButton } = await import('./sessionListViewMenu');
        const screen = await renderScreen(
            <SessionListHeaderControls
                allKnownTags={['work']}
                selectedTags={[]}
                searchQuery=""
                searchOpen={false}
                onSelectedTagsChange={vi.fn()}
                onSearchQueryChange={vi.fn()}
                searchTrailingAccessory={null}
                viewMenu={(
                    <SessionListViewMenuButton
                        folderViewMode="off"
                        onFolderViewModeChange={vi.fn()}
                        orderingMode="updated"
                        onOrderingModeChange={vi.fn()}
                        folderSortMode="mixed"
                        onFolderSortModeChange={vi.fn()}
                        hideInactiveSessions={false}
                        onHideInactiveSessionsChange={vi.fn()}
                    />
                )}
            />,
        );

        for (const testId of [
            'session-list-search-trigger',
            'session-list-tag-filter-trigger',
            'session-list-ordering-menu-trigger',
        ]) {
            const extent = touchExtent(screen.findByTestId(testId));
            expect(extent.height, `${testId} height`).toBeGreaterThanOrEqual(SESSION_LIST_NATIVE_TOUCH_TARGET_SIZE);
            // The search shell's width is animated and the test Animated mock does not evaluate
            // interpolations, so its collapsed width is verified on device bounds instead.
            if (testId !== 'session-list-search-trigger') {
                expect(extent.width, `${testId} width`).toBeGreaterThanOrEqual(SESSION_LIST_NATIVE_TOUCH_TARGET_SIZE);
            }
        }
    });
});
