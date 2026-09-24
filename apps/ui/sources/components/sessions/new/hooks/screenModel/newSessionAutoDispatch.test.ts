import { describe, expect, it } from 'vitest';

import { createMachineFixture } from '@/dev/testkit';
import type { Machine } from '@/sync/domains/state/storageTypes';

import { resolveAutoDispatchController, resolveNewSessionSchedulingTarget } from './newSessionAutoDispatch';

const scheduling = {
    v: 1 as const,
    defaultWorkerId: 'twin-control',
    workers: [{ workerId: 'twin-control', machineId: 'controller' }],
};

function machine(id: string, extra: Partial<NonNullable<Machine['metadata']>> = {}, overrides: Partial<Machine> = {}): Machine {
    const base = createMachineFixture({ id, activeAt: Date.now(), ...overrides });
    return { ...base, metadata: { ...base.metadata!, ...extra } };
}

const controller = machine('controller', { twinSessionSchedulingV1: scheduling, twinSessionAutoDispatchV1: true });

describe('resolveAutoDispatchController', () => {
    it('picks the online controller that dispatches tasks itself', () => {
        expect(resolveAutoDispatchController([machine('worker'), controller])?.id).toBe('controller');
    });

    it('falls back to manual machine choice when no controller can auto-dispatch', () => {
        // A controller from an older CLI still schedules, but only to an explicitly chosen worker.
        const explicitOnly = machine('controller', { twinSessionSchedulingV1: scheduling });
        expect(resolveAutoDispatchController([machine('worker'), explicitOnly])).toBeNull();
        expect(resolveAutoDispatchController([{ ...controller, active: false, activeAt: 0 }])).toBeNull();
    });
});

describe('resolveNewSessionSchedulingTarget', () => {
    it('lets the auto-dispatch controller choose the worker', () => {
        expect(resolveNewSessionSchedulingTarget({ machine: controller, selectedWorkerId: 'twin-control' }))
            .toEqual({ v: 1, auto: true });
    });

    it('keeps an explicit worker for a controller without auto dispatch', () => {
        const explicitOnly = machine('controller', { twinSessionSchedulingV1: scheduling });
        expect(resolveNewSessionSchedulingTarget({ machine: explicitOnly, selectedWorkerId: 'twin-dev' }))
            .toEqual({ v: 1, workerId: 'twin-dev' });
        expect(resolveNewSessionSchedulingTarget({ machine: machine('plain'), selectedWorkerId: null })).toBeNull();
    });
});
