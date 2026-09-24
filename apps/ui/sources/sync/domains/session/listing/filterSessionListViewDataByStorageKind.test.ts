import { describe, expect, it } from 'vitest';

import type { SessionListViewItem } from './sessionListViewData';
import { filterSessionListViewDataByStorageKind } from './filterSessionListViewDataByStorageKind';

function makeSession(id: string, direct: boolean): SessionListViewItem {
    return {
        type: 'session',
        serverId: 'server-a',
        session: {
            id,
            seq: 0,
            createdAt: 0,
            updatedAt: 0,
            active: false,
            activeAt: 0,
            metadata: direct ? { path: '', host: '', directSessionV1: { v: 1, providerId: 'codex' } } : { path: '', host: '' },
            metadataVersion: 0,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 0,
        },
    };
}

describe('filterSessionListViewDataByStorageKind', () => {
    it('keeps only direct sessions and the headers that still own visible rows', () => {
        const groupKey = 'server:server-a:day:2026-03-05';
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey, serverId: 'server-a' },
            makeSession('persisted-1', false),
            makeSession('direct-1', true),
        ];

        const result = filterSessionListViewDataByStorageKind(source, 'direct');

        expect(result.map((item) => (item.type === 'header' ? `h:${item.title}` : `s:${item.session.id}`))).toEqual([
            'h:Today',
            's:direct-1',
        ]);
    });

    it('keeps only persisted sessions and removes orphaned headers', () => {
        const directGroupKey = 'server:server-a:day:2026-03-05';
        const persistedGroupKey = 'server:server-a:day:2026-03-04';
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: directGroupKey, serverId: 'server-a' },
            makeSession('direct-1', true),
            { type: 'header', title: 'Yesterday', headerKind: 'date', groupKey: persistedGroupKey, serverId: 'server-a' },
            makeSession('persisted-1', false),
        ];

        const result = filterSessionListViewDataByStorageKind(source, 'persisted');

        expect(result.map((item) => (item.type === 'header' ? `h:${item.title}` : `s:${item.session.id}`))).toEqual([
            'h:Yesterday',
            's:persisted-1',
        ]);
    });

    it('keeps the project header above the folder header that still owns a visible row', () => {
        // Project and folder are two distinct grouping levels; keeping only the innermost one
        // silently drops the project row the folder belongs to.
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Active', headerKind: 'active', groupKey: 'active', serverId: 'server-a' },
            { type: 'header', title: 'happier', headerKind: 'project', groupKey: 'project-a', serverId: 'server-a' },
            { type: 'header', title: 'docs', headerKind: 'folder', groupKey: 'folder-a', depth: 0, serverId: 'server-a' },
            makeSession('persisted-1', false),
        ];

        const result = filterSessionListViewDataByStorageKind(source, 'persisted');

        expect(result.map((item) => (item.type === 'header' ? `h:${item.title}` : `s:${item.session.id}`))).toEqual([
            'h:Active',
            'h:happier',
            'h:docs',
            's:persisted-1',
        ]);
    });

    it('emits each surviving ancestor once across sibling folders and projects', () => {
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Active', headerKind: 'active', groupKey: 'active', serverId: 'server-a' },
            { type: 'header', title: 'happier', headerKind: 'project', groupKey: 'project-a', serverId: 'server-a' },
            { type: 'header', title: 'docs', headerKind: 'folder', groupKey: 'folder-a1', depth: 0, serverId: 'server-a' },
            makeSession('a1', false),
            makeSession('a2', false),
            { type: 'header', title: 'ui', headerKind: 'folder', groupKey: 'folder-a2', depth: 0, serverId: 'server-a' },
            makeSession('a3', false),
            { type: 'header', title: 'wetamp', headerKind: 'project', groupKey: 'project-b', serverId: 'server-a' },
            { type: 'header', title: 'docs', headerKind: 'folder', groupKey: 'folder-b1', depth: 0, serverId: 'server-a' },
            makeSession('b1', false),
        ];

        const result = filterSessionListViewDataByStorageKind(source, 'persisted');

        expect(result.map((item) => (item.type === 'header' ? `h:${item.title}` : `s:${item.session.id}`))).toEqual([
            'h:Active',
            'h:happier',
            'h:docs',
            's:a1',
            's:a2',
            'h:ui',
            's:a3',
            'h:wetamp',
            'h:docs',
            's:b1',
        ]);
    });

    it('drops a project whose every folder loses its rows to the storage filter', () => {
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Active', headerKind: 'active', groupKey: 'active', serverId: 'server-a' },
            { type: 'header', title: 'happier', headerKind: 'project', groupKey: 'project-a', serverId: 'server-a' },
            { type: 'header', title: 'docs', headerKind: 'folder', groupKey: 'folder-a1', depth: 0, serverId: 'server-a' },
            makeSession('direct-only', true),
            { type: 'header', title: 'wetamp', headerKind: 'project', groupKey: 'project-b', serverId: 'server-a' },
            { type: 'header', title: 'docs', headerKind: 'folder', groupKey: 'folder-b1', depth: 0, serverId: 'server-a' },
            makeSession('persisted-1', false),
        ];

        const result = filterSessionListViewDataByStorageKind(source, 'persisted');

        expect(result.map((item) => (item.type === 'header' ? `h:${item.title}` : `s:${item.session.id}`))).toEqual([
            'h:Active',
            'h:wetamp',
            'h:docs',
            's:persisted-1',
        ]);
    });
});
