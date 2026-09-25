import { describe, expect, it } from 'vitest';

import { resolveConnectionHealth, resolveServerLinkHealth } from './resolveConnectionHealth';

describe('resolveConnectionHealth', () => {
    it('treats endpoint offline as server_unreachable even if the socket is connected', () => {
        const result = resolveConnectionHealth({
            endpointStatus: 'offline',
            socketStatus: 'connected',
            machineGroups: [{ machineCount: 2, onlineCount: 2, status: 'idle' }],
        });

        expect(result.kind).toBe('server_unreachable');
    });

    it('treats endpoint connecting as connecting even when the socket is disconnected', () => {
        const result = resolveConnectionHealth({
            endpointStatus: 'connecting',
            socketStatus: 'disconnected',
            machineGroups: [{ machineCount: 0, onlineCount: 0, status: 'idle' }],
        });

        expect(result.kind).toBe('connecting');
    });

    it('returns no_machine when the server is connected and there are no machines', () => {
        const result = resolveConnectionHealth({
            socketStatus: 'connected',
            machineGroups: [{ machineCount: 0, onlineCount: 0, status: 'idle' }],
        });

        expect(result.kind).toBe('no_machine');
    });

    it('returns machine_offline when machines exist but none are online', () => {
        const result = resolveConnectionHealth({
            socketStatus: 'connected',
            machineGroups: [{ machineCount: 2, onlineCount: 0, status: 'idle' }],
        });

        expect(result.kind).toBe('machine_offline');
    });

    it('returns healthy when at least one machine is online', () => {
        const result = resolveConnectionHealth({
            socketStatus: 'connected',
            machineGroups: [{ machineCount: 2, onlineCount: 1, status: 'idle' }],
        });

        expect(result.kind).toBe('healthy');
    });

    it('returns machine_not_ready when machines are online but not ready', () => {
        const result = resolveConnectionHealth({
            socketStatus: 'connected',
            machineGroups: [{ machineCount: 2, onlineCount: 2, readyCount: 1, status: 'idle' }],
        });

        expect(result.kind).toBe('machine_not_ready');
    });

    it('returns server_unreachable when the socket is disconnected even if machines exist', () => {
        const result = resolveConnectionHealth({
            socketStatus: 'disconnected',
            machineGroups: [{ machineCount: 2, onlineCount: 2, status: 'idle' }],
        });

        expect(result.kind).toBe('server_unreachable');
    });

    it('treats planned server restarts as a neutral reconnect while preserving known machines', () => {
        const result = resolveConnectionHealth({
            endpointStatus: 'offline',
            endpointReason: 'server_restarting',
            socketStatus: 'disconnected',
            machineGroups: [{ machineCount: 2, onlineCount: 2, status: 'idle' }],
        });

        expect(result.kind).toBe('server_restarting');
        expect(result.machineCount).toBe(2);
        expect(result.onlineCount).toBe(2);
        expect(result.hasUnknownMachines).toBe(false);
    });

    it('returns auth_required for terminal auth sync errors before generic server errors', () => {
        const result = resolveConnectionHealth({
            socketStatus: 'error',
            syncErrorKind: 'auth',
            hasSyncError: true,
            machineGroups: [{ machineCount: 2, onlineCount: 2, status: 'idle' }],
        });

        expect(result.kind).toBe('auth_required');
    });

    it('returns auth_required when account settings has an auth sync issue alongside a generic sync error', () => {
        const result = resolveConnectionHealth({
            socketStatus: 'connected',
            syncErrorKind: 'network',
            hasSyncError: true,
            accountSettingsSyncKind: 'auth',
            hasAccountSettingsSyncIssue: true,
            machineGroups: [{ machineCount: 2, onlineCount: 2, status: 'idle' }],
        });

        expect(result.kind).toBe('auth_required');
    });

    it('returns server_error when account settings sync is retrying even if the socket is connected', () => {
        const result = resolveConnectionHealth({
            socketStatus: 'connected',
            hasAccountSettingsSyncIssue: true,
            accountSettingsSyncKind: 'network',
            machineGroups: [{ machineCount: 0, onlineCount: 0, status: 'idle' }],
        });

        expect(result.kind).toBe('server_error');
    });

    it('aggregates machine groups for multi-server selections', () => {
        const result = resolveConnectionHealth({
            socketStatus: 'connected',
            machineGroups: [
                { machineCount: 0, onlineCount: 0, status: 'idle' },
                { machineCount: 1, onlineCount: 1, status: 'idle' },
            ],
        });

        expect(result.kind).toBe('healthy');
        expect(result.machineCount).toBe(1);
        expect(result.onlineCount).toBe(1);
    });
});

describe('resolveServerLinkHealth', () => {
    it('reads a supervisor that has not started yet as connecting, not as a lost server', () => {
        // App launch: nothing has failed, so no "not connected" notice may flash before the first attempt.
        expect(resolveServerLinkHealth({ socketStatus: 'disconnected', endpointStatus: 'idle' })).toBe('connecting');
        expect(resolveServerLinkHealth({ socketStatus: 'disconnected', endpointStatus: 'offline' })).toBe('server_unreachable');
        expect(resolveServerLinkHealth({ socketStatus: 'connected', endpointStatus: 'online' })).toBeNull();
    });
});
