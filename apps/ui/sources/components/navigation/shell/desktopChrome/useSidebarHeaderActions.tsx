import { useRouter } from 'expo-router';
import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { useFriendsEnabled } from '@/hooks/server/useFriendsEnabled';
import { t } from '@/text';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { useFriendRequests } from '@/sync/domains/state/storage';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { desktopSidebarChromeStyles } from './desktopSidebarChromeStyles';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';

type SidebarHeaderActionsResult = Readonly<{
    headerActions: ItemAction[];
    topUtilityActions: ItemAction[];
    renderHeaderOverflowVisual: () => React.ReactNode;
}>;

export function useSidebarHeaderActions(): SidebarHeaderActionsResult {
    const styles = desktopSidebarChromeStyles;
    const { theme } = useUnistyles();
    const router = useRouter();
    const friendRequests = useFriendRequests();
    const friendsEnabled = useFriendsEnabled();
    const friendRequestCount = friendRequests.length;

    const navigate = React.useCallback((pathname: string, tag: string) => {
        const result = runGuardedNavigation(() => router.push(pathname));
        if (result !== true) {
            fireAndForget(result, { tag });
        }
    }, [router]);

    const headerActions = React.useMemo((): ItemAction[] => {
        const out: ItemAction[] = [];

        if (friendsEnabled) {
            out.push({
                id: 'friends',
                title: t('tabs.friends'),
                icon: (
                    <View style={[styles.iconButton, styles.notificationButton]}>
                        <Icon name="users" size={ICON_SIZE.md} color={theme.colors.chrome.header.foreground} />
                        {friendRequestCount > 0 ? (
                            <View style={styles.badge}>
                                <Text style={styles.badgeText}>
                                    {friendRequestCount > 99 ? '99+' : friendRequestCount}
                                </Text>
                            </View>
                        ) : null}
                    </View>
                ),
                onPress: () => navigate('/(app)/friends', 'SidebarView.nav.friends'),
            });
        }

        out.push({
            id: 'settings',
            title: t('settings.title'),
            inlineTestID: 'nav-settings',
            icon: (
                <View style={styles.iconButton}>
                    <Icon name="sliders-horizontal" size={ICON_SIZE.md} color={theme.colors.chrome.header.foreground} />
                </View>
            ),
            onPress: () => navigate('/settings', 'SidebarView.nav.settings'),
        });

        // Deliberately no `newSession` action here: the sidebar body already ends with the labelled
        // "start new session" button, and an unlabelled `+` beside it read as a second, different
        // action. One entry point, and it is the one that says what it does.

        return out;
    }, [
        friendRequestCount,
        friendsEnabled,
        navigate,
        styles.badge,
        styles.badgeText,
        styles.iconButton,
        styles.indicatorDot,
        styles.notificationButton,
        theme.colors.chrome.header.foreground,
    ]);

    const topUtilityActions = React.useMemo((): ItemAction[] => {
        const out: ItemAction[] = [];

        out.push({
            id: 'settings',
            title: t('settings.title'),
            inlineTestID: 'nav-settings',
            icon: 'sliders-horizontal' as const,
            onPress: () => navigate('/settings', 'SidebarView.nav.settings'),
        });

        return out;
    }, [
        navigate,
        styles.badge,
        styles.badgeText,
        styles.topIndicatorDot,
        styles.topNotificationButton,
        theme.colors.chrome.header.foreground,
    ]);

    const renderHeaderOverflowVisual = React.useCallback(() => {
        const shouldShowBadge = friendRequestCount > 0;

        return (
            <View style={[styles.iconButton, styles.notificationButton]}>
                <Icon name="dots-three" size={ICON_SIZE.md} color={theme.colors.chrome.header.foreground} />
                {shouldShowBadge ? (
                    <View style={styles.badge}>
                        <Text style={styles.badgeText}>
                            {friendRequestCount > 99 ? '99+' : friendRequestCount}
                        </Text>
                    </View>
                ) : null}
            </View>
        );
    }, [
        friendRequestCount,
        styles.badge,
        styles.badgeText,
        styles.iconButton,
        styles.indicatorDot,
        styles.notificationButton,
        theme.colors.chrome.header.foreground,
    ]);

    return {
        headerActions,
        topUtilityActions,
        renderHeaderOverflowVisual,
    };
}
