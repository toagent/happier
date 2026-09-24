import React from 'react';
import { Platform, Pressable, type ViewStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';
import type { SessionFolderViewModeV1 } from './sessionFolderShellTypes';
import { SESSION_LIST_NATIVE_TOUCH_TARGET_SIZE } from './sessionListRowHeights';
import type { SessionListFolderSortModeV1 } from '@/sync/domains/session/listing/sessionListFolderSortMode';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import {
    SESSION_LIST_ORDERING_MODES_V1,
    resolveEffectiveSessionListFolderSortMode,
    type SessionListOrderingModeV1,
} from '@/sync/domains/session/listing/sessionListOrderingRules';

const FOLDER_SORT_MODE_ACTION_PREFIX = 'session-folder-sort-mode:';

const isNativeTouch = Platform.OS !== 'web';
// On touch the trigger owns a real finger-sized box; hitSlop would overlap the neighbouring search.
const NATIVE_TOUCH_TRIGGER_STYLE: ViewStyle = {
    width: SESSION_LIST_NATIVE_TOUCH_TARGET_SIZE,
    height: SESSION_LIST_NATIVE_TOUCH_TARGET_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
};

function resolveFolderSortModeAction(itemId: string): SessionListFolderSortModeV1 | null {
    if (!itemId.startsWith(FOLDER_SORT_MODE_ACTION_PREFIX)) return null;
    const rawMode = itemId.slice(FOLDER_SORT_MODE_ACTION_PREFIX.length);
    return rawMode === 'mixed' || rawMode === 'foldersFirst' ? rawMode : null;
}

function resolveOrderingModeAction(itemId: string): SessionListOrderingModeV1 | null {
    return itemId === 'custom' || itemId === 'created' || itemId === 'updated' ? itemId : null;
}

function getOrderingModeTitle(mode: SessionListOrderingModeV1): string {
    if (mode === 'created') return t('sessionsList.orderingMode.created');
    if (mode === 'updated') return t('sessionsList.orderingMode.updated');
    return t('sessionsList.orderingMode.custom');
}

export function SessionListViewMenuButton(props: Readonly<{
    folderViewMode: SessionFolderViewModeV1;
    onFolderViewModeChange: (mode: SessionFolderViewModeV1) => void;
    orderingMode: SessionListOrderingModeV1;
    onOrderingModeChange: (mode: SessionListOrderingModeV1) => void;
    folderSortMode: SessionListFolderSortModeV1;
    onFolderSortModeChange: (mode: SessionListFolderSortModeV1) => void;
    hideInactiveSessions: boolean;
    onHideInactiveSessionsChange: (next: boolean) => void;
    disabled?: boolean;
}>) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const iconColor = props.disabled ? theme.colors.text.tertiary : theme.colors.text.secondary;
    const selectedIconColor = theme.colors.accent.blue;
    const effectiveFolderSortMode = resolveEffectiveSessionListFolderSortMode({
        orderingMode: props.orderingMode,
        folderSortMode: props.folderSortMode,
    });
    const folderSortLockedByOrdering = props.orderingMode !== 'custom';

    const items = React.useMemo((): DropdownMenuItem[] => [
        ...SESSION_LIST_ORDERING_MODES_V1.map((mode): DropdownMenuItem => ({
            id: mode,
            testID: `session-list-ordering-mode-${mode}`,
            category: t('sessionsList.orderingMode.title'),
            title: getOrderingModeTitle(mode),
            icon: (
                <Icon
                    name={mode === 'custom' ? 'list' : mode === 'created' ? 'calendar' : 'clock'}
                    size={ICON_SIZE.sm}
                    color={iconColor}
                />
            ),
            rightElement: props.orderingMode === mode
                ? <Icon name="check" size={ICON_SIZE.sm} color={selectedIconColor} />
                : null,
        })),
        {
            id: props.folderViewMode === 'tree' ? 'folder-view-off' : 'folder-view-tree',
            testID: 'session-folder-view-toggle',
            category: t('sessionsList.folderVisibility'),
            title: props.folderViewMode === 'tree'
                ? t('sessionsList.folderViewOff')
                : t('sessionsList.folderViewTree'),
            icon: <Icon name="folder" size={ICON_SIZE.sm} color={iconColor} />,
            disabled: props.disabled,
        },
        {
            id: `${FOLDER_SORT_MODE_ACTION_PREFIX}foldersFirst`,
            testID: 'session-folder-sort-mode-folders-first',
            category: t('sessionsList.folderSortMode'),
            title: t('sessionsList.folderSortFoldersFirst'),
            subtitle: t('sessionsList.folderSortFoldersFirstDescription'),
            icon: <Icon name="folder" size={ICON_SIZE.sm} color={iconColor} />,
            disabled: props.disabled,
            rightElement: effectiveFolderSortMode === 'foldersFirst'
                ? <Icon name="check" size={ICON_SIZE.sm} color={selectedIconColor} />
                : null,
        },
        {
            id: `${FOLDER_SORT_MODE_ACTION_PREFIX}mixed`,
            testID: 'session-folder-sort-mode-mixed',
            category: t('sessionsList.folderSortMode'),
            title: t('sessionsList.folderSortMixed'),
            subtitle: folderSortLockedByOrdering
                ? t('sessionsList.folderSortMixedDisabledInDateMode')
                : t('sessionsList.folderSortMixedDescription'),
            icon: <Icon name="arrows-down-up" size={ICON_SIZE.sm} color={iconColor} />,
            disabled: props.disabled || folderSortLockedByOrdering,
            rightElement: effectiveFolderSortMode === 'mixed'
                ? <Icon name="check" size={ICON_SIZE.sm} color={selectedIconColor} />
                : null,
        },
        {
            id: props.hideInactiveSessions ? 'show-inactive' : 'hide-inactive',
            category: t('sessionsList.filters'),
            title: props.hideInactiveSessions
                ? t('sessionsList.showInactiveSessions')
                : t('sessionsList.hideInactiveSessions'),
            icon: <Icon name="funnel-simple" size={ICON_SIZE.sm} color={iconColor} />,
        },
    ], [
        effectiveFolderSortMode,
        folderSortLockedByOrdering,
        iconColor,
        props.disabled,
        props.folderViewMode,
        props.hideInactiveSessions,
        props.orderingMode,
        selectedIconColor,
    ]);

    const handleSelect = React.useCallback((itemId: string) => {
        const orderingMode = resolveOrderingModeAction(itemId);
        if (orderingMode) {
            props.onOrderingModeChange(orderingMode);
            return;
        }
        const folderSortMode = resolveFolderSortModeAction(itemId);
        if (folderSortMode) {
            if (props.orderingMode !== 'custom') return;
            props.onFolderSortModeChange(folderSortMode);
            return;
        }
        if (itemId === 'folder-view-tree') {
            props.onFolderViewModeChange('tree');
            return;
        }
        if (itemId === 'folder-view-off') {
            props.onFolderViewModeChange('off');
            return;
        }
        if (itemId === 'hide-inactive') {
            props.onHideInactiveSessionsChange(true);
            return;
        }
        if (itemId === 'show-inactive') {
            props.onHideInactiveSessionsChange(false);
        }
    }, [props]);

    return (
        <DropdownMenu
            open={open}
            onOpenChange={setOpen}
            items={items}
            onSelect={handleSelect}
            selectedId={props.folderViewMode === 'tree' ? 'folder-view-tree' : 'folder-view-off'}
            placement="left"
            variant="slim"
            matchTriggerWidth={false}
            maxWidthCap={260}
            showCategoryTitles={true}
            popoverPortalWebTarget="body"
            trigger={({ toggle }) => (
                <Pressable
                    testID="session-list-ordering-menu-trigger"
                    accessibilityRole="button"
                    accessibilityLabel={t('sessionsList.viewOptions')}
                    onPress={(event) => {
                        event?.stopPropagation?.();
                        toggle();
                    }}
                    hitSlop={isNativeTouch ? undefined : 8}
                    style={isNativeTouch ? NATIVE_TOUCH_TRIGGER_STYLE : undefined}
                >
                    <Icon name="funnel-simple" size={ICON_SIZE.sm} color={iconColor} />
                </Pressable>
            )}
        />
    );
}
