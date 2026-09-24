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

    it('hides every project and session under a collapsed machine until the next machine', () => {
        const machineAKey = 'server:server-a:machine:m1';
        const machineBKey = 'server:server-a:machine:m2';
        const items: SessionListViewItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 'server-a' },
            { type: 'header', headerKind: 'machine', title: 'Yong-2', groupKey: machineAKey, serverId: 'server-a' },
            { type: 'header', headerKind: 'project', title: 'happier', groupKey: 'project-a1', serverId: 'server-a' },
            session('a1', 'project-a1', null, 0),
            { type: 'header', headerKind: 'project', title: 'Home', groupKey: 'project-a2', serverId: 'server-a' },
            session('a2', 'project-a2', null, 0),
            { type: 'header', headerKind: 'machine', title: 'YongMac', groupKey: machineBKey, serverId: 'server-a' },
            { type: 'header', headerKind: 'project', title: 'happier', groupKey: 'project-b1', serverId: 'server-a' },
            session('b1', 'project-b1', null, 0),
        ];

        const filtered = filterCollapsedSessionListItems(items, { [machineAKey]: true });

        expect(filtered.map((item) => item.type === 'header'
            ? `header:${item.headerKind}:${item.title}`
            : `session:${item.session.id}`
        )).toEqual([
            'header:active:Active',
            'header:machine:Yong-2',
            'header:machine:YongMac',
            'header:project:happier',
            'session:b1',
        ]);
    });

    it('keeps a later section visible when the last machine of the previous section is collapsed', () => {
        const machineKey = 'server:server-a:machine:m1';
        const items: SessionListViewItem[] = [
            { type: 'header', headerKind: 'active', title: 'Active', serverId: 'server-a' },
            { type: 'header', headerKind: 'machine', title: 'Yong-2', groupKey: machineKey, serverId: 'server-a' },
            { type: 'header', headerKind: 'project', title: 'happier', groupKey: 'project-a1', serverId: 'server-a' },
            session('a1', 'project-a1', null, 0),
            { type: 'header', headerKind: 'inactive', title: 'Inactive', serverId: 'server-a' },
            { type: 'header', headerKind: 'machine', title: 'YongMac', groupKey: 'server:server-a:machine:m2', serverId: 'server-a' },
            { type: 'header', headerKind: 'project', title: 'happier', groupKey: 'project-b1', serverId: 'server-a' },
            session('b1', 'project-b1', null, 0),
        ];

        const filtered = filterCollapsedSessionListItems(items, { [machineKey]: true });

        expect(filtered.map((item) => item.type === 'header'
            ? `header:${item.headerKind}:${item.title}`
            : `session:${item.session.id}`
        )).toEqual([
            'header:active:Active',
            'header:machine:Yong-2',
            'header:inactive:Inactive',
            'header:machine:YongMac',
            'header:project:happier',
            'session:b1',
        ]);
    });
});
