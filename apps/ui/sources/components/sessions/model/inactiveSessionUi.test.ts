import { describe, expect, it } from 'vitest';

import { getInactiveSessionUiState } from '@/components/sessions/model/inactiveSessionUi';

describe('getInactiveSessionUiState', () => {
    it('shows input for active sessions', () => {
        expect(getInactiveSessionUiState({
            isSessionActive: true,
            isResumable: false,
            isMachineOnline: false,
        })).toEqual({
            shouldShowInput: true,
            inactiveStatusTextKey: null,
            noticeKind: 'none',
        });
    });

    it('hides input and shows a not-resumable notice when vendor resume is not available', () => {
        expect(getInactiveSessionUiState({
            isSessionActive: false,
            isResumable: false,
            isMachineOnline: true,
        })).toEqual({
            shouldShowInput: false,
            inactiveStatusTextKey: 'session.inactiveNotResumable',
            noticeKind: 'not-resumable',
        });
    });

    it('keeps input visible and shows a machine-offline notice for a resumable session', () => {
        expect(getInactiveSessionUiState({
            isSessionActive: false,
            isResumable: true,
            isMachineOnline: false,
        })).toEqual({
            shouldShowInput: true,
            inactiveStatusTextKey: 'taskStatus.machineOffline',
            noticeKind: 'machine-offline',
        });
    });

    it('shows input for inactive resumable sessions when machine is online', () => {
        expect(getInactiveSessionUiState({
            isSessionActive: false,
            isResumable: true,
            isMachineOnline: true,
        })).toEqual({
            shouldShowInput: true,
            inactiveStatusTextKey: 'taskStatus.paused',
            noticeKind: 'none',
        });
    });

    it('shows input for inactive voice conversation sessions even when normal resume is unavailable', () => {
        expect(getInactiveSessionUiState({
            isSessionActive: false,
            isResumable: false,
            isMachineOnline: false,
            allowInputWhileInactive: true,
        })).toEqual({
            shouldShowInput: true,
            inactiveStatusTextKey: null,
            noticeKind: 'none',
        });
    });

    it('reports this device losing the server instead of stale presence or a machine-offline verdict', () => {
        // Presence still reads online and machine presence may have gone stale: neither is known
        // while this client cannot reach the server, so the link state is what the user sees.
        expect(getInactiveSessionUiState({
            isSessionActive: true,
            isResumable: true,
            isMachineOnline: true,
            serverLink: 'server_unreachable',
        })).toEqual({
            shouldShowInput: true,
            inactiveStatusTextKey: 'session.serverLink.unreachable',
            noticeKind: 'server-link-down',
            serverLink: 'server_unreachable',
        });
        expect(getInactiveSessionUiState({
            isSessionActive: false,
            isResumable: true,
            isMachineOnline: false,
            serverLink: 'server_unreachable',
        })).toMatchObject({
            inactiveStatusTextKey: 'session.serverLink.unreachable',
            noticeKind: 'server-link-down',
        });
    });

    it('shows a transient reconnect as status only, without a notice', () => {
        expect(getInactiveSessionUiState({
            isSessionActive: true,
            isResumable: true,
            isMachineOnline: true,
            serverLink: 'connecting',
        })).toEqual({
            shouldShowInput: true,
            inactiveStatusTextKey: 'session.serverLink.connecting',
            noticeKind: 'none',
            serverLink: 'connecting',
        });
    });
});
