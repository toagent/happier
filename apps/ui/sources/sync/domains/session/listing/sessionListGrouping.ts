/**
 * How sessions are grouped inside a list section. `flat` keeps the chronological order of `date`
 * but adds no headers, so every session is one row in a single list.
 */
export type SessionListGroupingV1 = 'project' | 'date' | 'flat';

/** The single owner of which grouping applies to a section; store and listing code both use it. */
export function resolveSessionListGroupingForSection(
    section: 'active' | 'inactive',
    settings: Readonly<{
        activeGrouping?: SessionListGroupingV1 | null;
        inactiveGrouping?: SessionListGroupingV1 | null;
        groupInactiveSessionsByProject?: boolean | null;
    }>,
): SessionListGroupingV1 {
    if (section === 'active') return settings.activeGrouping ?? 'project';
    if (settings.inactiveGrouping) return settings.inactiveGrouping;
    return settings.groupInactiveSessionsByProject === true ? 'project' : 'date';
}
