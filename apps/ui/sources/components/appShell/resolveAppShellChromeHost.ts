export type AppShellChromeHost =
    | 'none'
    | 'web-top-right'
    | 'unauth-shell'
    | 'narrow-desktop-fallback';

export type ResolveAppShellChromeHostParams = Readonly<{
    isAuthenticated: boolean;
    isDesktopPetOverlayWindow: boolean;
    isWeb: boolean;
    isTauriDesktop: boolean;
    /**
     * Whether the shell actually seated a docked sidebar, which is what hosts the desktop
     * window chrome. A tablet-classed viewport is not enough on its own: too narrow to seat
     * the sidebar and the main pane together, the shell falls back to the narrow layout and
     * the chrome needs its own host here.
     */
    isDockedSidebarLayout: boolean;
    isTerminalConnectRoute: boolean;
}>;

export function resolveAppShellChromeHost(
    params: ResolveAppShellChromeHostParams,
): AppShellChromeHost {
    if (params.isTerminalConnectRoute || params.isDesktopPetOverlayWindow) {
        return 'none';
    }

    if (!params.isTauriDesktop && params.isWeb) {
        return 'web-top-right';
    }

    if (!params.isTauriDesktop) {
        return 'none';
    }

    if (!params.isAuthenticated) {
        return 'unauth-shell';
    }

    if (!params.isDockedSidebarLayout) {
        return 'narrow-desktop-fallback';
    }

    return 'none';
}
