import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { isAutoDispatchController } from '@/components/sessions/new/hooks/screenModel/newSessionAutoDispatch';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { useAllMachines } from '@/sync/domains/state/storage';
import { requestSessionSourceChanges, type SessionSourceChangesResult } from '@/sync/ops/sessionSourceChanges';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    bar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.default,
    },
    text: {
        flex: 1,
        minWidth: 0,
        fontSize: 14,
        color: theme.colors.text.secondary,
    },
    appliedText: {
        color: theme.colors.text.primary,
    },
    column: {
        flex: 1,
        minWidth: 0,
        gap: 2,
    },
    note: {
        fontSize: 12,
        color: theme.colors.text.secondary,
    },
}));

type BarState =
    | Readonly<{ kind: 'hidden' }>
    | Readonly<{ kind: 'not_applied' }>
    | Readonly<{ kind: 'applied'; fileCount: number; skippedIgnoredCount: number }>;

function stateFromResult(result: SessionSourceChangesResult, previous: BarState): BarState {
    switch (result.status) {
        case 'not_applied':
        case 'undone':
            return { kind: 'not_applied' };
        case 'applied':
            return { kind: 'applied', fileCount: result.fileCount, skippedIgnoredCount: result.skippedIgnoredCount };
        case 'conflict':
        case 'no_changes':
        case 'unavailable':
            // The project is unchanged by these answers, so the bar keeps offering what it offered.
            return previous;
        default:
            return { kind: 'hidden' };
    }
}

/**
 * The last step of a scheduled task: its changes live in the task's own copy until the person puts
 * them into the project. Shown only for a scheduled task (the controller answers `not_found`
 * otherwise); the controller decides conflicts and ignored files, this bar reports them.
 */
export const SessionSourceChangesBar = React.memo(function SessionSourceChangesBar(props: Readonly<{
    sessionId: string;
    serverId?: string | null;
}>) {
    const machines = useAllMachines();
    const controllerMachineId = React.useMemo(
        () => machines.find((machine) => isAutoDispatchController(machine))?.id ?? null,
        [machines],
    );
    const [state, setState] = React.useState<BarState>({ kind: 'hidden' });
    const [busy, setBusy] = React.useState(false);
    const stateRef = React.useRef(state);
    stateRef.current = state;

    const request = React.useCallback(async (action: 'status' | 'apply' | 'undo') => {
        if (!controllerMachineId) return null;
        return await requestSessionSourceChanges({
            controllerMachineId,
            serverId: props.serverId ?? null,
            sessionId: props.sessionId,
            action,
        });
    }, [controllerMachineId, props.serverId, props.sessionId]);

    React.useEffect(() => {
        let cancelled = false;
        void request('status').then((result) => {
            if (cancelled || !result) return;
            setState(stateFromResult(result, { kind: 'hidden' }));
        });
        return () => {
            cancelled = true;
        };
    }, [request]);

    const run = React.useCallback(async (action: 'apply' | 'undo') => {
        const confirmed = await Modal.confirm(
            t(action === 'apply' ? 'sourceChanges.confirmApplyTitle' : 'sourceChanges.confirmUndoTitle'),
            t(action === 'apply' ? 'sourceChanges.confirmApplyBody' : 'sourceChanges.confirmUndoBody'),
        );
        if (!confirmed) return;
        setBusy(true);
        try {
            const result = await request(action);
            if (!result) return;
            setState(stateFromResult(result, stateRef.current));
            if (result.status === 'conflict') {
                Modal.alert(
                    t('sourceChanges.conflictTitle'),
                    t(action === 'apply' ? 'sourceChanges.conflictApplyBody' : 'sourceChanges.conflictUndoBody', {
                        files: result.files.join('、') || '—',
                    }),
                );
            } else if (result.status === 'no_changes') {
                Modal.alert(t('sourceChanges.noChangesTitle'), t('sourceChanges.noChangesBody'));
            } else if (result.status === 'unavailable') {
                Modal.alert(t('sourceChanges.failedTitle'), t('sourceChanges.failedBody'));
            }
        } finally {
            setBusy(false);
        }
    }, [request]);

    if (state.kind === 'hidden') return null;
    const styles = stylesheet;
    if (state.kind === 'applied') {
        return (
            <View style={styles.bar} testID="session-source-changes-bar">
                <View style={styles.column}>
                    <Text style={[styles.text, styles.appliedText]} numberOfLines={1}>
                        {t('sourceChanges.applied', { count: state.fileCount })}
                    </Text>
                    <Text style={styles.note} numberOfLines={2}>
                        {state.skippedIgnoredCount > 0
                            ? t('sourceChanges.appliedNoteWithSkipped', { skipped: state.skippedIgnoredCount })
                            : t('sourceChanges.appliedNote')}
                    </Text>
                </View>
                <RoundButton
                    size="small"
                    display="inverted"
                    title={t('sourceChanges.undo')}
                    testID="session-source-changes-undo"
                    loading={busy}
                    disabled={busy}
                    onPress={() => run('undo')}
                />
            </View>
        );
    }
    return (
        <View style={styles.bar} testID="session-source-changes-bar">
            <Text style={styles.text} numberOfLines={2}>{t('sourceChanges.notApplied')}</Text>
            <RoundButton
                size="small"
                title={t('sourceChanges.apply')}
                testID="session-source-changes-apply"
                loading={busy}
                disabled={busy}
                onPress={() => run('apply')}
            />
        </View>
    );
});
