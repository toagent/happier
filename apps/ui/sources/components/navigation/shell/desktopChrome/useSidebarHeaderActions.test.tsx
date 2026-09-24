import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';
import { installNavigationShellCommonModuleMocks } from '../navigationShellTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.hoisted(() => vi.fn());
const shellFeatureState = vi.hoisted(() => ({
    friendsEnabled: false,
    inboxAvailable: false,
    inboxHasContent: false,
}));

installNavigationShellCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { push: routerPushSpy },
        }).module;
    },
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            useFriendRequests: () => [],
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/hooks/inbox/useInboxHasContent', () => ({
    useInboxHasContent: () => shellFeatureState.inboxHasContent,
}));

vi.mock('@/hooks/inbox/useInboxAvailable', () => ({
    useInboxAvailable: () => shellFeatureState.inboxAvailable,
}));

vi.mock('@/hooks/server/useFriendsEnabled', () => ({
    useFriendsEnabled: () => shellFeatureState.friendsEnabled,
}));

describe('useSidebarHeaderActions', () => {
    it('exposes only implemented sidebar header actions when social and inbox actions are unavailable', async () => {
        const { useSidebarHeaderActions } = await import('./useSidebarHeaderActions');

        const hook = await renderHook(() => useSidebarHeaderActions());

        expect(hook.getCurrent().headerActions.map((action) => action.id)).toEqual([
            'settings',
        ]);
    });

    it('leaves starting a session to the labelled sidebar button instead of a second header icon', async () => {
        // The sidebar body already ends with the labelled "start new session" button
        // (covered by MainView.sidebarActions.test.tsx), so a bare `+` here would be a
        // second, unlabelled entry point for the same action.
        const { useSidebarHeaderActions } = await import('./useSidebarHeaderActions');
        const hook = await renderHook(() => useSidebarHeaderActions());

        const current = hook.getCurrent();
        expect(current.headerActions.some((action) => action.id === 'newSession')).toBe(false);
        expect(current.topUtilityActions.some((action) => action.id === 'newSession')).toBe(false);
        expect(routerPushSpy).not.toHaveBeenCalled();
    });
});
