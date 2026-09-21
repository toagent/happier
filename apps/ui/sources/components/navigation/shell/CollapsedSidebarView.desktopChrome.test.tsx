import React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

import { installNavigationShellCommonModuleMocks } from './navigationShellTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const collapsedSidebarState = vi.hoisted(() => ({
    setSidebarCollapsed: vi.fn(),
}));

const inboxState = vi.hoisted(() => ({
    model: { hasContent: true },
}));

const platformState = vi.hoisted(() => ({
    os: 'web' as 'web' | 'android',
}));

const desktopWindowBridgeState = vi.hoisted(() => ({
    getDesktopWindowChromePolicy: vi.fn(),
    getDesktopWindowState: vi.fn(),
    listenDesktopWindowState: vi.fn(),
    minimizeDesktopWindow: vi.fn(),
    toggleDesktopWindowMaximize: vi.fn(),
    closeDesktopWindow: vi.fn(),
    startDesktopWindowDragging: vi.fn(),
}));

installNavigationShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return platformState.os;
                },
            },
        });
    },
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            useLocalSettingMutable: (key: string) => {
                if (key === 'sidebarCollapsed') {
                    return [true, collapsedSidebarState.setSidebarCollapsed] as const;
                }
                return [null, vi.fn()] as const;
            },
        });
    },
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props),
}));

vi.mock('@/components/inbox/InboxPopoverButton', () => ({
    InboxPopoverButton: (props: Record<string, unknown>) => React.createElement('InboxPopoverButton', props),
}));

vi.mock('@/components/inbox/actionOperations/ActionOperationActivityButton', () => ({
    ActionOperationActivityButton: (props: Record<string, unknown>) => React.createElement('ActionOperationActivityButton', props),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 56,
}));

vi.mock('@/utils/platform/desktopWindowBridge', () => ({
    getDesktopWindowChromePolicy: () => desktopWindowBridgeState.getDesktopWindowChromePolicy(),
    getDesktopWindowState: () => desktopWindowBridgeState.getDesktopWindowState(),
    listenDesktopWindowState: (handler: (state: { isMaximized: boolean }) => void) =>
        desktopWindowBridgeState.listenDesktopWindowState(handler),
    minimizeDesktopWindow: () => desktopWindowBridgeState.minimizeDesktopWindow(),
    toggleDesktopWindowMaximize: () => desktopWindowBridgeState.toggleDesktopWindowMaximize(),
    closeDesktopWindow: () => desktopWindowBridgeState.closeDesktopWindow(),
    startDesktopWindowDragging: () => desktopWindowBridgeState.startDesktopWindowDragging(),
}));

describe('CollapsedSidebarView desktop chrome', () => {
    beforeEach(() => {
        platformState.os = 'web';
        collapsedSidebarState.setSidebarCollapsed.mockReset();
        desktopWindowBridgeState.getDesktopWindowChromePolicy.mockReset();
        desktopWindowBridgeState.getDesktopWindowState.mockReset();
        desktopWindowBridgeState.listenDesktopWindowState.mockReset();
        desktopWindowBridgeState.minimizeDesktopWindow.mockReset();
        desktopWindowBridgeState.toggleDesktopWindowMaximize.mockReset();
        desktopWindowBridgeState.closeDesktopWindow.mockReset();
        desktopWindowBridgeState.startDesktopWindowDragging.mockReset();
        desktopWindowBridgeState.getDesktopWindowChromePolicy.mockResolvedValue({ strategy: 'custom-controls' });
        desktopWindowBridgeState.getDesktopWindowState.mockResolvedValue({ isMaximized: false });
        desktopWindowBridgeState.listenDesktopWindowState.mockResolvedValue(async () => {});
    });

    it('renders collapsed desktop chrome hosts and expands the sidebar', async () => {
        const { CollapsedSidebarView } = await import('./CollapsedSidebarView');
        const screen = await renderScreen(
            <CollapsedSidebarView
                desktopWindowControls={<View testID="injected-collapsed-window-controls" />}
                desktopUpdateIndicator={<View testID="injected-collapsed-update-indicator" />}
            />,
        );

        expect(screen.findByTestId('desktop-collapsed-shell-chrome')).toBeTruthy();
        expect(screen.findByTestId('desktop-window-controls-host')).toBeTruthy();
        expect(screen.findByTestId('injected-collapsed-window-controls')).toBeTruthy();
        expect(screen.findByTestId('injected-collapsed-update-indicator')).toBeTruthy();
        expect(screen.findAllByTestId('collapsed-sidebar-home-button')).toHaveLength(0);

        await act(async () => {
            await pressTestInstanceAsync(screen.findByTestId('sidebar-expand-button'));
        });

        expect(collapsedSidebarState.setSidebarCollapsed).toHaveBeenCalledWith(false);
    });

    it('exits focus mode through the expand affordance without changing persisted collapse state directly', async () => {
        const onRequestExpand = vi.fn();
        const { CollapsedSidebarView } = await import('./CollapsedSidebarView');
        const screen = await renderScreen(
            <CollapsedSidebarView
                focusModeActive={true}
                onRequestExpand={onRequestExpand}
            />,
        );

        await act(async () => {
            await pressTestInstanceAsync(screen.findByTestId('sidebar-expand-button'));
        });

        expect(onRequestExpand).toHaveBeenCalledTimes(1);
        expect(collapsedSidebarState.setSidebarCollapsed).not.toHaveBeenCalled();
    });

    it('gives the collapsed expand affordance a translated accessible name', async () => {
        const { CollapsedSidebarView } = await import('./CollapsedSidebarView');
        const screen = await renderScreen(<CollapsedSidebarView />);

        expect(screen.findByTestId('sidebar-expand-button')?.props.accessibilityLabel).toBe('common.expand');
    });

    it('renders both Inbox and Activity in the collapsed rail when Inbox is available', async () => {
        const { CollapsedSidebarView } = await import('./CollapsedSidebarView');
        const screen = await renderScreen(
            <CollapsedSidebarView inboxEnabled inboxModel={inboxState.model as never} />,
        );

        const inboxButton = screen.findByType('InboxPopoverButton' as never);
        expect(inboxButton.props).toMatchObject({
            model: inboxState.model,
            testID: 'collapsed-sidebar-inbox-button',
        });
        expect(screen.findByTestId('collapsed-sidebar-action-operations')).toBeTruthy();
    });

    it('keeps action operations as the fallback when Inbox is unavailable', async () => {
        const { CollapsedSidebarView } = await import('./CollapsedSidebarView');
        const screen = await renderScreen(
            <CollapsedSidebarView inboxEnabled={false} inboxModel={inboxState.model as never} />,
        );

        expect(screen.findAllByType('InboxPopoverButton' as never)).toHaveLength(0);
        expect(screen.findByTestId('collapsed-sidebar-action-operations')).toBeTruthy();
    });

    // The collapse control in the expanded chrome is not web-only, so a tablet user can put the
    // sidebar into this rail and then has to be able to take it back out.
    it('keeps the expand affordance reachable on a touch tablet', async () => {
        platformState.os = 'android';
        const { CollapsedSidebarView } = await import('./CollapsedSidebarView');
        const screen = await renderScreen(<CollapsedSidebarView />);

        await act(async () => {
            await pressTestInstanceAsync(screen.findByTestId('sidebar-expand-button'));
        });

        expect(collapsedSidebarState.setSidebarCollapsed).toHaveBeenCalledWith(false);
    });

    // The expanded chrome already gives native real 48-point boxes instead of leaning on hitSlop;
    // the rail draws the same controls and has to size them the same way.
    it('gives every rail control a real 48-point target on a touch tablet', async () => {
        platformState.os = 'android';
        const { CollapsedSidebarView } = await import('./CollapsedSidebarView');
        const screen = await renderScreen(
            <CollapsedSidebarView inboxEnabled inboxModel={inboxState.model as never} />,
        );

        const flatten = (style: unknown) => Object.assign(
            {},
            ...(Array.isArray(style) ? style : [style]).filter(Boolean) as object[],
        );

        expect(flatten(screen.findByTestId('collapsed-sidebar-home-button')?.props.style))
            .toMatchObject({ width: 48, height: 48 });
        expect(flatten(screen.findByTestId('sidebar-expand-button')?.props.style))
            .toMatchObject({ width: 48, height: 48 });
        expect(screen.findByType('InboxPopoverButton' as never).props.buttonSize).toBe(48);
        expect(screen.findByType('ActionOperationActivityButton' as never).props.buttonSize).toBe(48);
    });

    // Pointer builds keep the compact chrome sizes; the touch treatment must not leak to them.
    it('keeps the compact rail sizes on web', async () => {
        const { CollapsedSidebarView } = await import('./CollapsedSidebarView');
        const screen = await renderScreen(
            <CollapsedSidebarView inboxEnabled inboxModel={inboxState.model as never} />,
        );

        expect(screen.findByType('InboxPopoverButton' as never).props.buttonSize).toBe(32);
        expect(screen.findByType('ActionOperationActivityButton' as never).props.buttonSize).toBe(32);
    });

    // The rail is the sidebar's CLOSED state, so its button opens rather than closes. It used to
    // render the collapse glyph anyway — the same drawing the expanded chrome shows — so the control
    // looked identical whichever state you were in.
    it('shows the expand glyph on the rail, not the collapse one', async () => {
        const { CollapsedSidebarView } = await import('./CollapsedSidebarView');
        const screen = await renderScreen(<CollapsedSidebarView />);

        const expandButton = screen.findByTestId('sidebar-expand-button');
        expect(expandButton?.findByType('Icon' as never).props.name).toBe('sidebar-left-open');
    });
});
