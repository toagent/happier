import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(async () => {
    vi.useRealTimers();
    try {
        const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        await resetServerReachabilitySupervisors();
    } catch {
        // ignore
    }
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_WRITE_TIMEOUT_MS;
});

describe('apiSessionDrafts write timeout', () => {
    it('gives up on a draft write the server never answers, so the draft can settle as offline and retry', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_WRITE_TIMEOUT_MS = '50';

        vi.doMock('@/sync/domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => ({
                serverId: 'server-a',
                serverUrl: 'https://api.example.test',
                kind: 'custom',
                generation: 1,
            }),
        }));
        vi.doMock('@/auth/storage/tokenStorage', () => ({
            TokenStorage: {
                getCredentials: vi.fn(async () => ({ token: 'token-a', secret: 'secret-a' })),
                invalidateCredentialsTokenForServerUrl: vi.fn(async () => false),
            },
        }));
        // Network boundary: health checks answer, the draft write is accepted but never answered
        // (a half-open connection after the app was suspended mid-request).
        vi.doMock('@/utils/system/runtimeFetch', () => ({
            runtimeFetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = typeof input === 'string' ? input : String(input);
                if (!url.endsWith('/v1/account/session-drafts/mutate')) {
                    return new Response('ok', { status: 200, headers: new Headers() });
                }
                return await new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => {
                        const error = new Error('Aborted');
                        error.name = 'AbortError';
                        reject(error);
                    }, { once: true });
                });
            }),
            resetRuntimeFetch: () => {},
            setRuntimeFetch: () => {},
        }));

        const { createApiSessionDraftsTransport } = await import('./apiSessionDrafts');
        const transport = createApiSessionDraftsTransport({ credentials: { token: 'token-a', secret: 'secret-a' } });
        const write = transport.mutate({
            address: { kind: 'session', sessionId: 'session-a' },
            expectedRevision: 'absent',
            content: null,
        });
        const assertion = expect(write).rejects.toMatchObject({ name: 'ServerFetchWriteTimeoutError', retryable: true });

        await vi.advanceTimersByTimeAsync(60);
        await assertion;
    });
});
