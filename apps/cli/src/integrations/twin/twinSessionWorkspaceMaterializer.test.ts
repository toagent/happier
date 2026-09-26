import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TwinSessionSchedulerAttempt } from './twinSessionScheduler';
import { createTwinSessionWorkspaceMaterializer } from './twinSessionWorkspaceMaterializer';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', [...args], { cwd, encoding: 'utf8' });
  return result.stdout.trim();
}

function attempt(directory: string): TwinSessionSchedulerAttempt {
  return {
    v: 1,
    spawnNonce: 'spawn-local-snapshot',
    requestDigest: 'request-digest',
    workerId: 'twin-dev',
    machineId: 'machine-dev',
    leaseId: 'lease-1',
    ownerToken: 'owner-token',
    phase: 'dispatching',
    options: {
      directory,
      spawnNonce: 'spawn-local-snapshot',
      schedulingTarget: { v: 1, workerId: 'twin-dev' },
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    },
  };
}

describe('twin session workspace materializer', () => {
  it('round-trips text, binary, additions, and deletions into one local review workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-twin-workspace-'));
    temporaryDirectories.push(root);
    const sourceRoot = join(root, 'source');
    const reviewBase = join(root, 'reviews');
    const targetBase = join(root, 'targets');
    await mkdir(join(sourceRoot, 'packages', 'app'), { recursive: true });
    await runGit(sourceRoot, ['init', '--initial-branch=main']);
    await runGit(sourceRoot, ['config', 'user.name', 'Test User']);
    await runGit(sourceRoot, ['config', 'user.email', 'test@example.com']);
    await writeFile(join(sourceRoot, '.gitignore'), '.env\n', 'utf8');
    await writeFile(join(sourceRoot, 'packages', 'app', 'tracked.txt'), 'base\n', 'utf8');
    await writeFile(join(sourceRoot, 'delete.txt'), 'delete me\n', 'utf8');
    await writeFile(join(sourceRoot, 'image.bin'), Buffer.from([0, 1, 2, 3]));
    await runGit(sourceRoot, ['add', '--all']);
    await runGit(sourceRoot, ['commit', '-m', 'base']);

    await writeFile(join(sourceRoot, 'packages', 'app', 'tracked.txt'), 'dirty source\n', 'utf8');
    await writeFile(join(sourceRoot, 'source-only.txt'), 'untracked source\n', 'utf8');
    await writeFile(join(sourceRoot, '.env'), 'must-not-transfer\n', 'utf8');

    const metadataUpdates: unknown[] = [];
    const materializer = createTwinSessionWorkspaceMaterializer({
      reviewRoot: reviewBase,
      controllerMachineId: 'machine-controller',
      workers: {
        'twin-dev': {
          machineId: 'machine-dev',
          workspace: { kind: 'local', root: targetBase },
        },
      },
      updateSessionMetadata: async (input) => {
        metadataUpdates.push(input);
      },
    });

    const prepared = await materializer.prepare({
      attempt: attempt(join(sourceRoot, 'packages', 'app')),
    });
    expect(prepared.workspace).toMatchObject({
      state: 'prepared',
      sourceRootDirectory: await realpath(sourceRoot),
      sourceRelativeDirectory: 'packages/app',
      reviewRootDirectory: expect.stringContaining('/reviews/'),
      targetRootDirectory: expect.stringContaining('/targets/'),
    });
    expect(prepared.options.directory).toBe(prepared.workspace.targetDirectory);
    await expect(readFile(join(prepared.workspace.targetRootDirectory, 'packages', 'app', 'tracked.txt'), 'utf8'))
      .resolves.toBe('dirty source\n');
    await expect(readFile(join(prepared.workspace.targetRootDirectory, 'source-only.txt'), 'utf8'))
      .resolves.toBe('untracked source\n');
    await expect(stat(join(prepared.workspace.targetRootDirectory, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await runGit(prepared.workspace.reviewRootDirectory, ['status', '--short'])).toBe('');

    await writeFile(join(prepared.workspace.targetRootDirectory, 'packages', 'app', 'tracked.txt'), 'agent change\n', 'utf8');
    await writeFile(join(prepared.workspace.targetRootDirectory, 'image.bin'), Buffer.from([9, 8, 7, 0, 6]));
    await rm(join(prepared.workspace.targetRootDirectory, 'delete.txt'));
    await writeFile(join(prepared.workspace.targetRootDirectory, 'new.txt'), 'new file\n', 'utf8');

    const finalized = await materializer.finalize({
      attempt: {
        ...attempt(join(sourceRoot, 'packages', 'app')),
        phase: 'running',
        dispatchOptions: prepared.options,
        workspace: prepared.workspace,
        result: { type: 'success', sessionId: 'session-1' },
      },
      sessionId: 'session-1',
    });

    expect(finalized).toMatchObject({
      state: 'finalized',
      reviewState: 'ready',
      patchDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    await expect(readFile(join(finalized.reviewRootDirectory, 'packages', 'app', 'tracked.txt'), 'utf8'))
      .resolves.toBe('agent change\n');
    await expect(readFile(join(finalized.reviewRootDirectory, 'image.bin')))
      .resolves.toEqual(Buffer.from([9, 8, 7, 0, 6]));
    await expect(stat(join(finalized.reviewRootDirectory, 'delete.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(finalized.reviewRootDirectory, 'new.txt'), 'utf8')).resolves.toBe('new file\n');
    expect(await runGit(finalized.reviewRootDirectory, ['status', '--short'])).toContain('new.txt');
    expect(metadataUpdates).toEqual([
      expect.objectContaining({
        sessionId: 'session-1',
        machineId: 'machine-controller',
        path: finalized.reviewDirectory,
        scheduledWorkspace: expect.objectContaining({
          workerId: 'twin-dev',
          executionMachineId: 'machine-dev',
          reviewMachineId: 'machine-controller',
          reviewState: 'ready',
        }),
      }),
    ]);
  });

  it('keeps relative symlinks as they are, so a fresh task starts with no changes', async () => {
    // Copying the review baseline resolved relative links to absolute paths into the review workspace:
    // every repository with committed symlinks (skills, .cursorrules) opened a new task showing them
    // all as changed, and writing through such a link would have edited the baseline itself.
    const root = await mkdtemp(join(tmpdir(), 'happier-twin-workspace-symlinks-'));
    temporaryDirectories.push(root);
    const sourceRoot = join(root, 'source');
    await mkdir(join(sourceRoot, '.agents', 'skills', 'review'), { recursive: true });
    await mkdir(join(sourceRoot, '.claude', 'skills'), { recursive: true });
    await runGit(sourceRoot, ['init', '--initial-branch=main']);
    await runGit(sourceRoot, ['config', 'user.name', 'Test User']);
    await runGit(sourceRoot, ['config', 'user.email', 'test@example.com']);
    await writeFile(join(sourceRoot, 'AGENTS.md'), 'rules\n', 'utf8');
    await writeFile(join(sourceRoot, '.agents', 'skills', 'review', 'SKILL.md'), 'skill\n', 'utf8');
    await symlink('AGENTS.md', join(sourceRoot, '.cursorrules'));
    await symlink('../../.agents/skills/review', join(sourceRoot, '.claude', 'skills', 'review'));
    await runGit(sourceRoot, ['add', 'AGENTS.md', '.agents', '.cursorrules', '.claude']);
    await runGit(sourceRoot, ['commit', '-m', 'base']);

    const materializer = createTwinSessionWorkspaceMaterializer({
      reviewRoot: join(root, 'reviews'),
      controllerMachineId: 'machine-controller',
      workers: { 'twin-dev': { machineId: 'machine-dev', workspace: { kind: 'local', root: join(root, 'targets') } } },
      updateSessionMetadata: async () => {},
    });

    const prepared = await materializer.prepare({ attempt: attempt(sourceRoot) });
    const target = prepared.workspace.targetRootDirectory;

    expect(await readlink(join(target, '.cursorrules'))).toBe('AGENTS.md');
    expect(await readlink(join(target, '.claude', 'skills', 'review'))).toBe('../../.agents/skills/review');
    expect(await runGit(target, ['status', '--short'])).toBe('');
  });

  it('builds the review baseline without running the user\'s git hooks', async () => {
    // The baseline commit is an internal snapshot, not the user's commit. On the controller a global
    // core.hooksPath (secret scan + large-file gate) ran over the whole repository copy and the
    // prepared workspace never came up, so every scheduled task failed before it started.
    const root = await mkdtemp(join(tmpdir(), 'happier-twin-workspace-hooks-'));
    temporaryDirectories.push(root);
    const sourceRoot = join(root, 'source');
    await mkdir(sourceRoot, { recursive: true });
    await runGit(sourceRoot, ['init', '--initial-branch=main']);
    await runGit(sourceRoot, ['config', 'user.name', 'Test User']);
    await runGit(sourceRoot, ['config', 'user.email', 'test@example.com']);
    await writeFile(join(sourceRoot, 'tracked.txt'), 'base\n', 'utf8');
    await runGit(sourceRoot, ['add', 'tracked.txt']);
    await runGit(sourceRoot, ['commit', '-m', 'base']);

    const hooksDir = join(root, 'hooks');
    await mkdir(hooksDir, { recursive: true });
    await writeFile(join(hooksDir, 'pre-commit'), '#!/bin/sh\necho blocked-by-user-hook >&2\nexit 1\n', { mode: 0o755 });
    const globalConfig = join(root, 'global.gitconfig');
    await writeFile(globalConfig, `[core]\n\thooksPath = ${hooksDir}\n`, 'utf8');

    const materializer = createTwinSessionWorkspaceMaterializer({
      reviewRoot: join(root, 'reviews'),
      controllerMachineId: 'machine-controller',
      workers: { 'twin-dev': { machineId: 'machine-dev', workspace: { kind: 'local', root: join(root, 'targets') } } },
      updateSessionMetadata: async () => {},
    });

    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    try {
      const prepared = await materializer.prepare({ attempt: attempt(sourceRoot) });
      expect(prepared.workspace.state).toBe('prepared');
      expect(await readFile(join(prepared.workspace.targetDirectory, 'tracked.txt'), 'utf8')).toBe('base\n');
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
    }
  });

  it('names each task copy after its project so the app shows the project, not an internal id', async () => {
    // Session titles and paths are derived from the directory name; a bare `session-<hash>` hid which
    // project a task belonged to.
    const root = await mkdtemp(join(tmpdir(), 'happier-twin-workspace-name-'));
    temporaryDirectories.push(root);
    const sourceRoot = join(root, 'dispatch-demo');
    await mkdir(sourceRoot, { recursive: true });
    await runGit(sourceRoot, ['init', '--initial-branch=main']);
    await runGit(sourceRoot, ['config', 'user.name', 'Test User']);
    await runGit(sourceRoot, ['config', 'user.email', 'test@example.com']);
    await writeFile(join(sourceRoot, 'tracked.txt'), 'base\n', 'utf8');
    await runGit(sourceRoot, ['add', 'tracked.txt']);
    await runGit(sourceRoot, ['commit', '-m', 'base']);
    const materializer = createTwinSessionWorkspaceMaterializer({
      reviewRoot: join(root, 'reviews'),
      controllerMachineId: 'machine-controller',
      workers: { 'twin-dev': { machineId: 'machine-dev', workspace: { kind: 'local', root: join(root, 'targets') } } },
      updateSessionMetadata: async () => {},
    });

    const { workspace } = await materializer.prepare({ attempt: attempt(sourceRoot) });

    expect(workspace.targetRootDirectory.split('/').at(-1)).toBe('dispatch-demo');
    expect(workspace.reviewRootDirectory.split('/').at(-1)).toBe('dispatch-demo');
    expect(await readFile(join(workspace.targetDirectory, 'tracked.txt'), 'utf8')).toBe('base\n');
  });

  it('marks the review stale when the source worktree changes without moving HEAD', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-twin-workspace-stale-'));
    temporaryDirectories.push(root);
    const sourceRoot = join(root, 'source');
    await mkdir(sourceRoot, { recursive: true });
    await runGit(sourceRoot, ['init', '--initial-branch=main']);
    await runGit(sourceRoot, ['config', 'user.name', 'Test User']);
    await runGit(sourceRoot, ['config', 'user.email', 'test@example.com']);
    await writeFile(join(sourceRoot, 'tracked.txt'), 'base\n', 'utf8');
    await runGit(sourceRoot, ['add', '--all']);
    await runGit(sourceRoot, ['commit', '-m', 'base']);

    const updateSessionMetadata = vi.fn(async () => {});
    const materializer = createTwinSessionWorkspaceMaterializer({
      reviewRoot: join(root, 'reviews'),
      controllerMachineId: 'machine-controller',
      workers: {
        'twin-dev': {
          machineId: 'machine-dev',
          workspace: { kind: 'local', root: join(root, 'targets') },
        },
      },
      updateSessionMetadata,
    });
    const original = attempt(sourceRoot);
    const prepared = await materializer.prepare({ attempt: original });
    await writeFile(join(sourceRoot, 'tracked.txt'), 'new local source state\n', 'utf8');
    await writeFile(join(prepared.workspace.targetRootDirectory, 'tracked.txt'), 'agent change\n', 'utf8');

    await expect(materializer.finalize({
      attempt: {
        ...original,
        phase: 'running',
        dispatchOptions: prepared.options,
        workspace: prepared.workspace,
        result: { type: 'success', sessionId: 'session-1' },
      },
      sessionId: 'session-1',
    })).resolves.toMatchObject({ reviewState: 'stale' });
    expect(updateSessionMetadata).toHaveBeenCalledWith(expect.objectContaining({
      scheduledWorkspace: expect.objectContaining({ reviewState: 'stale' }),
    }));
  });

  it('reuses an already applied binary patch when finalization retries after metadata failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-twin-workspace-retry-'));
    temporaryDirectories.push(root);
    const sourceRoot = join(root, 'source');
    await mkdir(sourceRoot, { recursive: true });
    await runGit(sourceRoot, ['init', '--initial-branch=main']);
    await runGit(sourceRoot, ['config', 'user.name', 'Test User']);
    await runGit(sourceRoot, ['config', 'user.email', 'test@example.com']);
    await writeFile(join(sourceRoot, 'file.bin'), Buffer.from([1, 2, 3]));
    await runGit(sourceRoot, ['add', '--all']);
    await runGit(sourceRoot, ['commit', '-m', 'base']);

    const updateSessionMetadata = vi.fn()
      .mockRejectedValueOnce(new Error('metadata unavailable'))
      .mockResolvedValueOnce(undefined);
    const materializer = createTwinSessionWorkspaceMaterializer({
      reviewRoot: join(root, 'reviews'),
      controllerMachineId: 'machine-controller',
      workers: {
        'twin-dev': {
          machineId: 'machine-dev',
          workspace: { kind: 'local', root: join(root, 'targets') },
        },
      },
      updateSessionMetadata,
    });
    const original = attempt(sourceRoot);
    const prepared = await materializer.prepare({ attempt: original });
    await writeFile(join(prepared.workspace.targetRootDirectory, 'file.bin'), Buffer.from([9, 0, 8]));
    const running = {
      ...original,
      phase: 'running' as const,
      dispatchOptions: prepared.options,
      workspace: prepared.workspace,
      result: { type: 'success' as const, sessionId: 'session-1' },
    };

    await expect(materializer.finalize({ attempt: running, sessionId: 'session-1' }))
      .rejects.toThrow('metadata unavailable');
    await expect(materializer.finalize({ attempt: running, sessionId: 'session-1' }))
      .resolves.toMatchObject({ state: 'finalized' });
    await expect(readFile(join(prepared.workspace.reviewRootDirectory, 'file.bin')))
      .resolves.toEqual(Buffer.from([9, 0, 8]));
    expect(updateSessionMetadata).toHaveBeenCalledTimes(2);
  });
});
