import { describe, expect, it } from 'vitest';
import {
    getHasAnyAgentInputActions,
    resolveAgentInputActionBarLayout,
    shouldShowSecondaryControlRow,
} from './actionBarLogic';

describe('agentInput/actionBarLogic', () => {
    it('shows the secondary controls row in wrap and scroll modes when controls exist', () => {
        expect(shouldShowSecondaryControlRow('wrap', true)).toBe(true);
        expect(shouldShowSecondaryControlRow('wrap', false)).toBe(false);
        expect(shouldShowSecondaryControlRow('scroll', true)).toBe(true);
        expect(shouldShowSecondaryControlRow('scroll', false)).toBe(false);
        expect(shouldShowSecondaryControlRow('collapsed', true)).toBe(false);
    });

    it('resolves auto layout to scroll on web so controls stay in two compact rows', () => {
        expect(resolveAgentInputActionBarLayout({
            configuredLayout: 'auto',
            platform: 'web',
        })).toBe('scroll');
    });

    it('collapses every control behind one menu by default on native, leaving the composer to text and send', () => {
        expect(resolveAgentInputActionBarLayout({
            configuredLayout: 'auto',
            platform: 'android',
        })).toBe('collapsed');
        expect(resolveAgentInputActionBarLayout({
            configuredLayout: null,
            platform: 'ios',
        })).toBe('collapsed');
    });

    it('preserves explicit action bar layout settings', () => {
        expect(resolveAgentInputActionBarLayout({
            configuredLayout: 'wrap',
            platform: 'web',
        })).toBe('wrap');
        expect(resolveAgentInputActionBarLayout({
            configuredLayout: 'collapsed',
            platform: 'ios',
        })).toBe('collapsed');
    });

    it('treats resume as an action (prevents collapsed menu from being empty)', () => {
        expect(getHasAnyAgentInputActions({
            showPermissionChip: false,
            hasProfile: false,
            hasEnvVars: false,
            hasAgent: false,
            hasRecipient: false,
            hasDelivery: false,
            hasExtraActionChips: false,
            hasMachine: false,
            hasPath: false,
            hasResume: true,
            hasFiles: false,
            hasStop: false,
        })).toBe(true);
    });

    it('returns false when there are no actions', () => {
        expect(getHasAnyAgentInputActions({
            showPermissionChip: false,
            hasProfile: false,
            hasEnvVars: false,
            hasAgent: false,
            hasRecipient: false,
            hasDelivery: false,
            hasExtraActionChips: false,
            hasMachine: false,
            hasPath: false,
            hasResume: false,
            hasFiles: false,
            hasStop: false,
        })).toBe(false);
    });

    it('treats delivery as an action so collapsed controls stay reachable', () => {
        expect(getHasAnyAgentInputActions({
            showPermissionChip: false,
            hasProfile: false,
            hasEnvVars: false,
            hasAgent: false,
            hasRecipient: false,
            hasDelivery: true,
            hasExtraActionChips: false,
            hasMachine: false,
            hasPath: false,
            hasResume: false,
            hasFiles: false,
            hasStop: false,
        })).toBe(true);
    });

    it('treats canonical extra action chips as actions so collapsed controls stay reachable', () => {
        expect(getHasAnyAgentInputActions({
            showPermissionChip: false,
            hasProfile: false,
            hasEnvVars: false,
            hasAgent: false,
            hasRecipient: false,
            hasDelivery: false,
            hasExtraActionChips: true,
            hasMachine: false,
            hasPath: false,
            hasResume: false,
            hasFiles: false,
            hasStop: false,
        })).toBe(true);
    });
});
