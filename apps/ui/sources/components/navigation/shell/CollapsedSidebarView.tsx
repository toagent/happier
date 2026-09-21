import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { useHeaderHeight } from '@/utils/platform/responsive';
import { t } from '@/text';
import { SidebarExpandIcon } from './SidebarIcons';
import { SidebarLogoButton } from './SidebarLogoButton';
import {
    DESKTOP_SIDEBAR_CHROME_COLLAPSED_HORIZONTAL_PADDING_PX,
    DESKTOP_SIDEBAR_CHROME_COLLAPSED_VERTICAL_GAP_PX,
    DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX,
    DESKTOP_SIDEBAR_CHROME_NATIVE_TOUCH_TARGET_SIZE_PX,
} from './desktopChrome/desktopChromeMetrics';
import { DesktopShellWindowControlsHost } from './desktopChrome/DesktopShellWindowControlsHost';
import { useResolvedDesktopWindowControls } from './desktopChrome/useResolvedDesktopWindowControls';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { AppUpdateStatusTagProps } from '@/components/ui/feedback/AppUpdateStatusTag';
import { ActionOperationActivityButton } from '@/components/inbox/actionOperations/ActionOperationActivityButton';
import { InboxPopoverButton } from '@/components/inbox/InboxPopoverButton';
import type { InboxContentModel } from '@/components/inbox/useInboxContentModel';

export type CollapsedSidebarViewProps = Readonly<{
    desktopWindowControls?: React.ReactNode;
    desktopUpdateIndicator?: React.ReactNode;
    focusModeActive?: boolean;
    onExitFocusMode?: () => void;
    onRequestExpand?: () => void;
    inboxModel?: InboxContentModel | null;
    inboxEnabled?: boolean;
}>;

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background.canvas,
        borderRightWidth: StyleSheet.hairlineWidth,
        borderRightColor: theme.colors.border.default,
        paddingHorizontal: DESKTOP_SIDEBAR_CHROME_COLLAPSED_HORIZONTAL_PADDING_PX,
        gap: DESKTOP_SIDEBAR_CHROME_COLLAPSED_VERTICAL_GAP_PX,
    },
    chrome: {
        alignItems: 'center',
        gap: DESKTOP_SIDEBAR_CHROME_COLLAPSED_VERTICAL_GAP_PX,
        paddingTop: DESKTOP_SIDEBAR_CHROME_COLLAPSED_VERTICAL_GAP_PX,
    },
    controlsHost: {
        minWidth: 0,
        alignSelf: 'stretch',
        alignItems: 'center',
    },
    controlsSlot: {
        minWidth: 0,
        alignSelf: 'stretch',
    },
    controlsContent: {
        justifyContent: 'center',
    },
    updateIndicatorHost: {
        alignSelf: 'stretch',
    },
    button: {
        alignItems: 'center',
        justifyContent: 'center',
        width: 40,
        height: 32,
    },
    logoButton: {
        alignItems: 'center',
        justifyContent: 'center',
        width: 40,
        height: 32,
    },
    nativeTouchButton: {
        width: DESKTOP_SIDEBAR_CHROME_NATIVE_TOUCH_TARGET_SIZE_PX,
        height: DESKTOP_SIDEBAR_CHROME_NATIVE_TOUCH_TARGET_SIZE_PX,
    },
}));

function renderUpdateIndicatorWithFallback(
    indicator: React.ReactNode,
    fallback: React.ReactNode,
): React.ReactNode {
    if (!indicator) {
        return fallback;
    }

    if (!React.isValidElement<AppUpdateStatusTagProps>(indicator)) {
        return indicator;
    }

    return React.cloneElement(indicator, {
        fallback,
        labelVariant: 'short',
    });
}

export const CollapsedSidebarView = React.memo((props: CollapsedSidebarViewProps) => {
    const { focusModeActive = false, onExitFocusMode, onRequestExpand } = props;
    const [, setSidebarCollapsed] = useLocalSettingMutable('sidebarCollapsed');
    const router = useRouter();
    const safeArea = useChromeSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const { theme } = useUnistyles();
    const resolvedDesktopWindowControls = useResolvedDesktopWindowControls({
        variant: 'collapsed',
        desktopWindowControls: props.desktopWindowControls,
        hasDesktopWindowControlsOverride: Object.prototype.hasOwnProperty.call(props, 'desktopWindowControls'),
    });

    const handleExpand = React.useCallback(() => {
        if (onRequestExpand) {
            onRequestExpand();
            return;
        }
        setSidebarCollapsed(false);
    }, [onRequestExpand, setSidebarCollapsed]);

    const handleHome = React.useCallback(() => {
        if (focusModeActive) {
            onExitFocusMode?.();
        }
        const result = runGuardedNavigation(() => router.push('/'));
        if (result !== true) {
            fireAndForget(result, { tag: 'CollapsedSidebarView.nav.home' });
        }
    }, [focusModeActive, onExitFocusMode, router]);

    // The expanded chrome already trades hitSlop for real 48-point boxes on touch builds; the rail
    // draws the same controls, so it has to make the same trade rather than keep a second answer.
    const isNativeTouchRail = Platform.OS !== 'web' && props.desktopWindowControls == null;
    const railControlSize = isNativeTouchRail
        ? DESKTOP_SIDEBAR_CHROME_NATIVE_TOUCH_TARGET_SIZE_PX
        : 32;

    const logoButton = (
        <SidebarLogoButton
            testID="collapsed-sidebar-home-button"
            onPress={handleHome}
            style={[styles.logoButton, isNativeTouchRail ? styles.nativeTouchButton : null]}
        />
    );

    return (
        <View style={[styles.container, { paddingTop: safeArea.top }]}>
            <View testID="desktop-collapsed-shell-chrome" style={[styles.chrome, { minHeight: headerHeight }]}>
                <DesktopShellWindowControlsHost
                    style={styles.controlsHost}
                    slotStyle={styles.controlsSlot}
                    contentStyle={styles.controlsContent}
                >
                    {resolvedDesktopWindowControls}
                </DesktopShellWindowControlsHost>
                {renderUpdateIndicatorWithFallback(props.desktopUpdateIndicator, logoButton)}
                {props.inboxEnabled && props.inboxModel ? (
                    <InboxPopoverButton
                        model={props.inboxModel}
                        buttonSize={railControlSize}
                        iconSize={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX}
                        testID="collapsed-sidebar-inbox-button"
                    />
                ) : null}
                <ActionOperationActivityButton
                    testID="collapsed-sidebar-action-operations"
                    buttonSize={railControlSize}
                    iconSize={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX}
                />
                {/* The rail IS the collapsed state, so this button expands. It used to take the
                    collapse glyph and the component's default size, which made it both the wrong
                    icon and a different size from the same control in the expanded chrome. It was
                    also web-only, while the collapse control that produces this rail is not — so a
                    tablet user could fold the sidebar away and never get it back. */}
                <Pressable
                    testID="sidebar-expand-button"
                    onPress={handleExpand}
                    style={[styles.button, isNativeTouchRail ? styles.nativeTouchButton : null]}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.expand')}
                >
                    <SidebarExpandIcon
                        size={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX}
                        color={theme.colors.chrome.header.foreground}
                    />
                </Pressable>
            </View>
        </View>
    );
});
