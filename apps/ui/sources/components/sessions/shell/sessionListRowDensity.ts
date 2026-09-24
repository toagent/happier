import {
    SESSION_LIST_ROW_HEIGHT_COMPACT,
    SESSION_LIST_ROW_HEIGHT_DEFAULT,
    SESSION_LIST_ROW_HEIGHT_MINIMAL,
    SESSION_LIST_ROW_HEIGHT_MINIMAL_NATIVE_TOUCH,
} from './sessionListRowHeights';

export type SessionListRowPlatform = 'ios' | 'android' | 'web' | 'windows' | 'macos';
export type SessionListRowDensity = 'default' | 'compact' | 'minimal';

export const SESSION_LIST_ROW_CORNER_RADIUS = 12;

export const SESSION_LIST_ROW_TITLE_TEXT_METRICS = {
    default: { fontSize: 14, lineHeight: 18 },
    compact: { fontSize: 14, lineHeight: 18 },
    minimal: { fontSize: 12, lineHeight: 16 },
    minimalNativeTouch: { fontSize: 14, lineHeight: 18 },
} as const;

export const SESSION_LIST_ROW_STATUS_TEXT_METRICS = {
    default: { fontSize: 12, lineHeight: 16 },
    compact: { fontSize: 11, lineHeight: 11 },
    minimal: { fontSize: 10, lineHeight: 12 },
} as const;

export const SESSION_LIST_ROW_IDENTITY_METRICS = {
    default: { slotSize: 48, agentLogoSize: 37 },
    compact: { slotSize: 30, agentLogoSize: 23 },
    minimal: { slotSize: 18, agentLogoSize: 14 },
    minimalNativeTouch: { slotSize: 20, agentLogoSize: 16 },
} as const;

export function resolveSessionListRowTitleTextMetrics(params: Readonly<{
    density: SessionListRowDensity;
    readableNativeTouchMinimal: boolean;
}>): Readonly<{ fontSize: number; lineHeight: number }> {
    if (params.density === 'minimal' && params.readableNativeTouchMinimal) {
        return SESSION_LIST_ROW_TITLE_TEXT_METRICS.minimalNativeTouch;
    }
    return SESSION_LIST_ROW_TITLE_TEXT_METRICS[params.density];
}

export function resolveSessionListRowIdentityMetrics(params: Readonly<{
    density: SessionListRowDensity;
    readableNativeTouchMinimal: boolean;
}>): Readonly<{ slotSize: number; agentLogoSize: number }> {
    if (params.density === 'minimal' && params.readableNativeTouchMinimal) {
        return SESSION_LIST_ROW_IDENTITY_METRICS.minimalNativeTouch;
    }
    return SESSION_LIST_ROW_IDENTITY_METRICS[params.density];
}

// Minimal rows are sized for a pointer. Any native iOS/Android surface is driven by touch --
// tablets included, whose docked sidebar is still tapped with a finger -- so it gets the taller row.
export function shouldUseReadableNativeTouchMinimalSessionRow(params: Readonly<{
    compact: boolean;
    compactMinimal: boolean;
    platform: SessionListRowPlatform | string;
}>): boolean {
    return params.compact
        && params.compactMinimal
        && (params.platform === 'ios' || params.platform === 'android');
}

export function resolveSessionListRowHeight(params: Readonly<{
    compact: boolean;
    compactMinimal: boolean;
    platform: SessionListRowPlatform | string;
}>): number {
    if (shouldUseReadableNativeTouchMinimalSessionRow(params)) {
        return SESSION_LIST_ROW_HEIGHT_MINIMAL_NATIVE_TOUCH;
    }
    if (params.compactMinimal) {
        return SESSION_LIST_ROW_HEIGHT_MINIMAL;
    }
    if (params.compact) {
        return SESSION_LIST_ROW_HEIGHT_COMPACT;
    }
    return SESSION_LIST_ROW_HEIGHT_DEFAULT;
}
