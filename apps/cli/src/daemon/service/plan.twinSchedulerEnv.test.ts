import { describe, expect, it } from 'vitest';

import { planDaemonServiceInstall } from './plan';

const TWIN_SCHEDULER_ENV_KEY = 'HAPPIER_TWIN_SESSION_SCHEDULER_CONFIG_JSON';
const TWIN_SCHEDULER_CONFIG = JSON.stringify({
  v: 1,
  executable: '/Users/test/.lan-dev-machine/bin/twin-agent-remote',
  pollIntervalMs: 1_000,
  workers: {
    'twin-control': { machineId: 'controller-machine' },
    'twin-dev': { machineId: 'developer-machine' },
    'mac-mini': { machineId: 'mini-machine' },
  },
});

const BASE = {
  channel: 'stable',
  instanceId: 'default',
  activeServerId: 'cloud',
  userHomeDir: '/Users/test',
  happierHomeDir: '/Users/test/.happier',
  serverUrl: 'https://api.happier.dev',
  webappUrl: 'https://app.happier.dev',
  publicServerUrl: 'https://api.happier.dev',
  nodePath: '/opt/homebrew/bin/node',
  entryPath: '/opt/happier/package-dist/index.mjs',
} as const;

describe('daemon service install plan - twin scheduler environment', () => {
  it.each([
    ['darwin', {}],
    ['linux', { mode: 'user' }],
    ['win32', {}],
  ] as const)('persists the controller scheduler config on %s', (platform, extra) => {
    const plan = planDaemonServiceInstall({
      ...BASE,
      ...extra,
      platform,
      twinSessionSchedulerConfigJson: TWIN_SCHEDULER_CONFIG,
    });
    const definition = plan.files[0]?.content ?? '';

    expect(definition).toContain(TWIN_SCHEDULER_ENV_KEY);
    expect(definition).toContain('controller-machine');
    expect(definition).toContain('developer-machine');
    expect(definition).toContain('mini-machine');
  });

  it('persists the worker release custody config so scheduled tasks can land on this machine', () => {
    // Without it a worker daemon rejects every scheduled target spawn ("release custody is
    // unavailable"), so overflow to the developer machine and Mac mini never worked.
    const plan = planDaemonServiceInstall({
      ...BASE,
      platform: 'darwin',
      twinSessionReleaseOutboxConfigJson: JSON.stringify({ v: 1, pollIntervalMs: 1_000 }),
    });
    const definition = plan.files[0]?.content ?? '';

    expect(definition).toContain('HAPPIER_TWIN_SESSION_RELEASE_OUTBOX_CONFIG_JSON');
    expect(definition).not.toContain(TWIN_SCHEDULER_ENV_KEY);
  });

  it('omits scheduler authority from worker-only services', () => {
    const plan = planDaemonServiceInstall({
      ...BASE,
      platform: 'darwin',
    });

    expect(plan.files[0]?.content ?? '').not.toContain(TWIN_SCHEDULER_ENV_KEY);
  });
});
