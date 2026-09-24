import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { useSessionScmStatus } from '@/sync/domains/state/storage';

import { resolveSessionRowScmDelta } from './sessionRowScmDelta';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        flexShrink: 0,
    },
    added: {
        fontSize: 11,
        color: theme.colors.diff.success,
    },
    removed: {
        fontSize: 11,
        color: theme.colors.diff.error,
    },
}));

/**
 * Shows the session working-tree delta inline on its list row.
 *
 * Subscribes in the leaf so an SCM push for one session does not re-render the whole list, and
 * renders nothing until that session has reported status — the list never requests SCM per row.
 */
export const SessionRowScmBadge = React.memo(function SessionRowScmBadge(props: Readonly<{
    sessionId: string;
}>) {
    const status = useSessionScmStatus(props.sessionId);
    const delta = resolveSessionRowScmDelta(status);
    if (!delta) return null;

    const styles = stylesheet;
    return (
        <View
            style={styles.container}
            testID={`session-row-scm-badge:${props.sessionId}`}
            accessibilityLabel={`+${delta.added} -${delta.removed}`}
        >
            {delta.added > 0 ? <Text style={styles.added}>{`+${delta.added}`}</Text> : null}
            {delta.removed > 0 ? <Text style={styles.removed}>{`-${delta.removed}`}</Text> : null}
        </View>
    );
});
