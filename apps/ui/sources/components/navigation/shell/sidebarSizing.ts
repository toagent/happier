import { PANE_SIZING_DEFAULTS } from '@/components/appShell/panes/layout/paneSizing';

export const SIDEBAR_COLLAPSED_WIDTH_PX = 72;
export const SIDEBAR_DOCK_MIN_WIDTH_PX = 250;
export const SIDEBAR_NATIVE_TOUCH_MIN_WIDTH_PX = 320;

export function resolveSidebarDockMinWidthPx(platformOS: string): number {
    return platformOS === 'web' ? SIDEBAR_DOCK_MIN_WIDTH_PX : SIDEBAR_NATIVE_TOUCH_MIN_WIDTH_PX;
}

/**
 * Whether this viewport has room to DOCK the sidebar beside the main pane.
 *
 * The single answer to that question. The shell used to decide it twice: `SidebarNavigator`
 * squeezed the dock down to the rail when the window was too narrow, while `MainView` kept
 * asking `useIsTablet()` and so kept drawing the tablet primary pane — the one whose empty
 * state reads "pick a session from the sidebar". On a tablet held in portrait those two
 * answers disagreed and left the app with a rail, that empty state, and no way to reach the
 * session list at all; the rail's expand control only ever rendered on web, and even there the
 * width rule immediately re-collapsed it.
 *
 * Below this width the shell uses the narrow layout instead, which carries its own header and
 * tabs and needs no sidebar.
 */
export function canViewportDockSidebar(params: Readonly<{
    windowWidthPx: number;
    platformOS: string;
}>): boolean {
    const { windowWidthPx, platformOS } = params;
    // An unmeasured window is not evidence of a narrow one: keep the dock until a real width arrives.
    if (!Number.isFinite(windowWidthPx) || windowWidthPx <= 0) return true;
    return windowWidthPx >= resolveSidebarDockMinWidthPx(platformOS) + PANE_SIZING_DEFAULTS.mainMinPx;
}

const SIDEBAR_BASE_MAX_PX = 480;
const SIDEBAR_MAX_PX_CAP = 720;
const SIDEBAR_MAX_PCT = 0.5;

export function resolveSidebarDockMaxWidthPx(windowWidthPx: number): number {
    if (!Number.isFinite(windowWidthPx) || windowWidthPx <= 0) return SIDEBAR_BASE_MAX_PX;
    const pctMax = Math.floor(windowWidthPx * SIDEBAR_MAX_PCT);
    return Math.max(SIDEBAR_BASE_MAX_PX, Math.min(SIDEBAR_MAX_PX_CAP, pctMax));
}
