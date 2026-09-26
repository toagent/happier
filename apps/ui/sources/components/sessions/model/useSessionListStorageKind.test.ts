import { describe, expect, it } from 'vitest';

import { resolveSessionListStorageTabsVisible } from './useSessionListStorageKind';

describe('resolveSessionListStorageTabsVisible', () => {
    it('keeps the list-top storage switch off native touch surfaces, where it moves to settings', () => {
        expect(resolveSessionListStorageTabsVisible({ directSessionsEnabled: true, platform: 'android' })).toBe(false);
        expect(resolveSessionListStorageTabsVisible({ directSessionsEnabled: true, platform: 'ios' })).toBe(false);
    });

    it('shows the switch on web and desktop whenever direct sessions exist', () => {
        expect(resolveSessionListStorageTabsVisible({ directSessionsEnabled: true, platform: 'web' })).toBe(true);
        expect(resolveSessionListStorageTabsVisible({ directSessionsEnabled: false, platform: 'web' })).toBe(false);
    });
});
