import { Platform } from 'react-native';

import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import type { SessionStorageKind } from '@/sync/domains/session/sessionStorageKind';

/**
 * Whether the list-top Happier/Direct switch is drawn. On native touch surfaces the list gives that
 * row back to tasks and the same choice lives in Session settings; the stored choice stays the one
 * owner of which sessions the list shows either way.
 */
export function resolveSessionListStorageTabsVisible(input: Readonly<{
    directSessionsEnabled: boolean;
    platform: string;
}>): boolean {
    return input.directSessionsEnabled && input.platform !== 'ios' && input.platform !== 'android';
}

export function useSessionListStorageKind(): Readonly<{
    directSessionsEnabled: boolean;
    showStorageTabs: boolean;
    storageKind: SessionStorageKind;
    setStorageKind: (storageKind: SessionStorageKind) => void;
}> {
    const directSessionsDecision = useFeatureDecision('sessions.direct');
    const directSessionsEnabled = directSessionsDecision?.state === 'enabled';
    const [sessionsListStorageTab, setSessionsListStorageTab] = useLocalSettingMutable('sessionsListStorageTab');

    return {
        directSessionsEnabled,
        showStorageTabs: resolveSessionListStorageTabsVisible({ directSessionsEnabled, platform: Platform.OS }),
        storageKind: directSessionsEnabled && sessionsListStorageTab === 'direct' ? 'direct' : 'persisted',
        setStorageKind: setSessionsListStorageTab,
    };
}
