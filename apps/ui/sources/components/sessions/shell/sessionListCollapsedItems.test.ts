import { describe, expect, it } from 'vitest';

import type { SessionListViewItem } from '@/sync/domains/state/storage';
import { filterCollapsedSessionListItems } from './sessionListCollapsedItems';

function session(id: string, groupKey: string, folderId: string | null, folderDepth: number): Extract<SessionListViewItem, { type: 'session' }> {
    return {
        type: 'session',
        session: { id, active: true, createdAt: 1, updatedAt: 1 } as any,
        section: 'active',
        groupKey,
        groupKind: folderId ? 'folder' : 'project',
        folderId,
        folderDepth,
        serverId: 'server-a',
    };
}

describe('filterCollapsedSessionListItems', () => {
    it('hides descendant folder headers and sessions when a folder is collapsed', () => {
        const parentGroupKey = 'folder:server-a:workspace-a:parent';
        const childGroupKey = 'folder:server-a:workspace-a:child';
        const items: SessionListViewItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 'server-a' },
            { type: 'header', headerKind: 'project', title: '~/repo', groupKey: 'project-a', serverId: 'server-a' },
            {
                type: 'header',
                headerKind: 'folder',
                title: 'Parent',
                groupKey: parentGroupKey,
                serverId: 'server-a',
                folderId: 'parent',
                parentFolderId: null,
                depth: 1,
                sessionCount: 1,
            },
            session('parent-session', parentGroupKey, 'parent', 1),
            {
                type: 'header',
                headerKind: 'folder',
                title: 'Child',
                groupKey: childGroupKey,
                serverId: 'server-a',
                folderId: 'child',
                parentFolderId: 'parent',
                depth: 2,
                sessionCount: 1,
            },
            session('child-session', childGroupKey, 'child', 2),
            session('root-session', 'project-a', null, 0),
        ];

        const filtered = filterCollapsedSessionListItems(items, { [parentGroupKey]: true });

        expect(filtered.map((item) => item.type === 'header'
            ? `header:${item.headerKind}:${item.folderId ?? 'root'}`
            : `session:${item.session.id}`
        )).toEqual([
            'header:active:root',
            'header:project:root',
            'header:folder:parent',
            'session:root-session',
        ]);
    });
});
