import React from 'react';
import { View } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installNavigationShellCommonModuleMocks } from '../navigationShellTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const desktopWindowBridgeState = vi.hoisted(() => ({
    startDesktopWindowDragging: vi.fn(),
}));

const itemRowActionsState = vi.hoisted(() => ({
    lastActionIds: [] as string[],
    lastButtonSize: null as number | null,
}));

const platformState = vi.hoisted(() => ({
    os: 'web' as 'web' | 'ios',
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
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
            View: 'View',
            Text: 'Text',
        });
    },
});

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@/components/navigation/ConnectionStatusControl', () => ({
    ConnectionStatusControl: 'ConnectionStatusControl',
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: (props: {
        actions: Array<{ id: string }>;
        buttonSize?: number;
        renderOverflowTrigger?: (params: {
            open: boolean;
            toggle: () => void;
            testID: string;
            accessibilityLabel: string;
            accessibilityHint: string;
        }) => React.ReactNode;
    }) => {
        itemRowActionsState.lastActionIds = props.actions.map((action) => action.id);
        itemRowActionsState.lastButtonSize = props.buttonSize ?? null;
        return React.createElement(
            View,
            { testID: 'desktop-sidebar-item-actions' },
            props.renderOverflowTrigger?.({
                open: false,
                toggle: vi.fn(),
                testID: 'sidebar-header-actions-overflow',
                accessibilityLabel: 'More actions',
                accessibilityHint: 'Open more actions',
            }),
        );
    },
}));

vi.mock('@/utils/platform/desktopWindowBridge', () => ({
    startDesktopWindowDragging: () => desktopWindowBridgeState.startDesktopWindowDragging(),
}));

function requireTestInstance(node: ReactTestInstance | null, label: string): ReactTestInstance {
    expect(node, `${label} should be present`).toBeTruthy();
    return node!;
}

function directChildTestIDs(instance: ReactTestInstance): string[] {
    return instance.children
        .filter((child): child is ReactTestInstance => typeof child === 'object' && child != null && 'props' in child)
        .map((child) => child.props.testID)
        .filter((testID): testID is string => typeof testID === 'string');
}

describe('DesktopSidebarChrome', () => {
    beforeEach(() => {
        desktopWindowBridgeState.startDesktopWindowDragging.mockReset();
        itemRowActionsState.lastActionIds = [];
        itemRowActionsState.lastButtonSize = null;
        platformState.os = 'web';
    });

    it('stacks tablet chrome and uses real 48-point action targets on native', async () => {
        platformState.os = 'ios';
        const { DesktopSidebarChrome } = await import('./DesktopSidebarChrome');
        const screen = await renderScreen(
            <DesktopSidebarChrome
                sidebarWidthPx={320}
                headerHeightPx={56}
                onPressHome={vi.fn()}
                environmentBadge="DEV"
                headerActions={[
                    { id: 'settings', title: 'Settings', inlineTestID: 'nav-settings', icon: 'gear', onPress: vi.fn() },
                    { id: 'newSession', title: 'New', inlineTestID: 'nav-new-session', icon: 'plus', onPress: vi.fn() },
                ]}
                renderHeaderOverflowVisual={() => <View testID="desktop-sidebar-overflow-visual" />}
                popoverBoundaryRef={{ current: null }}
            />,
        );

        const contentRow = requireTestInstance(screen.findByTestId('desktop-sidebar-chrome-content-row'), 'content row');
        const contentRowStyle = Object.assign({}, ...contentRow.props.style.filter(Boolean));
        const brandGroup = requireTestInstance(screen.findByTestId('desktop-sidebar-chrome-brand-group'), 'brand group');
        const brandGroupStyles = Array.isArray(brandGroup.props.style) ? brandGroup.props.style : [brandGroup.props.style];
        const brandGroupStyle = Object.assign({}, ...brandGroupStyles.filter(Boolean));

        expect(contentRowStyle).toMatchObject({ flexDirection: 'column', alignItems: 'stretch' });
        expect(brandGroupStyle).toMatchObject({ flexGrow: 0, flexShrink: 0, minHeight: 48 });
        expect(itemRowActionsState.lastButtonSize).toBe(48);
    });

    it('puts the server switcher on the native action row as a 48-point target', async () => {
        platformState.os = 'ios';
        const { DesktopSidebarChrome } = await import('./DesktopSidebarChrome');
        const screen = await renderScreen(
            <DesktopSidebarChrome
                sidebarWidthPx={320}
                headerHeightPx={56}
                onPressHome={vi.fn()}
                environmentBadge={null}
                headerActions={[
                    { id: 'settings', title: 'Settings', inlineTestID: 'nav-settings', icon: 'gear', onPress: vi.fn() },
                ]}
                renderHeaderOverflowVisual={() => <View testID="desktop-sidebar-overflow-visual" />}
                popoverBoundaryRef={{ current: null }}
            />,
        );

        // Under the title it could only be a 16px line; the action row already has 48px of height
        // and free space on its leading side.
        const actionsRow = requireTestInstance(screen.findByTestId('desktop-sidebar-chrome-actions-row'), 'actions row');
        const titleContainer = requireTestInstance(screen.findByTestId('desktop-sidebar-title-container'), 'title container');
        const statusInActions = actionsRow.findAll((node) => String(node.type) === 'ConnectionStatusControl');
        expect(statusInActions).toHaveLength(1);
        expect(statusInActions[0]?.props.minTouchHeight).toBe(48);
        expect(titleContainer.findAll((node) => String(node.type) === 'ConnectionStatusControl')).toHaveLength(0);
    });

    it('places utility controls above the branded sidebar row', async () => {
        const { DesktopSidebarChrome } = await import('./DesktopSidebarChrome');
        const screen = await renderScreen(
            <DesktopSidebarChrome
                sidebarWidthPx={600}
                headerHeightPx={56}
                onPressHome={vi.fn()}
                onPressCollapse={vi.fn()}
                onPressBack={vi.fn()}
                onPressForward={vi.fn()}
                environmentBadge={null}
                headerActions={[]}
                topUtilityActions={[{
                    id: 'settings',
                    title: 'settings.title',
                    inlineTestID: 'nav-settings',
                    icon: 'gear',
                    onPress: vi.fn(),
                }]}
                renderHeaderOverflowVisual={() => <View testID="desktop-sidebar-overflow-visual" />}
                popoverBoundaryRef={{ current: null }}
                desktopWindowControls={<View testID="injected-desktop-window-controls" />}
                desktopUpdateIndicator={<View testID="injected-desktop-update-indicator" />}
            />,
        );

        const chrome = requireTestInstance(screen.findByTestId('desktop-sidebar-chrome'), 'desktop chrome');
        const controlsRow = requireTestInstance(screen.findByTestId('desktop-sidebar-chrome-controls-row'), 'controls row');
        const contentRow = requireTestInstance(screen.findByTestId('desktop-sidebar-chrome-content-row'), 'content row');
        const brandGroup = requireTestInstance(screen.findByTestId('desktop-sidebar-chrome-brand-group'), 'brand group');
        const actionsRow = requireTestInstance(screen.findByTestId('desktop-sidebar-chrome-actions-row'), 'actions row');

        expect(chrome.children[0]).toBe(controlsRow);
        expect(chrome.children[1]).toBe(contentRow);
        expect(directChildTestIDs(screen.findByTestId('desktop-sidebar-chrome-utility-row')!)).toEqual([
            'sidebar-back-button',
            'sidebar-forward-button',
            'desktop-sidebar-action-operations',
            'nav-settings',
            'sidebar-collapse-button',
        ]);
        expect(contentRow.children).toEqual([brandGroup, actionsRow]);
        expect(brandGroup.findByProps({ accessibilityLabel: 'common.home' })).toBeTruthy();
        expect(actionsRow.findAll((child) => child.props?.testID === 'desktop-update-indicator-host')).toHaveLength(0);
        expect(screen.findByTestId('desktop-sidebar-title-container')!.findByProps({ testID: 'injected-desktop-update-indicator' })).toBeTruthy();
    });

    it('starts window dragging from non-interactive sidebar top strip clicks', async () => {
        const { DesktopSidebarChrome } = await import('./DesktopSidebarChrome');
        const screen = await renderScreen(
            <DesktopSidebarChrome
                sidebarWidthPx={600}
                headerHeightPx={56}
                onPressHome={vi.fn()}
                onPressCollapse={vi.fn()}
                onPressBack={vi.fn()}
                onPressForward={vi.fn()}
                environmentBadge={null}
                headerActions={[]}
                renderHeaderOverflowVisual={() => <View testID="desktop-sidebar-overflow-visual" />}
                popoverBoundaryRef={{ current: null }}
                desktopWindowControls={<View testID="injected-desktop-window-controls" />}
            />,
        );

        const controlsRow = requireTestInstance(screen.findByTestId('desktop-sidebar-chrome-controls-row'), 'controls row');
        const preventDefault = vi.fn();
        controlsRow.props.onMouseDown?.({
            buttons: 1,
            preventDefault,
            target: { closest: vi.fn(() => null) },
        });

        expect(controlsRow.props['data-tauri-drag-region']).toBe(true);
        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(desktopWindowBridgeState.startDesktopWindowDragging).toHaveBeenCalledTimes(1);
    });

    it('marks unavailable browser history controls disabled without removing them', async () => {
        const { DesktopSidebarChrome } = await import('./DesktopSidebarChrome');
        const screen = await renderScreen(
            <DesktopSidebarChrome
                sidebarWidthPx={600}
                headerHeightPx={56}
                onPressHome={vi.fn()}
                onPressCollapse={vi.fn()}
                onPressBack={vi.fn()}
                onPressForward={vi.fn()}
                canNavigateBack={false}
                canNavigateForward={true}
                environmentBadge={null}
                headerActions={[]}
                renderHeaderOverflowVisual={() => <View testID="desktop-sidebar-overflow-visual" />}
                popoverBoundaryRef={{ current: null }}
                desktopWindowControls={<View testID="injected-desktop-window-controls" />}
            />,
        );

        const backButton = requireTestInstance(screen.findByTestId('sidebar-back-button'), 'back button');
        const forwardButton = requireTestInstance(screen.findByTestId('sidebar-forward-button'), 'forward button');

        expect(backButton.props.disabled).toBe(true);
        expect(backButton.props.accessibilityState).toEqual({ disabled: true });
        expect(forwardButton.props.disabled).toBe(false);
        expect(forwardButton.props.accessibilityState).toEqual({ disabled: false });
    });

    it('keeps top utility actions out of the content action row when window controls are active', async () => {
        const { DesktopSidebarChrome } = await import('./DesktopSidebarChrome');
        await renderScreen(
            <DesktopSidebarChrome
                sidebarWidthPx={600}
                headerHeightPx={56}
                onPressHome={vi.fn()}
                environmentBadge={null}
                headerActions={[
                    { id: 'inbox', title: 'Inbox', inlineTestID: 'sidebar-inbox-button', icon: 'envelope', onPress: vi.fn() },
                    { id: 'settings', title: 'Settings', inlineTestID: 'nav-settings', icon: 'gear', onPress: vi.fn() },
                    { id: 'newSession', title: 'New', inlineTestID: 'nav-new-session', icon: 'plus', onPress: vi.fn() },
                ]}
                topUtilityActions={[
                    { id: 'inbox', title: 'Inbox', inlineTestID: 'sidebar-inbox-button', icon: 'envelope', onPress: vi.fn() },
                    { id: 'settings', title: 'Settings', inlineTestID: 'nav-settings', icon: 'gear', onPress: vi.fn() },
                ]}
                renderHeaderOverflowVisual={() => <View testID="desktop-sidebar-overflow-visual" />}
                popoverBoundaryRef={{ current: null }}
                desktopWindowControls={<View testID="injected-desktop-window-controls" />}
            />,
        );

        expect(itemRowActionsState.lastActionIds).toEqual(['newSession']);
    });

    // This strip sits beside the traffic lights, which are 12px. Every glyph in it moved to the app's
    // default 20 during the icon-family migration — a 33-54% jump on controls that had been measured
    // at 13-18 — and at 20 they exactly filled their 20px buttons, so the row had no air in it at all.
    it('draws the whole top strip at one compact chrome size', async () => {
        const { DesktopSidebarChrome } = await import('./DesktopSidebarChrome');
        const { DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_BUTTON_SIZE_PX } = await import('./desktopChromeMetrics');
        const screen = await renderScreen(
            <DesktopSidebarChrome
                sidebarWidthPx={600}
                headerHeightPx={56}
                onPressHome={vi.fn()}
                onPressCollapse={vi.fn()}
                onPressBack={vi.fn()}
                onPressForward={vi.fn()}
                environmentBadge={null}
                headerActions={[]}
                topUtilityActions={[{
                    id: 'settings',
                    title: 'settings.title',
                    inlineTestID: 'nav-settings',
                    icon: 'sliders-horizontal',
                    onPress: vi.fn(),
                }]}
                renderHeaderOverflowVisual={() => <View testID="desktop-sidebar-overflow-visual" />}
                popoverBoundaryRef={{ current: null }}
                desktopWindowControls={<View testID="injected-desktop-window-controls" />}
            />,
        );

        const utilityRow = requireTestInstance(screen.findByTestId('desktop-sidebar-chrome-utility-row'), 'utility row');
        const sizes = utilityRow.findAll((node) => node.type === ('Icon' as never)).map((icon) => icon.props.size);

        expect(sizes.length).toBeGreaterThanOrEqual(4);
        expect(new Set(sizes).size, 'the strip should read as one size').toBe(1);
        expect(sizes[0]).toBeLessThan(DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_BUTTON_SIZE_PX);
    });

    // The expanded chrome is the sidebar's OPEN state, so its button collapses. It reached that
    // drawing through a `scaleX: -1` on a wrapper View, which flipped the resolved glyph into the
    // opposite edge's — the icon seam said one thing and the screen showed another.
    it('shows the collapse glyph unflipped in the expanded chrome', async () => {
        const { DesktopSidebarChrome } = await import('./DesktopSidebarChrome');
        const screen = await renderScreen(
            <DesktopSidebarChrome
                sidebarWidthPx={600}
                headerHeightPx={56}
                onPressHome={vi.fn()}
                onPressCollapse={vi.fn()}
                environmentBadge={null}
                headerActions={[]}
                renderHeaderOverflowVisual={() => <View testID="desktop-sidebar-overflow-visual" />}
                popoverBoundaryRef={{ current: null }}
                desktopWindowControls={<View testID="injected-desktop-window-controls" />}
            />,
        );

        const collapseButton = requireTestInstance(screen.findByTestId('sidebar-collapse-button'), 'collapse button');
        expect(collapseButton.findByType('Icon' as never).props.name).toBe('sidebar-left-close');

        const flipped = collapseButton.findAll((node) => {
            const transform = (node.props?.style as { transform?: Array<Record<string, number>> } | undefined)?.transform;
            return Array.isArray(transform) && transform.some((step) => step.scaleX === -1);
        });
        expect(flipped, 'nothing should mirror the glyph the seam already chose').toHaveLength(0);
    });
});
