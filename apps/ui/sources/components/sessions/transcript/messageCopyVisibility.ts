import type { PlatformOSType } from 'react-native';

/**
 * Canonical visibility policy for transcript row actions (copy / select / fork /
 * rollback / pin). One owner for every surface that reveals a row action, so a
 * single row cannot end up with two competing reveal rules.
 *
 * Fine-pointer web hides the actions until the row is hovered, an action is
 * hovered, or keyboard focus enters the action group. Phones and tablets keep
 * rows quiet until the row is activated (a tap on a message, an expanded tool
 * row); long-press stays free for text selection. Other touch hosts and web
 * hosts whose PRIMARY pointer is coarse have no hover, so the actions stay
 * visible there.
 */
export type TranscriptRowActionVisibilityInput = Readonly<{
    platformOS: PlatformOSType;
    isRowHovered: boolean;
    isActionHovered: boolean;
    isRowFocused?: boolean;
    /** Phone/tablet reveal: the row was tapped (message) or expanded (tool row). */
    isRowActivated?: boolean;
    coarsePrimaryPointer?: boolean;
    selectionModeActive?: boolean;
    /** Pinned rows keep their pin visible without revealing the rest of the row. */
    pinned?: boolean;
}>;

export function shouldShowTranscriptRowActions(input: TranscriptRowActionVisibilityInput): boolean {
    if (input.selectionModeActive === true) return true;
    if (input.platformOS === 'ios' || input.platformOS === 'android') {
        return input.isRowActivated === true || input.isRowFocused === true;
    }
    if (input.platformOS !== 'web') return true;
    if (input.coarsePrimaryPointer === true) return true;
    return input.isRowHovered || input.isActionHovered || input.isRowFocused === true;
}

export function shouldShowTranscriptRowPinAction(input: TranscriptRowActionVisibilityInput): boolean {
    if (input.pinned === true) return true;
    return shouldShowTranscriptRowActions(input);
}
