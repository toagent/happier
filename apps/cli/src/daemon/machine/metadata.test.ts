import { describe, expect, it } from 'vitest';

import { initialMachineMetadata, refreshMachineMetadataForCurrentDaemon } from './metadata';

describe('initialMachineMetadata', () => {
  it('advertises daemon-owned runtime control capabilities', () => {
    expect(initialMachineMetadata.daemonTerminalSessionAttachSupported).toBe(true);
    expect(initialMachineMetadata.daemonSessionGoalControlsSupported).toBe(true);
  });

  it('refreshes older persisted metadata without dropping user-owned fields', () => {
    const current = {
      ...initialMachineMetadata,
      displayName: 'Build box',
      daemonTerminalSessionAttachSupported: undefined,
      daemonSessionGoalControlsSupported: undefined,
    };

    expect(refreshMachineMetadataForCurrentDaemon(current, current.host)).toMatchObject({
      displayName: 'Build box',
      daemonTerminalSessionAttachSupported: true,
      daemonSessionGoalControlsSupported: true,
    });
  });

  it('returns the existing metadata object when every daemon-owned field is current', () => {
    const current = {
      ...initialMachineMetadata,
      displayName: 'Build box',
    };

    expect(refreshMachineMetadataForCurrentDaemon(current, current.host)).toBe(current);
  });

  it('publishes and removes the configured twin-session controller capability', () => {
    const capability = {
      v: 1 as const,
      defaultWorkerId: 'twin-control',
      workers: [
        { workerId: 'twin-control', machineId: 'machine-control' },
        { workerId: 'twin-dev', machineId: 'machine-dev' },
      ],
    };
    const published = refreshMachineMetadataForCurrentDaemon(
      initialMachineMetadata,
      initialMachineMetadata.host,
      capability,
    );

    expect(published.twinSessionSchedulingV1).toEqual(capability);
    expect(refreshMachineMetadataForCurrentDaemon(
      published,
      published.host,
      null,
    )).not.toHaveProperty('twinSessionSchedulingV1');
  });
});
