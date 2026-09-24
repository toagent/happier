import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { installTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return installTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) =>
            params ? `${key}(${JSON.stringify(params)})` : key,
    })();
});

describe('resolveSessionListHeaderTitle', () => {
    it('localizes the fixed section headers instead of showing their English index titles', async () => {
        const { resolveSessionListHeaderTitle } = await import('./sessionListHeaderTitle');
        expect(resolveSessionListHeaderTitle({ title: 'Active', headerKind: 'active' })).toBe('sessionsList.activeSectionTitle');
        expect(resolveSessionListHeaderTitle({ title: 'Inactive', headerKind: 'inactive' })).toBe('sessionsList.inactiveSectionTitle');
        expect(resolveSessionListHeaderTitle({ title: 'Pinned', headerKind: 'pinned' })).toBe('sessionsList.pinnedSectionTitle');
    });

    it('keeps data-derived titles and wraps server names', async () => {
        const { resolveSessionListHeaderTitle } = await import('./sessionListHeaderTitle');
        expect(resolveSessionListHeaderTitle({ title: 'happier', headerKind: 'project' })).toBe('happier');
        expect(resolveSessionListHeaderTitle({ title: 'twin', headerKind: 'server' })).toBe('sessionsList.serverHeader({"server":"twin"})');
    });
});
