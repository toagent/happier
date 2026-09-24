import { describe, expect, it } from 'vitest';

import { resolveSessionListRowHeight } from './sessionListRowDensity';
import {
    SESSION_LIST_ROW_HEIGHT_MINIMAL,
    SESSION_LIST_ROW_HEIGHT_MINIMAL_NATIVE_TOUCH,
} from './sessionListRowHeights';

describe('resolveSessionListRowHeight', () => {
    it('gives native touch tablets the readable minimal row, not the pointer-sized one', () => {
        for (const platform of ['android', 'ios'] as const) {
            expect(resolveSessionListRowHeight({ compact: true, compactMinimal: true, platform }))
                .toBe(SESSION_LIST_ROW_HEIGHT_MINIMAL_NATIVE_TOUCH);
        }
    });

    it('keeps the pointer-sized minimal row on web', () => {
        expect(resolveSessionListRowHeight({ compact: true, compactMinimal: true, platform: 'web' }))
            .toBe(SESSION_LIST_ROW_HEIGHT_MINIMAL);
    });
});
