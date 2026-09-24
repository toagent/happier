import * as React from 'react';
import { StyleSheet } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import type { SegmentedTab } from './SegmentedTabBar';
import { installNavigationCommonModuleMocks } from './navigationTestHelpers';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installNavigationCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock(
            { platformOS: 'android' },
            {
                View: 'View',
                I18nManager: { isRTL: false },
                Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
            },
        );
    },
});

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

const TABS: ReadonlyArray<SegmentedTab<'alpha' | 'beta'>> = [
    { id: 'alpha', label: 'Alpha' },
    { id: 'beta', label: 'Beta' },
];

function numeric(style: unknown, key: string): number {
    const value = Number((StyleSheet.flatten(style as never) as Record<string, unknown> | undefined)?.[key] ?? 0);
    return Number.isFinite(value) ? value : 0;
}

describe('SegmentedTabBar on native touch', () => {
    it('makes each tab a finger-sized target', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const screen = await renderScreen(
            <SegmentedTabBar tabs={TABS} activeTabId="alpha" onSelectTab={vi.fn()} testIDPrefix="tab" />,
        );
        const tab = screen.findByTestId('tab:beta');
        expect(numeric(tab?.props.style, 'minHeight')).toBeGreaterThanOrEqual(44);
    });
});
