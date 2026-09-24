import React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Eyebrow } from '@/components/ui/text/Eyebrow';
import type { SessionListViewItem } from '@/sync/domains/state/storage';
import { isSessionListPrimaryHeaderKind } from './sessionListPrimaryHeader';
import { Icon } from '@/components/ui/icons/Icon';
import { SESSION_LIST_NATIVE_TOUCH_TARGET_SIZE } from './sessionListRowHeights';

const stylesheet = StyleSheet.create((theme) => ({
    headerSection: {
        backgroundColor: theme.colors.background.canvas,
        paddingHorizontal: 24,
        paddingTop: 14,
    },
    headerText: {
        fontSize: 13,
        color: theme.colors.text.secondary,
    },
    groupHeaderSection: {
        backgroundColor: theme.colors.background.canvas,
        paddingHorizontal: 24,
        paddingTop: 10,
        paddingBottom: 5,
    },
    // On touch the row itself is the finger-sized target, so the padding that used to pad a 28px
    // pointer row is folded into it instead of stacking on top (which also left 44px controls sitting
    // in a needlessly tall primary header).
    headerSectionNativeTouch: {
        paddingTop: 4,
    },
    groupHeaderSectionNativeTouch: {
        paddingTop: 0,
        paddingBottom: 0,
    },
    headerRowNativeTouch: {
        minHeight: SESSION_LIST_NATIVE_TOUCH_TARGET_SIZE,
    },
    groupHeaderTitle: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.text.secondary,
        flexShrink: 1,
    },
    headerRow: {
        minHeight: 28,
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        justifyContent: 'space-between' as const,
        gap: 8,
    },
    headerLabelRow: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        minWidth: 0,
        flexShrink: 1,
    },
    headerChevron: {
        marginLeft: 6,
        width: 14,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
    },
    webHoverHiddenChevron: {
        opacity: 0,
    },
    webHoverVisibleChevron: {
        opacity: 1,
    },
    groupHeaderTrailingActions: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: 4,
        flexShrink: 0,
    },
}));

export const CollapsibleSectionHeader = React.memo(function CollapsibleSectionHeader(props: Readonly<{
    title: string;
    headerKind?: Extract<SessionListViewItem, { type: 'header' }>['headerKind'];
    collapsed: boolean;
    onPress: () => void;
    headerTestId: string;
    rightElement?: React.ReactNode;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const isWeb = Platform.OS === 'web';
    const [isHovered, setIsHovered] = React.useState(false);
    const headerChevronColor = theme.colors.text.secondary;
    const isPrimaryHeader = isSessionListPrimaryHeaderKind(props.headerKind);
    const showChevron = !isWeb || props.collapsed || isHovered;
    return (
        <Pressable
            style={isPrimaryHeader
                ? (isWeb ? styles.headerSection : [styles.headerSection, styles.headerSectionNativeTouch])
                : (isWeb ? styles.groupHeaderSection : [styles.groupHeaderSection, styles.groupHeaderSectionNativeTouch])}
            onPress={props.onPress}
            testID={props.headerTestId}
            onHoverIn={isWeb ? () => setIsHovered(true) : undefined}
            onHoverOut={isWeb ? () => setIsHovered(false) : undefined}
        >
            <View style={isWeb ? styles.headerRow : [styles.headerRow, styles.headerRowNativeTouch]}>
                <View style={styles.headerLabelRow}>
                    <Eyebrow style={isPrimaryHeader ? styles.headerText : styles.groupHeaderTitle}>{props.title}</Eyebrow>
                    <View
                        style={[
                            styles.headerChevron,
                            isWeb && !showChevron ? styles.webHoverHiddenChevron : styles.webHoverVisibleChevron,
                        ]}
                    >
                        <Icon
                            name={props.collapsed ? 'caret-right' : 'caret-down'}
                            size={14}
                            color={headerChevronColor}
                        />
                    </View>
                </View>
                {props.rightElement ? (
                    <View style={styles.groupHeaderTrailingActions}>
                        {props.rightElement}
                    </View>
                ) : null}
            </View>
        </Pressable>
    );
});
