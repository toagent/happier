import type { Machine } from '@/sync/domains/state/storageTypes';
import type { SessionSchedulingTargetV1 } from '@happier-dev/protocol';
import { isMachineOnline } from '@/utils/sessions/machineUtils';

function dispatchesAutomatically(machine: Machine | null): boolean {
    return Boolean(machine?.metadata?.twinSessionSchedulingV1 && machine.metadata.twinSessionAutoDispatchV1 === true);
}

/**
 * The online controller that picks the executing machine itself. While one exists, a new task has
 * no machine to choose: it is launched through this controller, which dispatches it. Without one
 * (older CLI, controller offline) the new-session screen keeps its manual machine choice.
 */
export function resolveAutoDispatchController(machines: ReadonlyArray<Machine>): Machine | null {
    return machines.find((machine) => dispatchesAutomatically(machine) && isMachineOnline(machine)) ?? null;
}

export function resolveNewSessionSchedulingTarget(params: Readonly<{
    machine: Machine | null;
    selectedWorkerId: string | null;
}>): SessionSchedulingTargetV1 | null {
    if (dispatchesAutomatically(params.machine)) return { v: 1, auto: true };
    return params.selectedWorkerId ? { v: 1, workerId: params.selectedWorkerId } : null;
}
