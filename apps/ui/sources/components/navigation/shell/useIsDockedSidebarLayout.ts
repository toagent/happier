import { Platform, useWindowDimensions } from 'react-native';

import { useIsTablet } from '@/utils/platform/responsive';

import { canViewportDockSidebar } from './sidebarSizing';

/**
 * Whether the shell is drawing the tablet layout WITH a docked sidebar.
 *
 * Both halves of the shell read this: `SidebarNavigator` to decide whether to mount the dock,
 * and `MainView` to decide whether its primary pane may assume one exists. A tablet-sized
 * device is not enough on its own — held in portrait it can be too narrow to seat the sidebar
 * and the main pane side by side, and then the narrow layout owns navigation instead.
 */
export function useIsDockedSidebarLayout(): boolean {
    const isTablet = useIsTablet();
    const { width } = useWindowDimensions();
    return isTablet && canViewportDockSidebar({ windowWidthPx: width, platformOS: Platform.OS });
}
