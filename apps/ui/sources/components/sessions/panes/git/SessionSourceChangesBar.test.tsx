import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const state = vi.hoisted(() => ({
    rpcResults: [] as unknown[],
    rpcCalls: [] as Array<{ machineId: string; method: string; payload: unknown }>,
    confirmResult: true,
    alerts: [] as Array<[string, string | undefined]>,
}));

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'android' });
});

vi.mock('@/text', async () => {
    const { installTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return installTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
    })();
});

vi.mock('react-native-unistyles', async () => {
    const { installUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return installUnistylesMock()();
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            confirm: async () => state.confirmResult,
            alert: (title: string, message?: string) => { state.alerts.push([title, message]); },
        },
    }).module;
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { installPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return installPartialStorageModuleMock({
        useAllMachines: () => [
            { id: 'worker', active: true, activeAt: Date.now(), metadata: {} },
            {
                id: 'controller',
                active: true,
                activeAt: Date.now(),
                metadata: { twinSessionSchedulingV1: { v: 1 }, twinSessionAutoDispatchV1: true },
            },
        ],
    })(importOriginal);
});

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcModuleMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcModuleMock({
        importOriginal: async () => await vi.importActual('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc'),
        overrides: {
            machineRpcWithServerScope: (async (params: { machineId: string; method: string; payload: unknown }) => {
                state.rpcCalls.push({ machineId: params.machineId, method: params.method, payload: params.payload });
                return state.rpcResults.shift();
            }) as never,
        },
    });
});

beforeEach(() => {
    state.rpcResults = [];
    state.rpcCalls = [];
    state.confirmResult = true;
    state.alerts = [];
});

afterEach(() => {
    standardCleanup();
});

async function renderBar() {
    const { SessionSourceChangesBar } = await import('./SessionSourceChangesBar');
    const screen = await renderScreen(<SessionSourceChangesBar sessionId="s1" />);
    await act(async () => { await Promise.resolve(); });
    return screen;
}

describe('SessionSourceChangesBar', () => {
    it('stays out of the way for a session that is not a scheduled task', async () => {
        state.rpcResults = [{ status: 'not_found' }];
        const screen = await renderBar();
        expect(state.rpcCalls[0]).toMatchObject({ machineId: 'controller', payload: { sessionId: 's1', action: 'status' } });
        expect(screen.findByTestId('session-source-changes-apply')).toBeFalsy();
        expect(screen.findByTestId('session-source-changes-undo')).toBeFalsy();
    });

    it('puts the task changes into the project after a confirmation, then offers to undo', async () => {
        state.rpcResults = [
            { status: 'not_applied' },
            { status: 'applied', appliedAt: 1, fileCount: 3, skippedIgnoredCount: 0 },
            { status: 'undone' },
        ];
        const screen = await renderBar();

        await act(async () => { await screen.findByTestId('session-source-changes-apply')?.props.onPress(); });
        expect(state.rpcCalls[1]).toMatchObject({ machineId: 'controller', payload: { sessionId: 's1', action: 'apply' } });
        expect(screen.findByTestId('session-source-changes-undo')).toBeTruthy();
        expect(JSON.stringify(screen.tree.toJSON())).toContain('sourceChanges.applied:{\\"count\\":3}');

        await act(async () => { await screen.findByTestId('session-source-changes-undo')?.props.onPress(); });
        expect(state.rpcCalls[2]).toMatchObject({ payload: { action: 'undo' } });
        expect(screen.findByTestId('session-source-changes-apply')).toBeTruthy();
    });

    it('does nothing when the person cancels the confirmation', async () => {
        state.rpcResults = [{ status: 'not_applied' }];
        state.confirmResult = false;
        const screen = await renderBar();
        await act(async () => { await screen.findByTestId('session-source-changes-apply')?.props.onPress(); });
        expect(state.rpcCalls).toHaveLength(1);
    });

    it('names the files that changed in the project and keeps the apply action when there is a conflict', async () => {
        state.rpcResults = [{ status: 'not_applied' }, { status: 'conflict', files: ['a.txt', 'b.txt'] }];
        const screen = await renderBar();
        await act(async () => { await screen.findByTestId('session-source-changes-apply')?.props.onPress(); });

        expect(state.alerts).toHaveLength(1);
        expect(state.alerts[0]?.[1]).toContain('a.txt');
        expect(screen.findByTestId('session-source-changes-apply')).toBeTruthy();
    });
});
