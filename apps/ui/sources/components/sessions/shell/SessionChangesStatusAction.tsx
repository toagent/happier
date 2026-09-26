import * as React from 'react';
import { Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { useSessionScmStatus } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { resolveSessionRowScmDelta } from './row/sessionRowScmDelta';

// The composer status row is compact; the slop brings the target to the 48dp touch minimum.
const HIT_SLOP = { top: 12, bottom: 12, left: 8, right: 8 } as const;

const stylesheet = StyleSheet.create((theme) => ({
    action: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 6,
        borderRadius: 8,
    },
    pressed: {
        opacity: 0.6,
    },
    added: {
        fontSize: 12,
        color: theme.colors.diff.success,
    },
    removed: {
        fontSize: 12,
        color: theme.colors.diff.error,
    },
}));

/**
 * What this task changed, one tap from the composer: the same working-tree delta the task list
 * shows, opening the session's source-control changes. Subscribes in the leaf so an SCM push does
 * not re-render the composer, and renders nothing until the task has changed something.
 */
export const SessionChangesStatusAction = React.memo(function SessionChangesStatusAction(props: Readonly<{
    sessionId: string;
    onOpenChanges: () => void;
}>) {
    const { theme } = useUnistyles();
    const delta = resolveSessionRowScmDelta(useSessionScmStatus(props.sessionId));
    if (!delta) return null;

    const styles = stylesheet;
    return (
        <Pressable
            testID="session-changes-status-action"
            accessibilityRole="button"
            accessibilityLabel={t('session.changesStatusAction', { added: delta.added, removed: delta.removed })}
            hitSlop={HIT_SLOP}
            onPress={props.onOpenChanges}
            style={({ pressed }) => [styles.action, pressed ? styles.pressed : null]}
        >
            <Icon name="git-branch" size={14} color={theme.colors.text.secondary} />
            {delta.added > 0 ? <Text style={styles.added}>{`+${delta.added}`}</Text> : null}
            {delta.removed > 0 ? <Text style={styles.removed}>{`-${delta.removed}`}</Text> : null}
        </Pressable>
    );
});
