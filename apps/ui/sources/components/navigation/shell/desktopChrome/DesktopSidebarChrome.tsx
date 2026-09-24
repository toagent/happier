import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { ConnectionStatusControl } from '@/components/navigation/ConnectionStatusControl';
import { useDesktopWindowDragMouseProps } from '@/components/navigation/desktopWindowChrome/DesktopWindowDragRegion';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import {
    DESKTOP_SIDEBAR_CHROME_ACTIONS_COMPACT_THRESHOLD_PX,
    DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX,
    DESKTOP_SIDEBAR_CHROME_NATIVE_TOUCH_TARGET_SIZE_PX,
    DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_BUTTON_SIZE_PX,
} from './desktopChromeMetrics';
import { desktopSidebarChromeStyles } from './desktopSidebarChromeStyles';
import { DesktopShellWindowControlsHost } from './DesktopShellWindowControlsHost';
import { SidebarCollapseIcon } from '../SidebarIcons';
import { SidebarLogoButton } from '../SidebarLogoButton';
import type { AppUpdateStatusTagProps } from '@/components/ui/feedback/AppUpdateStatusTag';
import { Icon } from '@/components/ui/icons/Icon';
import { ActionOperationActivityButton, ActionOperationActivityButtonView } from '@/components/inbox/actionOperations/ActionOperationActivityButton';
import { InboxPopoverButton } from '@/components/inbox/InboxPopoverButton';
import type { InboxContentModel } from '@/components/inbox/useInboxContentModel';

type DesktopSidebarChromeProps = Readonly<{
    sidebarWidthPx?: number | null;
    headerHeightPx: number;
    onPressHome: () => void;
    onPressCollapse?: () => void;
    onPressBack?: () => void;
    onPressForward?: () => void;
    canNavigateBack?: boolean;
    canNavigateForward?: boolean;
    environmentBadge: string | null;
    headerActions: ItemAction[];
    topUtilityActions?: ItemAction[];
    renderHeaderOverflowVisual: () => React.ReactNode;
    popoverBoundaryRef: React.RefObject<any>;
    desktopWindowControls?: React.ReactNode;
    desktopUpdateIndicator?: React.ReactNode;
    inboxModel?: InboxContentModel | null;
    inboxEnabled?: boolean;
}>;

const SidebarActionOperationButton = React.memo(function SidebarActionOperationButton(props: Readonly<{
    model: InboxContentModel;
    buttonSize: number;
    iconSize: number;
}>) {
    const operationModel = props.model.actionOperationModel;
    return (
        <ActionOperationActivityButtonView
            operations={operationModel.operations}
            activeCount={operationModel.activeCount}
            hasAttention={operationModel.hasAttention}
            observationForOperation={operationModel.observationForOperation}
            contextForOperation={operationModel.contextForOperation}
            onOpenOperation={props.model.openOperation}
            onMarkVisibleTerminalSeen={operationModel.markVisibleTerminalSeen}
            onClearRecent={operationModel.clearRecent}
            canDismissOperation={operationModel.canDismissOperation}
            onDismissOperation={operationModel.dismissOperation}
            testID="desktop-sidebar-action-operations"
            buttonSize={props.buttonSize}
            iconSize={props.iconSize}
        />
    );
});

function renderUpdateIndicatorWithFallback(
    indicator: React.ReactNode,
    fallback: React.ReactNode,
    props: Pick<AppUpdateStatusTagProps, 'fallback' | 'labelVariant'>,
): React.ReactNode {
    if (!indicator) {
        return fallback;
    }

    if (!React.isValidElement<AppUpdateStatusTagProps>(indicator)) {
        return indicator;
    }

    return React.cloneElement(indicator, props);
}

export const DesktopSidebarChrome = React.memo((props: DesktopSidebarChromeProps) => {
    const styles = desktopSidebarChromeStyles;
    const { theme } = useUnistyles();
    const hasDesktopWindowControls = props.desktopWindowControls != null;
    const isNativeTouchSidebar = Platform.OS !== 'web' && !hasDesktopWindowControls;
    const contentActionButtonSize = isNativeTouchSidebar
        ? DESKTOP_SIDEBAR_CHROME_NATIVE_TOUCH_TARGET_SIZE_PX
        : 32;
    const topStripDragProps = useDesktopWindowDragMouseProps();
    const canNavigateBack = props.canNavigateBack ?? true;
    const canNavigateForward = props.canNavigateForward ?? true;
    const topUtilityActions = props.topUtilityActions ?? [];
    const topUtilityActionIds = React.useMemo(
        () => new Set(topUtilityActions.map((action) => action.id)),
        [topUtilityActions],
    );
    const contentHeaderActions = React.useMemo(() => {
        if (hasDesktopWindowControls) {
            return props.headerActions.filter((action) => !topUtilityActionIds.has(action.id));
        }

        return props.headerActions;
    }, [hasDesktopWindowControls, props.headerActions, topUtilityActionIds]);
    const compactContentActionIds = React.useMemo(() => {
        return hasDesktopWindowControls
            ? ['projects', 'newSession']
            : ['projects', 'settings', 'newSession'];
    }, [hasDesktopWindowControls]);
    const titleFallback = (
        <Text testID="desktop-sidebar-title-text" style={styles.titleText} numberOfLines={1}>
            {t('sidebar.sessionsTitle')}
        </Text>
    );

    const renderTopUtilityAction = React.useCallback((action: ItemAction) => {
        const color = action.color ?? theme.colors.chrome.header.foreground;
        const isSettingsAction = action.id === 'settings';
        const icon = typeof action.icon === 'string'
            ? action.id === 'inbox'
                ? <Icon name="mailbox" size={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX} color={color} />
                : <Icon name={action.icon} size={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX} color={color} />
            : action.icon;

        return (
            <Pressable
                key={action.id}
                testID={action.inlineTestID}
                onPress={action.onPress}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={action.title}
                style={isSettingsAction ? styles.topSettingsIconButton : styles.topIconButton}
            >
                {icon}
            </Pressable>
        );
    }, [styles.topIconButton, styles.topSettingsIconButton, theme.colors.chrome.header.foreground]);

    // On native the server switcher lives at the leading edge of the action row: under the title it
    // could only be a 16px line, while this row is already a full touch target tall with free space.
    const statusControl = (
        <ConnectionStatusControl
            variant="sidebar"
            alignSelf="stretch"
            minTouchHeight={isNativeTouchSidebar ? DESKTOP_SIDEBAR_CHROME_NATIVE_TOUCH_TARGET_SIZE_PX : undefined}
        />
    );
    const actionsRow = (
        <View
            testID="desktop-sidebar-chrome-actions-row"
            style={[styles.rightContainer, isNativeTouchSidebar ? styles.nativeTouchActionsRow : null]}
        >
            {isNativeTouchSidebar ? (
                <View style={styles.nativeTouchStatusSlot}>
                    {statusControl}
                </View>
            ) : null}
            <ItemRowActions
                title={t('common.moreActions')}
                actions={contentHeaderActions}
                layoutWidthPx={props.sidebarWidthPx ?? null}
                compactThreshold={DESKTOP_SIDEBAR_CHROME_ACTIONS_COMPACT_THRESHOLD_PX}
                compactActionIds={compactContentActionIds}
                pinnedActionIds={compactContentActionIds}
                buttonSize={isNativeTouchSidebar ? contentActionButtonSize : undefined}
                leadingPinnedContent={props.inboxModel ? (
                    <View style={styles.inlineUtilityRow}>
                        {props.inboxEnabled ? (
                            <InboxPopoverButton
                                model={props.inboxModel}
                                testID="sidebar-inbox-button"
                                buttonSize={contentActionButtonSize}
                                iconSize={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX}
                            />
                        ) : null}
                        <SidebarActionOperationButton
                            model={props.inboxModel}
                            buttonSize={contentActionButtonSize}
                            iconSize={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX}
                        />
                    </View>
                ) : (
                    <ActionOperationActivityButton
                        testID="desktop-sidebar-action-operations"
                        buttonSize={contentActionButtonSize}
                        iconSize={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX}
                    />
                )}
                overflowPosition="beforePinned"
                overflowTriggerTestID="sidebar-header-actions-overflow"
                popoverBoundaryRef={props.popoverBoundaryRef}
                gap={4}
                renderOverflowTrigger={({ open, toggle, testID, accessibilityLabel, accessibilityHint }) => (
                    <Pressable
                        testID={testID}
                        hitSlop={isNativeTouchSidebar ? undefined : 15}
                        style={[
                            isNativeTouchSidebar ? styles.nativeTouchIconButton : null,
                            open ? { opacity: 0 } : null,
                        ]}
                        pointerEvents={open ? 'none' : 'auto'}
                        onPress={open ? undefined : toggle}
                        focusable={!open}
                        accessibilityRole="button"
                        accessibilityLabel={accessibilityLabel}
                        accessibilityHint={accessibilityHint}
                        accessibilityState={{ expanded: open, disabled: open }}
                        accessibilityElementsHidden={open}
                        importantForAccessibility={open ? 'no-hide-descendants' : 'auto'}
                    >
                        {props.renderHeaderOverflowVisual()}
                    </Pressable>
                )}
            />
        </View>
    );

    return (
        <View testID="desktop-sidebar-chrome" style={styles.header}>
            {hasDesktopWindowControls ? (
                <View
                    {...topStripDragProps}
                    testID="desktop-sidebar-chrome-controls-row"
                    style={styles.windowControlsRow}
                >
                    <DesktopShellWindowControlsHost>
                        {props.desktopWindowControls}
                    </DesktopShellWindowControlsHost>
                    <View testID="desktop-sidebar-chrome-utility-row" style={styles.utilityRow}>
                        {props.onPressBack ? (
                            <Pressable
                                testID="sidebar-back-button"
                                onPress={props.onPressBack}
                                disabled={!canNavigateBack}
                                hitSlop={10}
                                accessibilityRole="button"
                                accessibilityLabel={t('common.previous')}
                                accessibilityState={{ disabled: !canNavigateBack }}
                                style={[styles.topIconButton, !canNavigateBack ? styles.topIconButtonDisabled : null]}
                            >
                                <Icon
                                    name="arrow-left"
                                    size={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX}
                                    color={theme.colors.chrome.header.foreground}
                                />
                            </Pressable>
                        ) : null}
                        {props.onPressForward ? (
                            <Pressable
                                testID="sidebar-forward-button"
                                onPress={props.onPressForward}
                                disabled={!canNavigateForward}
                                hitSlop={10}
                                accessibilityRole="button"
                                accessibilityLabel={t('common.next')}
                                accessibilityState={{ disabled: !canNavigateForward }}
                                style={[styles.topIconButton, !canNavigateForward ? styles.topIconButtonDisabled : null]}
                            >
                                <Icon
                                    name="arrow-right"
                                    size={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX}
                                    color={theme.colors.chrome.header.foreground}
                                />
                            </Pressable>
                        ) : null}
                        {props.inboxModel ? (
                            <>
                                {props.inboxEnabled ? (
                                    <InboxPopoverButton
                                        model={props.inboxModel}
                                        testID="sidebar-inbox-button"
                                        buttonSize={DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_BUTTON_SIZE_PX}
                                        iconSize={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX}
                                    />
                                ) : null}
                                <SidebarActionOperationButton
                                    model={props.inboxModel}
                                    buttonSize={DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_BUTTON_SIZE_PX}
                                    iconSize={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX}
                                />
                            </>
                        ) : (
                            <ActionOperationActivityButton
                                testID="desktop-sidebar-action-operations"
                                buttonSize={DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_BUTTON_SIZE_PX}
                                iconSize={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX}
                            />
                        )}
                        {topUtilityActions.map(renderTopUtilityAction)}
                        {props.onPressCollapse ? (
                            <Pressable
                                testID="sidebar-collapse-button"
                                onPress={props.onPressCollapse}
                                hitSlop={10}
                                accessibilityRole="button"
                                accessibilityLabel={t('common.collapse')}
                                style={styles.topIconButton}
                            >
                                <SidebarCollapseIcon
                                    size={DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX}
                                    color={theme.colors.chrome.header.foreground}
                                />
                            </Pressable>
                        ) : null}
                    </View>
                </View>
            ) : null}

            <View
                testID="desktop-sidebar-chrome-content-row"
                style={[
                    styles.contentRow,
                    isNativeTouchSidebar ? styles.nativeTouchContentRow : null,
                    hasDesktopWindowControls ? styles.compactContentRow : { minHeight: props.headerHeightPx },
                ]}
            >
                <View
                    testID="desktop-sidebar-chrome-brand-group"
                    style={[styles.brandGroup, isNativeTouchSidebar ? styles.nativeTouchBrandGroup : null]}
                >
                    <SidebarLogoButton
                        testID="desktop-sidebar-brand-button"
                        onPress={props.onPressHome}
                        style={[styles.brandButton, isNativeTouchSidebar ? styles.nativeTouchBrandButton : null]}
                    />
                    <View testID="desktop-sidebar-title-container" style={styles.titleContainerLeft}>
                        <View style={styles.titleRow}>
                            {renderUpdateIndicatorWithFallback(
                                props.desktopUpdateIndicator,
                                titleFallback,
                                {
                                    fallback: titleFallback,
                                    labelVariant: 'full',
                                },
                            )}
                            {props.environmentBadge ? (
                                <View style={styles.envBadge}>
                                    <Text style={styles.envBadgeText}>{props.environmentBadge}</Text>
                                </View>
                            ) : null}
                        </View>
                        {isNativeTouchSidebar ? null : (
                            <View style={styles.statusControlWrapper}>
                                {statusControl}
                            </View>
                        )}
                    </View>
                </View>

                {actionsRow}
            </View>
        </View>
    );
});
