import { describe, expect, it } from 'vitest';

import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

import { buildSessionListViewData } from './sessionListViewData';

function makeMachineDisplay(partial: Partial<MachineDisplayRenderable> & Pick<MachineDisplayRenderable, 'id'>): MachineDisplayRenderable {
    const updatedAt = partial.updatedAt ?? 0;
    const active = partial.active ?? false;
    const activeAt = partial.activeAt ?? updatedAt;
    return {
        id: partial.id,
        updatedAt,
        active,
        activeAt,
        revokedAt: partial.revokedAt ?? null,
        metadataVersion: partial.metadataVersion ?? 0,
        metadata: partial.metadata ?? null,
    };
}

function makeRenderableSession(
    partial: Partial<SessionListRenderableSession> & Pick<SessionListRenderableSession, 'id'>,
): SessionListRenderableSession {
    const active = partial.active ?? true;
    const createdAt = partial.createdAt ?? 0;
    const activeAt = partial.activeAt ?? createdAt;
    const updatedAt = partial.updatedAt ?? createdAt;
    return {
        id: partial.id,
        seq: partial.seq ?? 0,
        createdAt,
        updatedAt,
        active,
        activeAt,
        archivedAt: partial.archivedAt ?? null,
        metadataVersion: partial.metadataVersion ?? 0,
        agentStateVersion: partial.agentStateVersion ?? 0,
        metadata: partial.metadata ?? null,
        thinking: partial.thinking ?? false,
        thinkingAt: partial.thinkingAt ?? 0,
        presence: active ? 'online' : activeAt,
    };
}

/**
 * Mirrors the real three-machine setup that motivated machine-first grouping: the same project
 * name (`happier`) exists on two machines, so a project-first list renders two indistinguishable
 * `happier` headers and demotes the only disambiguating fact — the machine — to a subtitle.
 */
function buildThreeMachineFixture() {
    const sessions: Record<string, SessionListRenderableSession> = {
        s_controller_repo: makeRenderableSession({
            id: 's_controller_repo',
            createdAt: 30,
            metadata: { machineId: 'm_controller', path: '/Users/yong/work/happier', homeDir: '/Users/yong' },
        }),
        s_controller_home: makeRenderableSession({
            id: 's_controller_home',
            createdAt: 20,
            metadata: { machineId: 'm_controller', path: '/Users/yong', homeDir: '/Users/yong' },
        }),
        s_dev_repo: makeRenderableSession({
            id: 's_dev_repo',
            createdAt: 10,
            metadata: { machineId: 'm_dev', path: '/Users/yong/work/happier', homeDir: '/Users/yong' },
        }),
    };

    const machines: Record<string, MachineDisplayRenderable> = {
        m_controller: makeMachineDisplay({
            id: 'm_controller',
            active: true,
            activeAt: 300,
            metadata: { displayName: 'Yong-2', host: 'Yong-2.local', homeDir: '/Users/yong' },
        }),
        m_dev: makeMachineDisplay({
            id: 'm_dev',
            active: false,
            activeAt: 100,
            metadata: { displayName: null, host: 'YongMac', homeDir: '/Users/yong' },
        }),
    };

    return { sessions, machines };
}

const GROUPING_OPTIONS = {
    groupInactiveSessionsByProject: true,
    activeGroupingV1: 'project',
    inactiveGroupingV1: 'project',
} as const;

describe('buildSessionListViewData (machine-first grouping)', () => {
    it('emits one machine header per machine above that machine project groups', () => {
        const { sessions, machines } = buildThreeMachineFixture();

        const list = buildSessionListViewData(sessions, machines, { ...GROUPING_OPTIONS });

        const machineHeaders = list.filter((item): item is Extract<typeof item, { type: 'header' }> =>
            item.type === 'header' && item.headerKind === 'machine',
        );
        expect(machineHeaders.map((item) => item.title)).toEqual(['Yong-2', 'YongMac']);
    });

    it('keeps every project group underneath its own machine header', () => {
        const { sessions, machines } = buildThreeMachineFixture();

        const list = buildSessionListViewData(sessions, machines, { ...GROUPING_OPTIONS });

        // Walk the list and attribute each project header to the machine header preceding it.
        const projectsByMachine = new Map<string, string[]>();
        let currentMachine: string | null = null;
        for (const item of list) {
            if (item.type !== 'header') continue;
            if (item.headerKind === 'machine') {
                currentMachine = item.title;
                projectsByMachine.set(item.title, []);
                continue;
            }
            if (item.headerKind === 'project' && currentMachine) {
                projectsByMachine.get(currentMachine)?.push(item.title);
            }
        }

        expect(projectsByMachine.get('Yong-2')).toEqual(['happier', 'Home']);
        expect(projectsByMachine.get('YongMac')).toEqual(['happier']);
    });

    it('carries machine online state on the machine header so the row can show reachability', () => {
        const { sessions, machines } = buildThreeMachineFixture();

        const list = buildSessionListViewData(sessions, machines, { ...GROUPING_OPTIONS });

        const machineHeaders = list.filter((item): item is Extract<typeof item, { type: 'header' }> =>
            item.type === 'header' && item.headerKind === 'machine',
        );
        expect(machineHeaders.map((item) => [item.title, item.machine?.active])).toEqual([
            ['Yong-2', true],
            ['YongMac', false],
        ]);
    });

    it('drops the redundant machine subtitle from project headers now that the machine owns its own row', () => {
        const { sessions, machines } = buildThreeMachineFixture();

        const list = buildSessionListViewData(sessions, machines, { ...GROUPING_OPTIONS });

        const projectHeaders = list.filter((item): item is Extract<typeof item, { type: 'header' }> =>
            item.type === 'header' && item.headerKind === 'project',
        );
        expect(projectHeaders.length).toBeGreaterThan(0);
        for (const header of projectHeaders) {
            expect(header.subtitle).toBeUndefined();
        }
    });

    it('gives the home directory a readable project title instead of a bare tilde', () => {
        const { sessions, machines } = buildThreeMachineFixture();

        const list = buildSessionListViewData(sessions, machines, { ...GROUPING_OPTIONS });

        const projectTitles = list
            .filter((item): item is Extract<typeof item, { type: 'header' }> =>
                item.type === 'header' && item.headerKind === 'project',
            )
            .map((item) => item.title);
        expect(projectTitles).toContain('Home');
        expect(projectTitles).not.toContain('~');
    });
});
