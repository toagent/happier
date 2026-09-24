import type { SessionListViewItem } from './sessionListViewData';
import type { SessionStorageKind } from '../sessionStorageKind';
import { getSessionStorageKind } from '../sessionStorageKind';

type HeaderItem = Extract<SessionListViewItem, { type: 'header' }>;

/**
 * Depth of a group header inside a section.
 *
 * Group headers nest — a project owns folders, folders own subfolders — so a surviving row has to
 * re-emit every ancestor, not just the innermost one. Keeping a single pending header silently
 * dropped the project row above a folder.
 */
function resolveGroupHeaderDepth(item: HeaderItem): number {
    if (item.headerKind === 'folder') {
        const depth = typeof item.depth === 'number' && Number.isFinite(item.depth) ? item.depth : 0;
        return 1 + Math.max(0, depth);
    }
    return 0;
}

export function filterSessionListViewDataByStorageKind(
    source: ReadonlyArray<SessionListViewItem>,
    storageKind: SessionStorageKind,
): SessionListViewItem[] {
    const out: SessionListViewItem[] = [];
    let pendingServerHeader: HeaderItem | null = null;
    let pendingSectionHeader: HeaderItem | null = null;
    const groupStack: Array<{ header: HeaderItem; emitted: boolean }> = [];

    for (const item of source) {
        if (item.type === 'header') {
            if (item.headerKind === 'server') {
                pendingServerHeader = item;
                groupStack.length = 0;
                continue;
            }
            if (item.headerKind === 'active' || item.headerKind === 'inactive' || item.headerKind === 'sessions') {
                pendingSectionHeader = item;
                groupStack.length = 0;
                continue;
            }
            const depth = resolveGroupHeaderDepth(item);
            groupStack.length = Math.min(groupStack.length, depth);
            groupStack[depth] = { header: item, emitted: false };
            groupStack.length = depth + 1;
            continue;
        }

        if (getSessionStorageKind(item.session) !== storageKind) {
            continue;
        }

        if (pendingServerHeader) {
            out.push(pendingServerHeader);
            pendingServerHeader = null;
        }
        if (pendingSectionHeader) {
            out.push(pendingSectionHeader);
            pendingSectionHeader = null;
        }
        for (const entry of groupStack) {
            if (!entry || entry.emitted) continue;
            out.push(entry.header);
            entry.emitted = true;
        }
        out.push(item);
    }

    return out;
}
