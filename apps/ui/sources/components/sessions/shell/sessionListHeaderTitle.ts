import type { SessionListViewItem } from '@/sync/domains/state/storage';
import { t } from '@/text';

type SessionListHeader = Pick<Extract<SessionListViewItem, { type: 'header' }>, 'title' | 'headerKind'>;

// The list index is cached and serialized, so fixed section headers keep a stable English title there
// (it also backs their test ids); the reader-facing label is resolved in the current locale here.
export function resolveSessionListHeaderTitle(item: SessionListHeader): string {
    switch (item.headerKind) {
        case 'server':
            return t('sessionsList.serverHeader', { server: item.title });
        case 'active':
            return t('sessionsList.activeSectionTitle');
        case 'inactive':
            return t('sessionsList.inactiveSectionTitle');
        case 'pinned':
            return t('sessionsList.pinnedSectionTitle');
        default:
            return item.title;
    }
}
