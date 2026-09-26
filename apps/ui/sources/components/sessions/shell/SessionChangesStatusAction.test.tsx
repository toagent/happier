import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const scmState = vi.hoisted(() => ({ status: null as unknown }));

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'android' });
});

vi.mock('@/text', async () => {
    const { installTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return installTextModuleMock({ translate: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key) })();
});

vi.mock('react-native-unistyles', async () => {
    const { installUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return installUnistylesMock()();
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { installPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return installPartialStorageModuleMock({ useSessionScmStatus: () => scmState.status })(importOriginal);
});

afterEach(() => {
    standardCleanup();
    scmState.status = null;
});

const dirty = {
    branch: 'review',
    isDirty: true,
    modifiedCount: 1,
    untrackedCount: 0,
    includedCount: 0,
    lastUpdatedAt: 1,
    includedLinesAdded: 0,
    includedLinesRemoved: 0,
    pendingLinesAdded: 12,
    pendingLinesRemoved: 4,
    linesAdded: 12,
    linesRemoved: 4,
    linesChanged: 16,
};

describe('SessionChangesStatusAction', () => {
    it('puts the task changes one tap away from the composer and opens them', async () => {
        scmState.status = dirty;
        const onOpenChanges = vi.fn();
        const { SessionChangesStatusAction } = await import('./SessionChangesStatusAction');
        const screen = await renderScreen(<SessionChangesStatusAction sessionId="s1" onOpenChanges={onOpenChanges} />);

        const action = screen.findByTestId('session-changes-status-action');
        expect(action).toBeTruthy();
        expect(JSON.stringify(screen.tree.toJSON())).toContain('+12');
        expect(JSON.stringify(screen.tree.toJSON())).toContain('-4');
        action?.props.onPress?.();
        expect(onOpenChanges).toHaveBeenCalledTimes(1);
    });

    it('stays out of the way while the task has not changed anything', async () => {
        scmState.status = { ...dirty, isDirty: false, linesAdded: 0, linesRemoved: 0 };
        const { SessionChangesStatusAction } = await import('./SessionChangesStatusAction');
        const screen = await renderScreen(<SessionChangesStatusAction sessionId="s1" onOpenChanges={vi.fn()} />);

        expect(screen.findByTestId('session-changes-status-action')).toBeFalsy();
    });
});
