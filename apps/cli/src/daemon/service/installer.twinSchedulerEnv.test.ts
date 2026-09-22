import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';

import { previewDaemonServiceInstall } from './installer';

const TWIN_SCHEDULER_ENV_KEY = 'HAPPIER_TWIN_SESSION_SCHEDULER_CONFIG_JSON';
const ORIGINAL_TWIN_SCHEDULER_CONFIG = process.env[TWIN_SCHEDULER_ENV_KEY];

afterEach(() => {
  if (ORIGINAL_TWIN_SCHEDULER_CONFIG === undefined) {
    delete process.env[TWIN_SCHEDULER_ENV_KEY];
  } else {
    process.env[TWIN_SCHEDULER_ENV_KEY] = ORIGINAL_TWIN_SCHEDULER_CONFIG;
  }
});

describe('daemon service installer - twin scheduler environment', () => {
  async function preview(homeDir: string) {
    return await previewDaemonServiceInstall({
      platform: 'darwin',
      channel: 'stable',
      targetMode: 'default-following',
      instanceId: 'default',
      activeServerId: 'cloud',
      uid: 501,
      userHomeDir: homeDir,
      happierHomeDir: `${homeDir}/.happier`,
      serverUrl: 'https://api.happier.dev',
      webappUrl: 'https://app.happier.dev',
      publicServerUrl: 'https://api.happier.dev',
      nodePath: '/opt/homebrew/bin/node',
      entryPath: '/opt/happier/package-dist/index.mjs',
    });
  }

  it('captures the controller scheduler config from the install process environment', async () => {
    process.env[TWIN_SCHEDULER_ENV_KEY] = JSON.stringify({
      v: 1,
      executable: '/Users/test/.lan-dev-machine/bin/twin-agent-remote',
      pollIntervalMs: 1_000,
      workers: {
        'twin-control': { machineId: 'controller-machine' },
        'twin-dev': { machineId: 'developer-machine' },
        'mac-mini': { machineId: 'mini-machine' },
      },
    });

    await withTempDir('happier-twin-scheduler-service-', async (homeDir) => {
      const definition = (await preview(homeDir)).plan.files[0]?.content ?? '';

      expect(definition).toContain(TWIN_SCHEDULER_ENV_KEY);
      expect(definition).toContain('controller-machine');
      expect(definition).toContain('mini-machine');
    });
  });

  it('preserves an installed controller config when repair has no explicit override', async () => {
    process.env[TWIN_SCHEDULER_ENV_KEY] = JSON.stringify({
      v: 1,
      executable: '/Users/test/.lan-dev-machine/bin/twin-agent-remote',
      pollIntervalMs: 1_000,
      workers: { 'twin-control': { machineId: 'controller-machine' } },
    });

    await withTempDir('happier-twin-scheduler-repair-', async (homeDir) => {
      const initial = await preview(homeDir);
      const plannedFile = initial.plan.files[0];
      expect(plannedFile).toBeDefined();
      mkdirSync(dirname(plannedFile!.path), { recursive: true });
      writeFileSync(plannedFile!.path, plannedFile!.content, 'utf8');
      delete process.env[TWIN_SCHEDULER_ENV_KEY];

      const repairedDefinition = (await preview(homeDir)).plan.files[0]?.content ?? '';

      expect(repairedDefinition).toContain(TWIN_SCHEDULER_ENV_KEY);
      expect(repairedDefinition).toContain('controller-machine');
    });
  });

  it('removes installed scheduler authority when the install environment explicitly clears it', async () => {
    process.env[TWIN_SCHEDULER_ENV_KEY] = JSON.stringify({
      v: 1,
      executable: '/Users/test/.lan-dev-machine/bin/twin-agent-remote',
      pollIntervalMs: 1_000,
      workers: { 'twin-control': { machineId: 'controller-machine' } },
    });

    await withTempDir('happier-twin-scheduler-remove-', async (homeDir) => {
      const initial = await preview(homeDir);
      const plannedFile = initial.plan.files[0];
      expect(plannedFile).toBeDefined();
      mkdirSync(dirname(plannedFile!.path), { recursive: true });
      writeFileSync(plannedFile!.path, plannedFile!.content, 'utf8');
      process.env[TWIN_SCHEDULER_ENV_KEY] = '';

      const workerDefinition = (await preview(homeDir)).plan.files[0]?.content ?? '';

      expect(workerDefinition).not.toContain(TWIN_SCHEDULER_ENV_KEY);
      expect(workerDefinition).not.toContain('controller-machine');
    });
  });
});
