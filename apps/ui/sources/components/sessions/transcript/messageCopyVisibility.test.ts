import { describe, expect, it, vi } from 'vitest';

import {
    shouldShowTranscriptRowActions,
    shouldShowTranscriptRowPinAction,
    type TranscriptRowActionVisibilityInput,
} from './messageCopyVisibility';

function webInput(overrides: Partial<TranscriptRowActionVisibilityInput> = {}): TranscriptRowActionVisibilityInput {
    return {
        platformOS: 'web',
        isRowHovered: false,
        isActionHovered: false,
        ...overrides,
    };
}

describe('transcript row action visibility policy', () => {
    it('hides row actions on fine-pointer web until the row, an action, or a descendant focus reveals them', () => {
        expect(shouldShowTranscriptRowActions(webInput())).toBe(false);
        expect(shouldShowTranscriptRowActions(webInput({ isRowHovered: true }))).toBe(true);
        expect(shouldShowTranscriptRowActions(webInput({ isActionHovered: true }))).toBe(true);
        expect(shouldShowTranscriptRowActions(webInput({ isRowFocused: true }))).toBe(true);
    });

    it('keeps phone and tablet rows quiet until the row is tapped (activated)', () => {
        for (const platformOS of ['ios', 'android'] as const) {
            expect(shouldShowTranscriptRowActions({ platformOS, isRowHovered: false, isActionHovered: false })).toBe(false);
            expect(shouldShowTranscriptRowActions({ platformOS, isRowHovered: false, isActionHovered: false, isRowActivated: true })).toBe(true);
            expect(shouldShowTranscriptRowActions({ platformOS, isRowHovered: false, isActionHovered: false, selectionModeActive: true })).toBe(true);
            expect(shouldShowTranscriptRowPinAction({ platformOS, isRowHovered: false, isActionHovered: false, pinned: true })).toBe(true);
        }
    });

    it('always shows row actions on other touch hosts, coarse primary pointers and selection mode', () => {
        expect(shouldShowTranscriptRowActions({ platformOS: 'windows', isRowHovered: false, isActionHovered: false })).toBe(true);
        expect(shouldShowTranscriptRowActions(webInput({ coarsePrimaryPointer: true }))).toBe(true);
        expect(shouldShowTranscriptRowActions(webInput({ selectionModeActive: true }))).toBe(true);
    });

    it('keeps a pinned row action visible without revealing the rest of the row', () => {
        const input = webInput({ pinned: true });
        expect(shouldShowTranscriptRowPinAction(input)).toBe(true);
        expect(shouldShowTranscriptRowActions(input)).toBe(false);
    });

    it('reveals an unpinned row action exactly when the rest of the row reveals', () => {
        for (const overrides of [
            {},
            { isRowHovered: true },
            { isActionHovered: true },
            { isRowFocused: true },
            { coarsePrimaryPointer: true },
            { selectionModeActive: true },
        ] satisfies Partial<TranscriptRowActionVisibilityInput>[]) {
            const input = webInput(overrides);
            expect(shouldShowTranscriptRowPinAction(input)).toBe(shouldShowTranscriptRowActions(input));
        }
    });
});

describe('coarse primary pointer environment', () => {
    async function loadPredicate(queries: Record<string, boolean>, maxTouchPoints = 0) {
        vi.stubGlobal('window', {
            matchMedia: (query: string) => ({ matches: queries[query] === true }),
        });
        vi.stubGlobal('navigator', { maxTouchPoints });
        const module = await import('@/utils/platform/webMobileHeuristics');
        return module.isCoarsePrimaryPointerEnvironment();
    }

    it('treats a touchscreen laptop with a mouse as a hover device', async () => {
        expect(await loadPredicate({
            '(pointer: fine)': true,
            '(hover: hover)': true,
            '(any-pointer: coarse)': true,
            '(any-hover: none)': true,
        }, 10)).toBe(false);
    });

    it('treats a phone/tablet primary pointer as coarse', async () => {
        expect(await loadPredicate({
            '(pointer: coarse)': true,
            '(hover: none)': true,
            '(any-pointer: coarse)': true,
        }, 5)).toBe(true);
    });

    it('falls back to touch points only when the primary pointer is unknown', async () => {
        expect(await loadPredicate({}, 0)).toBe(false);
        expect(await loadPredicate({}, 3)).toBe(true);
    });
});
