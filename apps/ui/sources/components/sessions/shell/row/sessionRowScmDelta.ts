import type { ScmStatus } from '@/sync/domains/state/storageTypes';

export type SessionRowScmDelta = Readonly<{
    added: number;
    removed: number;
}>;

function readNonNegativeCount(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    return value;
}

/**
 * Decides whether a session row can show a source-control delta.
 *
 * Status arrives by push into `sessionScmStatus`, so a row renders the badge only when its session
 * already reported one. Returning `null` — rather than a zero badge or a loading state — keeps the
 * list free of per-row SCM requests.
 */
export function resolveSessionRowScmDelta(status: ScmStatus | null | undefined): SessionRowScmDelta | null {
    if (!status || !status.isDirty) return null;

    const added = readNonNegativeCount(status.linesAdded);
    const removed = readNonNegativeCount(status.linesRemoved);
    if (added === null || removed === null) return null;
    if (added === 0 && removed === 0) return null;

    return { added, removed };
}
