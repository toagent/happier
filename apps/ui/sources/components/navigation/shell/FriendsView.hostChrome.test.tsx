import React from 'react';
import type renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installNavigationShellCommonModuleMocks } from './navigationShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const viewportState = vi.hoisted(() => ({ width: 1280, height: 900 }));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

installNavigationShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'ios' },
            View: 'View',
            Text: 'Text',
            Pressable: 'Pressable',
            ScrollView: 'ScrollView',
            ActivityIndicator: 'ActivityIndicator',
            useWindowDimensions: () => ({ width: viewportState.width, height: viewportState.height }),
        });
    },
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            useAcceptedFriends: () => [],
            useAllSessions: () => [],
            useFeedItems: () => [],
            useFeedLoaded: () => true,
            useFriendRequests: () => [],
            useFriendsLoaded: () => true,
            useRequestedFriends: () => [],
        });
    },
});

vi.mock('@/sync/domains/state/storageStore', () => ({
    storage: (selector: (state: unknown) => unknown) => selector({ profile: { id: 'me' } }),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useIsTablet: () => true,
}));

vi.mock('@/hooks/server/useFriendsIdentityReadiness', () => ({
    useFriendsIdentityReadiness: () => ({ isReady: false }),
}));

vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => () => {},
}));

vi.mock('@/components/navigation/Header', () => ({
    Header: 'Header',
}));

vi.mock('@/components/friends/RequireFriendsIdentityForFriends', () => ({
    RequireFriendsIdentityForFriends: 'RequireFriendsIdentityForFriends',
}));

vi.mock('@/track', () => ({
    trackFriendsProfileView: () => {},
    trackFriendsSearch: () => {},
}));

/**
 * `FriendsView` draws its own tablet header only when the shell seated a docked sidebar
 * beside it. In the narrow layout the shell already owns the header, so a second one here
 * is a duplicate chrome bar stacked on top of the first.
 */
describe('FriendsView host chrome', () => {
    beforeEach(() => {
        viewportState.width = 1280;
        viewportState.height = 900;
    });

    it('draws its own tablet header when the shell docked the sidebar', async () => {
        const { FriendsView } = await import('./FriendsView');

        const tree: renderer.ReactTestRenderer = (await renderScreen(<FriendsView />)).tree;

        expect(tree.root.findAllByType('Header' as never)).toHaveLength(1);
    });

    it('leaves the header to the shell when the viewport is too narrow to dock the sidebar', async () => {
        // Tablet-classed by min edge (>= 600) yet below the native dock width (320 + 420),
        // so the shell falls back to the narrow layout and draws the header itself.
        viewportState.width = 700;
        viewportState.height = 1000;
        const { FriendsView } = await import('./FriendsView');

        const tree: renderer.ReactTestRenderer = (await renderScreen(<FriendsView />)).tree;

        expect(tree.root.findAllByType('Header' as never)).toHaveLength(0);
    });
});
