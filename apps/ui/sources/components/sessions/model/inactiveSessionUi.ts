import type { ServerLinkHealthKind } from '@/components/navigation/connectionStatus/connectionHealthTypes';

export type InactiveSessionNoticeKind = 'none' | 'not-resumable' | 'machine-offline' | 'server-link-down';

type ServerLinkStatusTextKey =
    | 'session.serverLink.connecting'
    | 'session.serverLink.restarting'
    | 'session.serverLink.unreachable'
    | 'session.serverLink.authRequired'
    | 'session.serverLink.error';

export type InactiveSessionUiState = Readonly<{
    shouldShowInput: boolean;
    inactiveStatusTextKey:
        | 'session.inactiveResumable'
        | 'session.inactiveMachineOffline'
        | 'session.inactiveNotResumable'
        | ServerLinkStatusTextKey
        | null;
    noticeKind: InactiveSessionNoticeKind;
    /** Present only while this client cannot reach the session's server. */
    serverLink?: ServerLinkHealthKind;
}>;

const SERVER_LINK_STATUS_TEXT_KEY: Readonly<Record<ServerLinkHealthKind, ServerLinkStatusTextKey>> = {
    connecting: 'session.serverLink.connecting',
    server_restarting: 'session.serverLink.restarting',
    server_unreachable: 'session.serverLink.unreachable',
    auth_required: 'session.serverLink.authRequired',
    server_error: 'session.serverLink.error',
};

export function getInactiveSessionUiState(opts: {
    isSessionActive: boolean;
    isResumable: boolean;
    isMachineOnline: boolean;
    allowInputWhileInactive?: boolean;
    /** This client's link to the session's server; null/undefined when it is connected. */
    serverLink?: ServerLinkHealthKind | null;
}): InactiveSessionUiState {
    const sessionState = resolveSessionState(opts);
    // While this client cannot reach the server, session and machine presence are only the last
    // values it heard, so the link state is reported instead of a stale "online" or a wrong
    // "machine offline". A reconnect in progress is status only; a lasting problem gets a notice.
    if (!opts.serverLink) return sessionState;
    return {
        shouldShowInput: sessionState.shouldShowInput,
        inactiveStatusTextKey: SERVER_LINK_STATUS_TEXT_KEY[opts.serverLink],
        noticeKind: opts.serverLink === 'connecting' || opts.serverLink === 'server_restarting'
            ? 'none'
            : 'server-link-down',
        serverLink: opts.serverLink,
    };
}

function resolveSessionState(opts: {
    isSessionActive: boolean;
    isResumable: boolean;
    isMachineOnline: boolean;
    allowInputWhileInactive?: boolean;
}): InactiveSessionUiState {
    if (opts.isSessionActive) {
        return { shouldShowInput: true, inactiveStatusTextKey: null, noticeKind: 'none' };
    }

    if (opts.allowInputWhileInactive) {
        return { shouldShowInput: true, inactiveStatusTextKey: null, noticeKind: 'none' };
    }

    if (!opts.isResumable) {
        return {
            shouldShowInput: false,
            inactiveStatusTextKey: 'session.inactiveNotResumable',
            noticeKind: 'not-resumable',
        };
    }

    if (!opts.isMachineOnline) {
        return {
            shouldShowInput: true,
            inactiveStatusTextKey: 'session.inactiveMachineOffline',
            noticeKind: 'machine-offline',
        };
    }

    return {
        shouldShowInput: true,
        inactiveStatusTextKey: 'session.inactiveResumable',
        noticeKind: 'none',
    };
}
