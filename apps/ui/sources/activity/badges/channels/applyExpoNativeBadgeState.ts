import type { ActivityBadgeState } from '../activityBadgeState';
import { loadExpoNotifications } from '@/utils/platform/loadExpoNotifications';
import { withTimeout } from '@/utils/timing/time';

/**
 * A stalled native badge write would strand `drainPromise`, and the in-flight guard below would
 * then silently drop every later badge update for the lifetime of the process.
 */
const EXPO_NATIVE_BADGE_UPDATE_TIMEOUT_MS = 8_000;

let pendingCount: number | null = null;
let drainPromise: Promise<boolean> | null = null;
let lastAppliedCount: number | null = null;
let nativeBadgeWritesUnavailable = false;

async function drainPendingBadgeCount(): Promise<boolean> {
    const Notifications = await loadExpoNotifications().catch(() => null);
    if (!Notifications) {
        pendingCount = null;
        return false;
    }

    let lastResult = true;
    while (pendingCount !== null) {
        if (nativeBadgeWritesUnavailable) {
            pendingCount = null;
            return false;
        }
        const count = pendingCount;
        pendingCount = null;
        if (count === lastAppliedCount) continue;
        try {
            lastResult = await withTimeout(
                Notifications.setBadgeCountAsync(count),
                EXPO_NATIVE_BADGE_UPDATE_TIMEOUT_MS,
                'expo-notifications setBadgeCountAsync',
            );
        } catch {
            // A timeout or thrown native error is transient: release the drain
            // so a later badge update can retry.
            lastResult = false;
            continue;
        }
        if (lastResult) {
            lastAppliedCount = count;
            continue;
        }

        // expo-notifications resolves `false` when the platform refuses or
        // does not support badge writes. Retrying every count change can keep
        // re-entering vendor launchers' permission/badge paths, so fail closed
        // for the rest of this process. A process restart re-probes capability.
        nativeBadgeWritesUnavailable = true;
        pendingCount = null;
        return false;
    }
    return lastResult;
}

export function applyExpoNativeBadgeState(state: ActivityBadgeState): Promise<boolean> {
    if (nativeBadgeWritesUnavailable) return Promise.resolve(false);
    pendingCount = Math.max(0, state.count);
    if (!drainPromise) {
        drainPromise = drainPendingBadgeCount().finally(() => {
            drainPromise = null;
            if (pendingCount !== null) {
                void applyExpoNativeBadgeState({ count: pendingCount, showNonNumericDot: false });
            }
        });
    }
    return drainPromise;
}
