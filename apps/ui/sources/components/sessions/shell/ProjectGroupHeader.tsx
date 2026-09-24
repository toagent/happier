import React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Image } from 'expo-image';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { SessionListViewItem } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { useWorkspaceFavicon } from './useWorkspaceFavicon';
import { SESSION_LIST_NATIVE_TOUCH_TARGET_SIZE } from './sessionListRowHeights';
import { Icon } from '@/components/ui/icons/Icon';

const WORKSPACE_FAVICON_SIZE = 16;
const WORKSPACE_FAVICON_RADIUS = 4;
const workspaceFaviconImageStyle = {
    width: WORKSPACE_FAVICON_SIZE,
    height: WORKSPACE_FAVICON_SIZE,
    borderRadius: WORKSPACE_FAVICON_RADIUS,
};

const stylesheet = StyleSheet.create((theme) => ({
    section: {
        backgroundColor: theme.colors.background.canvas,
        paddingHorizontal: 24,
        paddingTop: 10,
        paddingBottom: 5,
    },
    // Native rows are tapped, not clicked: the controls below own real touch boxes, so the section
    // trades its vertical padding for them and pulls in on the right so the glyphs stay aligned.
    sectionNativeTouch: {
        paddingTop: 2,
        paddingBottom: 0,
        paddingRight: 12,
    },
    row: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        justifyContent: 'space-between' as const,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: 'transparent',
    },
    titleRow: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: 6,
        flex: 1,
        minWidth: 0,
    },
    title: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.text.secondary,
        flexShrink: 1,
        ...Typography.default('semiBold'),
    },
    pathTitleWeb: {
        writingDirection: 'rtl' as const,
        textAlign: 'left' as const,
    },
    pathTitleTextWeb: {
        writingDirection: 'ltr' as const,
        unicodeBidi: 'isolate' as const,
    },
    subtitle: {
        fontSize: 11,
        color: theme.colors.text.secondary,
        marginTop: 2,
        ...Typography.default(),
    },
    faviconFrame: {
        width: WORKSPACE_FAVICON_SIZE,
        minWidth: WORKSPACE_FAVICON_SIZE,
        maxWidth: WORKSPACE_FAVICON_SIZE,
        height: WORKSPACE_FAVICON_SIZE,
        minHeight: WORKSPACE_FAVICON_SIZE,
        maxHeight: WORKSPACE_FAVICON_SIZE,
        flexShrink: 0,
        borderRadius: WORKSPACE_FAVICON_RADIUS,
        backgroundColor: theme.colors.surface.base,
        overflow: 'hidden' as const,
    },
    content: {
        flex: 1,
        minWidth: 0,
    },
    contentNativeTouch: {
        minHeight: SESSION_LIST_NATIVE_TOUCH_TARGET_SIZE,
        justifyContent: 'center' as const,
    },
    inlineActions: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: 2,
        flexShrink: 0,
    },
    trailingActions: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        flexShrink: 0,
        marginLeft: 8,
    },
    actionButton: {
        width: 18,
        height: 14,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        borderRadius: 999,
        marginLeft: 4,
    },
    actionButtonNativeTouch: {
        width: SESSION_LIST_NATIVE_TOUCH_TARGET_SIZE,
        height: SESSION_LIST_NATIVE_TOUCH_TARGET_SIZE,
        marginLeft: 0,
    },
    chevron: {
        width: 16,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        color: theme.colors.text.secondary,
    },
    hoverHiddenChevron: {
        opacity: 0,
    },
    hoverVisibleChevron: {
        opacity: 1,
    },
    dragHandle: {
        opacity: 0.72,
    },
    dragHandleActive: {
        opacity: 1,
    },
}));

export const ProjectGroupHeader = React.memo(function ProjectGroupHeader(props: Readonly<{
    item: Extract<SessionListViewItem, { type: 'header' }>;
    hasMultipleMachines: boolean;
    workspaceLabelsV1: Record<string, string>;
    workspaceFaviconsEnabled?: boolean;
    workspaceMachineSubtitlesEnabled?: boolean;
    onRenameWorkspace: (workspaceKey: string, currentLabel: string) => void;
    onResetWorkspaceName: (workspaceKey: string) => void;
    onCreateSession: () => void;
    onAddFolder: () => void | Promise<void>;
    collapsed: boolean;
    onToggleCollapse: () => void;
    headerTestId: string;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const {
        item,
        hasMultipleMachines,
        workspaceLabelsV1,
        workspaceFaviconsEnabled = false,
        workspaceMachineSubtitlesEnabled = true,
        onRenameWorkspace,
        onResetWorkspaceName,
        onCreateSession,
        onAddFolder,
        collapsed,
        onToggleCollapse,
        headerTestId,
    } = props;
    const [isRowHovered, setIsRowHovered] = React.useState(false);
    const [isActionsHovered, setIsActionsHovered] = React.useState(false);
    const [menuOpen, setMenuOpen] = React.useState(false);
    const isWeb = Platform.OS === 'web';
    const showHoverActions = !isWeb || isRowHovered || isActionsHovered || menuOpen;
    const showChevron = !isWeb || collapsed || showHoverActions;
    const actionButtonStyle = isWeb ? styles.actionButton : [styles.actionButton, styles.actionButtonNativeTouch];
    const actionHitSlop = isWeb ? 8 : undefined;
    const workspaceKey = item.workspaceKey ?? '';
    const reorderHandleKey = item.groupKey ?? workspaceKey;
    const customLabel = workspaceKey ? workspaceLabelsV1[workspaceKey] : undefined;
    const displayTitle = customLabel || item.title;
    const hasCustomLabel = Boolean(customLabel);
    const shouldUseStartEllipsis = !hasCustomLabel && isWeb;
    const nativeEllipsizeMode = !isWeb && !hasCustomLabel ? 'head' : 'tail';
    const actionIconColor = theme.colors.text.secondary;
    const canCreateSession = typeof onCreateSession === 'function' && Boolean(item.workspaceScopeHint);
    const favicon = useWorkspaceFavicon({
        enabled: workspaceFaviconsEnabled,
        serverId: item.workspaceScopeHint?.serverId ?? item.serverId ?? null,
        machineId: item.workspaceScopeHint?.machineId ?? null,
        workspacePath: item.workspaceScopeHint?.rootPath ?? null,
    });

    const menuItems = React.useMemo((): DropdownMenuItem[] => {
        const items: DropdownMenuItem[] = [
            {
                id: 'add-folder',
                title: t('sessionsList.addFolder'),
                icon: <Icon name="folder-open" size={16} color={actionIconColor} />,
                disabled: !canCreateSession,
            },
            {
                id: 'rename',
                title: t('sessionsList.renameWorkspace'),
                icon: <Icon name="pencil" size={16} color={actionIconColor} />,
            },
        ];
        if (hasCustomLabel) {
            items.push({
                id: 'reset',
                title: t('sessionsList.resetWorkspaceName'),
                icon: <Icon name="arrow-clockwise" size={16} color={actionIconColor} />,
            });
        }
        return items;
    }, [hasCustomLabel, actionIconColor, canCreateSession]);

    const handleMenuSelect = React.useCallback(async (itemId: string) => {
        if (itemId === 'add-folder') {
            await onAddFolder();
        } else if (itemId === 'rename') {
            onRenameWorkspace(workspaceKey, displayTitle);
        } else if (itemId === 'reset') {
            onResetWorkspaceName(workspaceKey);
        }
    }, [workspaceKey, displayTitle, onAddFolder, onRenameWorkspace, onResetWorkspaceName]);

    const chevronColor = theme.colors.text.secondary;
    return (
        <View style={isWeb ? styles.section : [styles.section, styles.sectionNativeTouch]}>
            <View
                style={styles.row}
                onPointerEnter={isWeb ? () => setIsRowHovered(true) : undefined}
                onPointerLeave={isWeb ? () => setIsRowHovered(false) : undefined}
            >
                <Pressable
                    style={isWeb ? styles.content : [styles.content, styles.contentNativeTouch]}
                    onPress={onToggleCollapse}
                    testID={headerTestId}
                    accessibilityRole="button"
                    accessibilityLabel={displayTitle}
                    onHoverIn={isWeb ? () => setIsRowHovered(true) : undefined}
                    onHoverOut={isWeb ? () => setIsRowHovered(false) : undefined}
                >
                    <View style={styles.titleRow}>
                        {favicon ? (
                            <View testID="session-list-workspace-favicon" style={styles.faviconFrame}>
                                <Image
                                    source={{ uri: favicon.uri }}
                                    style={[workspaceFaviconImageStyle]}
                                    contentFit="cover"
                                    accessibilityIgnoresInvertColors
                                />
                            </View>
                        ) : null}
                        <Text
                            style={shouldUseStartEllipsis
                                ? [styles.title, styles.pathTitleWeb]
                                : styles.title}
                            numberOfLines={1}
                            ellipsizeMode={shouldUseStartEllipsis ? undefined : nativeEllipsizeMode}
                        >
                            {shouldUseStartEllipsis ? (
                                <Text style={styles.pathTitleTextWeb}>
                                    {displayTitle}
                                </Text>
                            ) : displayTitle}
                        </Text>
                        <View
                            style={styles.inlineActions}
                            onPointerEnter={isWeb ? () => setIsActionsHovered(true) : undefined}
                            onPointerLeave={isWeb ? () => setIsActionsHovered(false) : undefined}
                        >
                            <View
                                style={[
                                    styles.chevron,
                                    isWeb && !showChevron ? styles.hoverHiddenChevron : styles.hoverVisibleChevron,
                                ]}
                            >
                                <Icon
                                    name={collapsed ? 'caret-right' : 'caret-down'}
                                    size={14}
                                    color={chevronColor}
                                />
                            </View>
                        </View>
                    </View>
                    {workspaceMachineSubtitlesEnabled && hasMultipleMachines && item.subtitle ? (
                        <Text style={styles.subtitle}>{item.subtitle}</Text>
                    ) : null}
                </Pressable>
                <View style={styles.trailingActions}>
                    {/* Native reordering starts from a long press on the whole header, so this handle is pointer-only. */}
                    {isWeb && showHoverActions && reorderHandleKey ? (
                        <Pressable
                            style={styles.actionButton}
                            testID={`session-workspace-reorder-handle:${reorderHandleKey}`}
                            onPress={(event) => {
                                (event as any)?.stopPropagation?.();
                            }}
                            onHoverIn={isWeb ? () => setIsActionsHovered(true) : undefined}
                            onHoverOut={isWeb ? () => setIsActionsHovered(false) : undefined}
                            accessible={false}
                            hitSlop={8}
                        >
                            <Icon
                                name="list"
                                size={14}
                                color={actionIconColor}
                                style={[styles.dragHandle, showHoverActions ? styles.dragHandleActive : null]}
                            />
                        </Pressable>
                    ) : null}
                    {showHoverActions && workspaceKey ? (
                        <DropdownMenu
                            open={menuOpen}
                            onOpenChange={setMenuOpen}
                            items={menuItems}
                            onSelect={handleMenuSelect}
                            placement="left"
                            variant="slim"
                            matchTriggerWidth={false}
                            maxWidthCap={220}
                            showCategoryTitles={false}
                            popoverPortalWebTarget="body"
                            trigger={({ toggle }) => (
                                <Pressable
                                    style={actionButtonStyle}
                                    onPress={(event) => {
                                        (event as any)?.stopPropagation?.();
                                        toggle();
                                    }}
                                    onHoverIn={isWeb ? () => setIsActionsHovered(true) : undefined}
                                    onHoverOut={isWeb ? () => setIsActionsHovered(false) : undefined}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('common.moreActions')}
                                    hitSlop={actionHitSlop}
                                >
                                    <Icon name="dots-three" size={14} color={actionIconColor} />
                                </Pressable>
                            )}
                        />
                    ) : null}
                    {canCreateSession ? (
                        <Pressable
                            style={actionButtonStyle}
                            onPress={(event) => {
                                (event as any)?.stopPropagation?.();
                                onCreateSession();
                            }}
                            accessibilityRole="button"
                            accessibilityLabel={t('machine.launchNewSessionInDirectory')}
                            hitSlop={actionHitSlop}
                        >
                            <Icon name="plus" size={14} color={actionIconColor} />
                        </Pressable>
                    ) : null}
                </View>
            </View>
        </View>
    );
});
