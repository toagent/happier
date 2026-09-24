import { describe, expect, it } from 'vitest';

import type { ScmStatus } from '@/sync/domains/state/storageTypes';

import { resolveSessionRowScmDelta } from './sessionRowScmDelta';

function makeStatus(partial: Partial<ScmStatus>): ScmStatus {
    return {
        branch: 'main',
        isDirty: false,
        modifiedCount: 0,
        untrackedCount: 0,
        includedCount: 0,
        lastUpdatedAt: 0,
        includedLinesAdded: 0,
        includedLinesRemoved: 0,
        pendingLinesAdded: 0,
        pendingLinesRemoved: 0,
        linesAdded: 0,
        linesRemoved: 0,
        linesChanged: 0,
        ...partial,
    };
}

describe('resolveSessionRowScmDelta', () => {
    it('returns nothing when the session has reported no source-control status yet', () => {
        // The row must stay silent rather than fetch: SCM status arrives by push, and rendering a
        // placeholder for every row would imply a per-row request the list deliberately avoids.
        expect(resolveSessionRowScmDelta(null)).toBeNull();
    });

    it('returns nothing for a clean working tree', () => {
        expect(resolveSessionRowScmDelta(makeStatus({ isDirty: false }))).toBeNull();
    });

    it('reports added and removed line counts for a dirty working tree', () => {
        const delta = resolveSessionRowScmDelta(makeStatus({
            isDirty: true,
            linesAdded: 7,
            linesRemoved: 2,
        }));
        expect(delta).toEqual({ added: 7, removed: 2 });
    });

    it('still reports a one-sided change so a delete-only edit stays visible', () => {
        expect(resolveSessionRowScmDelta(makeStatus({
            isDirty: true,
            linesAdded: 0,
            linesRemoved: 4,
        }))).toEqual({ added: 0, removed: 4 });
    });

    it('returns nothing when a dirty tree reports no line changes at all', () => {
        // A rename-only or mode-only change has no +/- to show; an empty badge is worse than none.
        expect(resolveSessionRowScmDelta(makeStatus({
            isDirty: true,
            linesAdded: 0,
            linesRemoved: 0,
        }))).toBeNull();
    });

    it('ignores negative or non-finite counts rather than rendering nonsense', () => {
        expect(resolveSessionRowScmDelta(makeStatus({
            isDirty: true,
            linesAdded: Number.NaN,
            linesRemoved: -3,
        }))).toBeNull();
    });
});
