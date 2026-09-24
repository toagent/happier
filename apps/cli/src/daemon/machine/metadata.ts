import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';
import type { MachineMetadata } from '@/api/types';
import type { TwinSessionSchedulingV1 } from '@happier-dev/protocol';
import packageJson from '../../../package.json';

const execFileAsync = promisify(execFile);

export async function getPreferredHostName(): Promise<string> {
  const fallback = os.hostname();
  if (process.platform !== 'darwin') {
    return fallback;
  }

  const tryScutil = async (key: 'HostName' | 'LocalHostName' | 'ComputerName'): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync('scutil', ['--get', key], { timeout: 400 });
      const value = typeof stdout === 'string' ? stdout.trim() : '';
      return value.length > 0 ? value : null;
    } catch {
      return null;
    }
  };

  // Prefer HostName (can be FQDN) → LocalHostName → ComputerName → os.hostname()
  return (await tryScutil('HostName'))
    ?? (await tryScutil('LocalHostName'))
    ?? (await tryScutil('ComputerName'))
    ?? fallback;
}

export function refreshMachineMetadataForCurrentDaemon(
  current: Partial<MachineMetadata>,
  host: string,
  twinSessionSchedulingV1: TwinSessionSchedulingV1 | null = null,
): MachineMetadata {
  const {
    twinSessionSchedulingV1: _previousTwinSessionSchedulingV1,
    twinSessionAutoDispatchV1: _previousTwinSessionAutoDispatchV1,
    ...preserved
  } = current;
  const next: MachineMetadata = {
    ...preserved,
    host,
    platform: os.platform(),
    happyCliVersion: packageJson.version,
    homeDir: os.homedir(),
    happyHomeDir: configuration.happyHomeDir,
    happyLibDir: projectPath(),
    daemonTerminalSessionAttachSupported: true,
    daemonSessionGoalControlsSupported: true,
    // Every controller running this scheduler can pick a worker for an `auto` target.
    ...(twinSessionSchedulingV1 ? { twinSessionSchedulingV1, twinSessionAutoDispatchV1: true as const } : {}),
  };
  if (
    current.host === next.host
    && current.platform === next.platform
    && current.happyCliVersion === next.happyCliVersion
    && current.homeDir === next.homeDir
    && current.happyHomeDir === next.happyHomeDir
    && current.happyLibDir === next.happyLibDir
    && current.daemonTerminalSessionAttachSupported === next.daemonTerminalSessionAttachSupported
    && current.daemonSessionGoalControlsSupported === next.daemonSessionGoalControlsSupported
    && JSON.stringify(current.twinSessionSchedulingV1) === JSON.stringify(next.twinSessionSchedulingV1)
    && current.twinSessionAutoDispatchV1 === next.twinSessionAutoDispatchV1
  ) {
    return current as MachineMetadata;
  }
  return next;
}

export const initialMachineMetadata: MachineMetadata = refreshMachineMetadataForCurrentDaemon(
  {},
  os.hostname(),
);
