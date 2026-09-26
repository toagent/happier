import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { resolveRenderedAgentInputControls } from './resolveRenderedAgentInputControls';

const node = (id: string) => <React.Fragment key={id}>{id}</React.Fragment>;
const keysOf = (nodes: readonly React.ReactNode[]) => nodes.map((n) => (n as React.ReactElement).key);

describe('resolveRenderedAgentInputControls', () => {
    it('leaves only the action menu (and controls the menu cannot reach) on a collapsed composer', () => {
        const rendered = resolveRenderedAgentInputControls({
            layout: 'collapsed',
            coreControlNodesById: {
                engine: [node('engine')],
                permission: [node('permission')],
                actionMenu: [node('actionMenu')],
            },
            extraControlNodesById: {
                mcp: [node('mcp')],
                attachments: [node('attachments')],
            },
            extraChips: [],
            menuControlIds: new Set(['engine', 'permission', 'mcp']),
        });

        expect(keysOf(rendered.chips)).toEqual(['actionMenu', 'attachments']);
    });

    it('keeps every control as a chip outside the collapsed layout', () => {
        const rendered = resolveRenderedAgentInputControls({
            layout: 'wrap',
            coreControlNodesById: { engine: [node('engine')], permission: [node('permission')] },
            extraControlNodesById: {},
            extraChips: [],
            menuControlIds: new Set(['engine', 'permission']),
        });

        expect(keysOf(rendered.chips)).toEqual(['engine', 'permission']);
    });
});
