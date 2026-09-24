import * as React from 'react';
import { StyleSheet } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import { SESSION_LIST_NATIVE_TOUCH_TARGET_SIZE } from './sessionListRowHeights';

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'android' });
});

vi.mock('react-native-unistyles', async () => {
    const { installUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return installUnistylesMock()();
});

afterEach(() => {
    standardCleanup();
});

function numeric(style: unknown, key: string): number {
    const value = Number((StyleSheet.flatten(style as never) as Record<string, unknown> | undefined)?.[key] ?? 0);
    return Number.isFinite(value) ? value : 0;
}

describe('CollapsibleSectionHeader on native touch', () => {
    it.each(['active', 'date'] as const)('gives the %s header a finger-sized tap row', async (headerKind) => {
        const { CollapsibleSectionHeader } = await import('./CollapsibleSectionHeader');
        const screen = await renderScreen(
            <CollapsibleSectionHeader
                title="Header"
                headerKind={headerKind}
                collapsed={false}
                onPress={vi.fn()}
                headerTestId="header"
            />,
        );
        const pressable = screen.findByTestId('header');
        const row = pressable?.findAll((node) => String(node.type) === 'View')[0];
        // Padding around the row is still part of the tappable header.
        const tapHeight = numeric(pressable?.props.style, 'paddingTop')
            + numeric(pressable?.props.style, 'paddingBottom')
            + numeric(row?.props.style, 'minHeight');
        expect(tapHeight).toBeGreaterThanOrEqual(SESSION_LIST_NATIVE_TOUCH_TARGET_SIZE);
    });
});
