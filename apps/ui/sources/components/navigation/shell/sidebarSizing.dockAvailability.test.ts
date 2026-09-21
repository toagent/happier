import { describe, expect, it } from 'vitest';

import { PANE_SIZING_DEFAULTS } from '@/components/appShell/panes/layout/paneSizing';
import {
    canViewportDockSidebar,
    resolveSidebarDockMinWidthPx,
    SIDEBAR_DOCK_MIN_WIDTH_PX,
    SIDEBAR_NATIVE_TOUCH_MIN_WIDTH_PX,
} from './sidebarSizing';

describe('sidebar dock availability', () => {
    it('uses the touch-sized dock minimum on native and the pointer one on web', () => {
        expect(resolveSidebarDockMinWidthPx('web')).toBe(SIDEBAR_DOCK_MIN_WIDTH_PX);
        expect(resolveSidebarDockMinWidthPx('android')).toBe(SIDEBAR_NATIVE_TOUCH_MIN_WIDTH_PX);
        expect(resolveSidebarDockMinWidthPx('ios')).toBe(SIDEBAR_NATIVE_TOUCH_MIN_WIDTH_PX);
    });

    // A Y700 in portrait is 632dp wide. A docked sidebar needs its own minimum plus the main
    // pane's, so the shell has to fall back to the narrow layout rather than keep a rail the
    // user cannot open.
    it('reports no dock room on a native tablet held in portrait', () => {
        expect(canViewportDockSidebar({ windowWidthPx: 632, platformOS: 'android' })).toBe(false);
        expect(canViewportDockSidebar({ windowWidthPx: 1009, platformOS: 'android' })).toBe(true);
    });

    it('admits exactly the width both panes need and rejects one point less', () => {
        const nativeThreshold = SIDEBAR_NATIVE_TOUCH_MIN_WIDTH_PX + PANE_SIZING_DEFAULTS.mainMinPx;
        expect(canViewportDockSidebar({ windowWidthPx: nativeThreshold, platformOS: 'android' })).toBe(true);
        expect(canViewportDockSidebar({ windowWidthPx: nativeThreshold - 1, platformOS: 'android' })).toBe(false);

        const webThreshold = SIDEBAR_DOCK_MIN_WIDTH_PX + PANE_SIZING_DEFAULTS.mainMinPx;
        expect(canViewportDockSidebar({ windowWidthPx: webThreshold, platformOS: 'web' })).toBe(true);
        expect(canViewportDockSidebar({ windowWidthPx: webThreshold - 1, platformOS: 'web' })).toBe(false);
    });

    // An unmeasured window must not collapse the shell into the narrow layout for a frame.
    it('keeps the dock while the window width is still unknown', () => {
        expect(canViewportDockSidebar({ windowWidthPx: Number.NaN, platformOS: 'android' })).toBe(true);
        expect(canViewportDockSidebar({ windowWidthPx: 0, platformOS: 'web' })).toBe(true);
    });
});
