import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  buildSessionWorkspaceLocationV1,
  type ScheduledSessionSourceChangesActionV1,
  type ScheduledSessionSourceChangesResultV1,
  type ScheduledWorkspaceV1,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { createGitTemporaryIndex } from '@/scm/backends/git/operations/commitExecutionRuntime';
import { runScmCommand } from '@/scm/runtime';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';

import type {
  TwinSessionSchedulerAttempt,
  TwinSessionWorkspaceMaterialization,
} from './twinSessionScheduler';

export type TwinSessionWorkspaceTransportConfig =
  | Readonly<{ kind: 'local'; root: string }>
  | Readonly<{ kind: 'ssh'; host: string; root: string; diffExecutable: string }>;

export type TwinSessionWorkspaceWorker = Readonly<{
  machineId: string;
  workspace?: TwinSessionWorkspaceTransportConfig;
}>;

export type TwinSessionWorkspaceMetadataUpdate = Readonly<{
  sessionId: string;
  machineId: string;
  path: string;
  scheduledWorkspace: ScheduledWorkspaceV1;
}>;

type WorkspaceProcessRunner = (input: Readonly<{
  executable: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdoutFile?: string;
}>) => Promise<Readonly<{ stdout: string }>>;

const runWorkspaceProcess: WorkspaceProcessRunner = async (input) => await new Promise((resolvePromise, rejectPromise) => {
  const child = spawn(input.executable, [...input.args], {
    ...(input.cwd ? { cwd: input.cwd } : {}),
    env: input.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const stdoutFile = input.stdoutFile ? createWriteStream(input.stdoutFile, { flags: 'w', mode: 0o600 }) : null;
  let settled = false;

  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    stdoutFile?.destroy();
    rejectPromise(error instanceof Error ? error : new Error(String(error)));
  };

  child.stdout.on('data', (raw) => {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (stdoutFile) stdoutFile.write(chunk);
    else stdoutChunks.push(chunk);
  });
  child.stderr.on('data', (raw) => {
    if (stderrChunks.reduce((total, chunk) => total + chunk.length, 0) < 128 * 1024) {
      stderrChunks.push(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
    }
  });
  child.on('error', fail);
  stdoutFile?.on('error', fail);
  child.on('close', (exitCode) => {
    const finish = () => {
      if (settled) return;
      settled = true;
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      if (exitCode !== 0) {
        rejectPromise(new Error(stderr || `${input.executable} exited with code ${String(exitCode)}`));
        return;
      }
      resolvePromise({ stdout: Buffer.concat(stdoutChunks).toString('utf8') });
    };
    if (!stdoutFile) {
      finish();
      return;
    }
    stdoutFile.end(finish);
  });
});

/**
 * Git plumbing for workspace snapshots. These are internal bulk operations over a whole repository
 * copy, so they neither inherit the 15s interactive SCM timeout (a large repository legitimately
 * takes longer; the ssh/rsync transfers beside them are unbounded too) nor run the user's git hooks
 * (the baseline commit is a synthetic snapshot, not the user's commit).
 */
async function runGitText(input: Readonly<{
  cwd: string;
  args: readonly string[];
  env?: Record<string, string | undefined>;
}>): Promise<string> {
  const result = await runScmCommand({
    bin: 'git',
    cwd: input.cwd,
    args: ['-c', 'core.hooksPath=/dev/null', ...input.args],
    timeoutMs: null,
    ...(input.env ? { env: input.env } : {}),
  });
  if (!result.success) {
    const detail = (result.stderr || result.stdout).trim();
    const reason = result.outputLimitExceeded ? 'output limit exceeded' : `exit ${result.exitCode}`;
    throw new Error(`git ${input.args[0] ?? ''} failed (${reason})${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout.trim();
}

function workspaceDirectoryName(attempt: TwinSessionSchedulerAttempt): string {
  const digest = createHash('sha256')
    .update('happier-twin-workspace-v1\0')
    .update(attempt.spawnNonce)
    .update('\0')
    .update(attempt.workerId)
    .digest('hex');
  return `session-${digest.slice(0, 32)}`;
}

function assertAbsoluteWorkspaceRoot(path: string, label: string): string {
  const normalized = path.trim();
  if (!normalized || !isAbsolute(normalized)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return resolve(normalized);
}

function resolveWorkspaceChild(root: string, name: string): string {
  const child = resolve(root, name);
  const rel = relative(root, child);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Scheduled session workspace path escaped its configured root');
  }
  return child;
}

/**
 * The last path segment of a task copy is the project's own name (`<root>/session-<hash>/<project>`),
 * because the app derives the session's project label from it. Kept to the remote-path-safe charset.
 */
function projectDirectorySegment(sourceRootDirectory: string): string {
  const segment = basename(sourceRootDirectory).replace(/[^A-Za-z0-9._-]/gu, '-').replace(/^\.+/u, '');
  return segment || 'workspace';
}

function resolveSourceRelativeDirectory(sourceRoot: string, sourceDirectory: string): string {
  const rel = relative(sourceRoot, sourceDirectory);
  if (rel === '') return '';
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Scheduled session directory is outside its Git repository');
  }
  return rel;
}

function resolveSessionDirectory(root: string, relativeDirectory: string): string {
  if (!relativeDirectory) return root;
  const directory = resolve(root, relativeDirectory);
  const rel = relative(root, directory);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Scheduled session directory escaped its materialized workspace');
  }
  return directory;
}

function assertSafeRemoteValue(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._/@:-]+$/u.test(normalized)) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return normalized;
}

function assertSafeRemotePath(value: string, label: string): string {
  const normalized = value.trim();
  if (!isAbsolute(normalized) || !/^\/[A-Za-z0-9._/-]+$/u.test(normalized)) {
    throw new Error(`${label} must be an absolute path without shell metacharacters`);
  }
  return normalized;
}

async function createSyntheticBaseline(input: Readonly<{
  sourceRoot: string;
  reviewRoot: string;
}>): Promise<Readonly<{ baselineCommit: string; sourceSnapshot: string }>> {
  await rm(input.reviewRoot, { recursive: true, force: true });
  await mkdir(input.reviewRoot, { recursive: true, mode: 0o700 });

  const temporaryIndex = await createGitTemporaryIndex({
    cwd: input.sourceRoot,
    seed: 'head-or-empty',
  });
  if (!temporaryIndex.success) throw new Error(temporaryIndex.error);
  let sourceSnapshot: string;
  try {
    await runGitText({
      cwd: input.sourceRoot,
      args: ['add', '--all', '--', '.'],
      env: temporaryIndex.tempIndex.env,
    });
    sourceSnapshot = await runGitText({
      cwd: input.sourceRoot,
      args: ['write-tree'],
      env: temporaryIndex.tempIndex.env,
    });
    await runGitText({
      cwd: input.sourceRoot,
      args: ['checkout-index', '--all', '--force', `--prefix=${input.reviewRoot}${sep}`],
      env: temporaryIndex.tempIndex.env,
    });
  } finally {
    temporaryIndex.tempIndex.cleanup();
  }

  await runGitText({ cwd: input.reviewRoot, args: ['init', '--initial-branch=review'] });
  await runGitText({ cwd: input.reviewRoot, args: ['add', '--force', '--all', '--', '.'] });
  await runGitText({
    cwd: input.reviewRoot,
    args: [
      '-c', 'user.name=Happier Workspace',
      '-c', 'user.email=happier-workspace@localhost',
      'commit', '--no-gpg-sign', '--allow-empty', '-m', 'Happier scheduled session baseline',
    ],
  });
  const baselineCommit = await runGitText({ cwd: input.reviewRoot, args: ['rev-parse', 'HEAD'] });
  return { baselineCommit, sourceSnapshot };
}

async function readSourceSnapshot(sourceRoot: string): Promise<string> {
  const temporaryIndex = await createGitTemporaryIndex({ cwd: sourceRoot, seed: 'head-or-empty' });
  if (!temporaryIndex.success) throw new Error(temporaryIndex.error);
  try {
    await runGitText({
      cwd: sourceRoot,
      args: ['add', '--all', '--', '.'],
      env: temporaryIndex.tempIndex.env,
    });
    return await runGitText({
      cwd: sourceRoot,
      args: ['write-tree'],
      env: temporaryIndex.tempIndex.env,
    });
  } finally {
    temporaryIndex.tempIndex.cleanup();
  }
}

async function copyWorkspaceToTarget(input: Readonly<{
  reviewRoot: string;
  targetRoot: string;
  transport: TwinSessionWorkspaceTransportConfig;
  runProcess: WorkspaceProcessRunner;
}>): Promise<void> {
  if (input.transport.kind === 'local') {
    if (input.reviewRoot === input.targetRoot) return;
    await rm(input.targetRoot, { recursive: true, force: true });
    await mkdir(dirname(input.targetRoot), { recursive: true, mode: 0o700 });
    await cp(input.reviewRoot, input.targetRoot, {
      recursive: true,
      force: true,
      preserveTimestamps: true,
      dereference: false,
      // Keep link targets as committed. Without this, cp rewrites relative links to absolute paths
      // into the review workspace: the task opens with every committed symlink shown as changed,
      // and writes through such a link would land in the review baseline.
      verbatimSymlinks: true,
    });
    return;
  }

  const host = assertSafeRemoteValue(input.transport.host, 'Remote workspace host');
  const targetRoot = assertSafeRemotePath(input.targetRoot, 'Remote workspace root');
  const helper = assertSafeRemotePath(input.transport.diffExecutable, 'Remote workspace helper');
  await input.runProcess({
    executable: 'ssh',
    args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, helper, 'prepare', targetRoot],
  });
  await input.runProcess({
    executable: 'rsync',
    args: ['-a', '--delete', '--', `${input.reviewRoot}${sep}`, `${host}:${targetRoot}${sep}`],
    env: {
      ...process.env,
      RSYNC_RSH: 'ssh -o BatchMode=yes -o ConnectTimeout=10',
    },
  });
}

async function writeLocalWorkspacePatch(input: Readonly<{
  workspaceRoot: string;
  baselineCommit: string;
  patchFile: string;
  runProcess: WorkspaceProcessRunner;
}>): Promise<void> {
  const indexDirectory = await mkdtemp(join(tmpdir(), 'happier-twin-index-'));
  const indexPath = join(indexDirectory, 'index');
  await writeFile(indexPath, '', { mode: 0o600 });
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    await runGitText({
      cwd: input.workspaceRoot,
      args: ['read-tree', input.baselineCommit],
      env,
    });
    await runGitText({
      cwd: input.workspaceRoot,
      args: ['add', '--force', '--all', '--', '.'],
      env,
    });
    await input.runProcess({
      executable: 'git',
      args: ['-C', input.workspaceRoot, 'diff', '--binary', '--cached', input.baselineCommit, '--'],
      env: { ...process.env, ...env },
      stdoutFile: input.patchFile,
    });
  } finally {
    await rm(indexDirectory, { recursive: true, force: true });
  }
}

async function writeTargetPatch(input: Readonly<{
  workspace: TwinSessionWorkspaceMaterialization;
  transport: TwinSessionWorkspaceTransportConfig;
  patchFile: string;
  runProcess: WorkspaceProcessRunner;
}>): Promise<void> {
  if (input.transport.kind === 'local') {
    await writeLocalWorkspacePatch({
      workspaceRoot: input.workspace.targetRootDirectory,
      baselineCommit: input.workspace.baselineCommit,
      patchFile: input.patchFile,
      runProcess: input.runProcess,
    });
    return;
  }

  const host = assertSafeRemoteValue(input.transport.host, 'Remote workspace host');
  const targetRoot = assertSafeRemotePath(input.workspace.targetRootDirectory, 'Remote workspace root');
  const helper = assertSafeRemotePath(input.transport.diffExecutable, 'Remote workspace helper');
  if (!/^[a-f0-9]{40,64}$/u.test(input.workspace.baselineCommit)) {
    throw new Error('Scheduled session baseline commit is invalid');
  }
  await input.runProcess({
    executable: 'ssh',
    args: [
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
      host,
      helper,
      'diff',
      targetRoot,
      input.workspace.baselineCommit,
    ],
    stdoutFile: input.patchFile,
  });
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', rejectPromise);
    stream.on('end', resolvePromise);
  });
  return hash.digest('hex');
}

async function applyPatchToReviewWorkspace(input: Readonly<{
  workspace: TwinSessionWorkspaceMaterialization;
  patchFile: string;
  patchDigest: string;
  runProcess: WorkspaceProcessRunner;
}>): Promise<void> {
  const currentPatchDirectory = await mkdtemp(join(tmpdir(), 'happier-twin-review-patch-'));
  const currentPatchFile = join(currentPatchDirectory, 'current.patch');
  try {
    await writeLocalWorkspacePatch({
      workspaceRoot: input.workspace.reviewRootDirectory,
      baselineCommit: input.workspace.baselineCommit,
      patchFile: currentPatchFile,
      runProcess: input.runProcess,
    });
    if (await hashFile(currentPatchFile) === input.patchDigest) return;
    if ((await stat(input.patchFile)).size === 0) {
      throw new Error('Review workspace diverged from an empty target patch');
    }
    const applyArgs = [
      '-C', input.workspace.reviewRootDirectory,
      'apply', '--binary', '--whitespace=nowarn',
    ];
    await input.runProcess({
      executable: 'git',
      args: [...applyArgs, '--check', input.patchFile],
    });
    await input.runProcess({
      executable: 'git',
      args: [...applyArgs, input.patchFile],
    });
    await writeLocalWorkspacePatch({
      workspaceRoot: input.workspace.reviewRootDirectory,
      baselineCommit: input.workspace.baselineCommit,
      patchFile: currentPatchFile,
      runProcess: input.runProcess,
    });
    if (await hashFile(currentPatchFile) !== input.patchDigest) {
      throw new Error('Review workspace patch digest did not match the target workspace');
    }
  } finally {
    await rm(currentPatchDirectory, { recursive: true, force: true });
  }
}

export type TwinSessionSourceChangesAction = ScheduledSessionSourceChangesActionV1;

/** What happened to a task's changes in its source project (the person's own checkout). */
export type TwinSessionSourceChangesResult = Exclude<
  ScheduledSessionSourceChangesResultV1,
  { status: 'not_found' | 'invalid_request' }
>;

type SourceApplyRecord = Readonly<{
  v: 1;
  appliedAt: number;
  fileCount: number;
  skippedIgnoredCount: number;
  excludedPaths: readonly string[];
}>;

/** `git apply --numstat -z` records: "added\tdeleted\tpath\0", or for a rename "a\td\t\0old\0new\0". */
function readPatchPaths(numstat: string): string[] {
  const fields = numstat.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? '';
    if (!field) continue;
    const parts = field.split('\t');
    if (parts.length < 3) continue;
    const path = parts.slice(2).join('\t');
    if (path) {
      paths.push(path);
      continue;
    }
    const from = fields[index + 1];
    const to = fields[index + 2];
    if (from) paths.push(from);
    if (to) paths.push(to);
    index += 2;
  }
  return Array.from(new Set(paths));
}

/** Paths the source project ignores; `git check-ignore` exits 1 when none are. */
async function readSourceIgnoredPaths(sourceRoot: string, paths: readonly string[]): Promise<string[]> {
  const ignored: string[] = [];
  const chunkSize = 200;
  for (let offset = 0; offset < paths.length; offset += chunkSize) {
    const chunk = paths.slice(offset, offset + chunkSize);
    const result = await runScmCommand({
      bin: 'git',
      cwd: sourceRoot,
      args: ['-c', 'core.quotePath=false', 'check-ignore', '--', ...chunk],
      timeoutMs: null,
    });
    if (!result.success && result.exitCode !== 1) {
      throw new Error(`git check-ignore failed: ${(result.stderr || result.stdout).trim()}`);
    }
    ignored.push(...result.stdout.split('\n').map((line) => line.trim()).filter(Boolean));
  }
  return ignored;
}

function escapeApplyExcludePattern(path: string): string {
  return path.replace(/[\\*?[\]]/g, (char) => `\\${char}`);
}

/** Files `git apply` refused, from its "error: <path>: ..." / "error: patch failed: <path>:<line>" lines. */
function readApplyConflictFiles(detail: string): string[] {
  const files = new Set<string>();
  for (const line of detail.split('\n')) {
    const failed = /^error: patch failed: (.+):\d+$/u.exec(line.trim());
    if (failed?.[1]) {
      files.add(failed[1]);
      continue;
    }
    const other = /^error: (.+?): (?:patch does not apply|already exists in working directory|does not exist in working directory|No such file or directory|does not match index)$/u.exec(line.trim());
    if (other?.[1]) files.add(other[1]);
  }
  return Array.from(files);
}

async function runSourceApply(input: Readonly<{
  sourceRoot: string;
  patchFile: string;
  excludedPaths: readonly string[];
  reverse: boolean;
}>): Promise<Readonly<{ status: 'ok' }> | Readonly<{ status: 'conflict'; files: string[] }>> {
  const args = [
    'apply', '--binary', '--whitespace=nowarn',
    ...(input.reverse ? ['--reverse'] : []),
    ...input.excludedPaths.map((path) => `--exclude=${escapeApplyExcludePattern(path)}`),
  ];
  const check = await runScmCommand({
    bin: 'git',
    cwd: input.sourceRoot,
    args: ['-c', 'core.hooksPath=/dev/null', ...args, '--check', input.patchFile],
    timeoutMs: null,
  });
  if (!check.success) {
    return { status: 'conflict', files: readApplyConflictFiles(check.stderr || check.stdout) };
  }
  await runGitText({ cwd: input.sourceRoot, args: [...args, input.patchFile] });
  return { status: 'ok' };
}

async function defaultUpdateSessionMetadata(input: TwinSessionWorkspaceMetadataUpdate, credentials: Credentials): Promise<void> {
  const rawSession = await fetchSessionByIdCompat({
    token: credentials.token,
    sessionId: input.sessionId,
    reason: 'legacy-compat-proof',
  });
  if (!rawSession) throw new Error('Scheduled session disappeared before review workspace publication');
  await updateSessionMetadataWithRetry({
    token: credentials.token,
    credentials,
    sessionId: input.sessionId,
    rawSession,
    updater: (metadata) => ({
      ...metadata,
      machineId: input.machineId,
      path: input.path,
      sessionWorkspaceLocationV1: buildSessionWorkspaceLocationV1({
        machineId: input.machineId,
        agentPath: input.path,
        machinePath: input.path,
      }),
      scheduledWorkspaceV1: input.scheduledWorkspace,
    }),
  });
}

export function createTwinSessionWorkspaceMaterializer(params: Readonly<{
  reviewRoot: string;
  controllerMachineId: string;
  workers: Readonly<Record<string, TwinSessionWorkspaceWorker>>;
  credentials?: Credentials;
  runProcess?: WorkspaceProcessRunner;
  updateSessionMetadata?: (input: TwinSessionWorkspaceMetadataUpdate) => Promise<void>;
}>) {
  const reviewBase = assertAbsoluteWorkspaceRoot(params.reviewRoot, 'Review workspace root');
  const controllerMachineId = params.controllerMachineId.trim();
  if (!controllerMachineId) throw new Error('Controller machine id is required');
  const runProcess = params.runProcess ?? runWorkspaceProcess;
  const updateMetadata = params.updateSessionMetadata ?? (async (input: TwinSessionWorkspaceMetadataUpdate) => {
    if (!params.credentials) throw new Error('Scheduled session metadata credentials are unavailable');
    await defaultUpdateSessionMetadata(input, params.credentials);
  });

  const resolveWorker = (workerId: string): TwinSessionWorkspaceWorker & { workspace: TwinSessionWorkspaceTransportConfig } => {
    const worker = params.workers[workerId];
    if (!worker?.workspace) {
      throw new Error(`Scheduled session worker ${workerId} has no workspace transport`);
    }
    return worker as TwinSessionWorkspaceWorker & { workspace: TwinSessionWorkspaceTransportConfig };
  };

  return {
    prepare: async (input: Readonly<{ attempt: TwinSessionSchedulerAttempt }>): Promise<Readonly<{
      options: TwinSessionSchedulerAttempt['options'];
      workspace: TwinSessionWorkspaceMaterialization;
    }>> => {
      const worker = resolveWorker(input.attempt.workerId);
      const sourceDirectory = await realpath(resolve(input.attempt.options.directory));
      const sourceRootDirectory = await realpath(resolve(await runGitText({
        cwd: sourceDirectory,
        args: ['rev-parse', '--show-toplevel'],
      })));
      const sourceRelativeDirectory = resolveSourceRelativeDirectory(sourceRootDirectory, sourceDirectory);
      const sourceHead = await runGitText({ cwd: sourceRootDirectory, args: ['rev-parse', 'HEAD'] });
      const name = join(workspaceDirectoryName(input.attempt), projectDirectorySegment(sourceRootDirectory));
      const reviewRootDirectory = resolveWorkspaceChild(reviewBase, name);
      const targetBase = assertAbsoluteWorkspaceRoot(worker.workspace.root, `Workspace root for ${input.attempt.workerId}`);
      const targetRootDirectory = resolveWorkspaceChild(targetBase, name);
      const { baselineCommit, sourceSnapshot } = await createSyntheticBaseline({
        sourceRoot: sourceRootDirectory,
        reviewRoot: reviewRootDirectory,
      });
      await copyWorkspaceToTarget({
        reviewRoot: reviewRootDirectory,
        targetRoot: targetRootDirectory,
        transport: worker.workspace,
        runProcess,
      });
      const reviewDirectory = resolveSessionDirectory(reviewRootDirectory, sourceRelativeDirectory);
      const targetDirectory = resolveSessionDirectory(targetRootDirectory, sourceRelativeDirectory);
      const workspace: TwinSessionWorkspaceMaterialization = {
        v: 1,
        state: 'prepared',
        sourceDirectory,
        sourceRootDirectory,
        sourceRelativeDirectory,
        reviewDirectory,
        reviewRootDirectory,
        targetDirectory,
        targetRootDirectory,
        sourceHead,
        sourceSnapshot,
        baselineCommit,
      };
      return {
        options: { ...input.attempt.options, directory: targetDirectory },
        workspace,
      };
    },
    /**
     * Brings the task's current changes into its source project as uncommitted edits, or takes them
     * back out. The patch is taken fresh from the task workspace (a task stays open after its turn),
     * files the project ignores are left out, and nothing is written when any file no longer matches
     * what the task started from. The applied patch is kept beside the review workspace for undo.
     */
    sourceChanges: async (input: Readonly<{
      attempt: TwinSessionSchedulerAttempt;
      action: TwinSessionSourceChangesAction;
    }>): Promise<TwinSessionSourceChangesResult> => {
      const workspace = input.attempt.workspace;
      if (!workspace) throw new Error('Scheduled session workspace was not prepared');
      const recordDirectory = join(dirname(workspace.reviewRootDirectory), 'source-apply');
      const recordFile = join(recordDirectory, 'applied.json');
      const appliedPatchFile = join(recordDirectory, 'applied.patch');
      const readRecord = async (): Promise<SourceApplyRecord | null> => {
        try {
          return JSON.parse(await readFile(recordFile, 'utf8')) as SourceApplyRecord;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        }
      };
      const appliedResult = (record: SourceApplyRecord): TwinSessionSourceChangesResult => ({
        status: 'applied',
        appliedAt: record.appliedAt,
        fileCount: record.fileCount,
        skippedIgnoredCount: record.skippedIgnoredCount,
      });

      const record = await readRecord();
      if (input.action === 'status') return record ? appliedResult(record) : { status: 'not_applied' };

      if (input.action === 'undo') {
        if (!record) return { status: 'not_applied' };
        const undone = await runSourceApply({
          sourceRoot: workspace.sourceRootDirectory,
          patchFile: appliedPatchFile,
          excludedPaths: record.excludedPaths,
          reverse: true,
        });
        if (undone.status === 'conflict') return undone;
        await rm(recordDirectory, { recursive: true, force: true });
        return { status: 'undone' };
      }

      if (record) return appliedResult(record);
      const worker = resolveWorker(input.attempt.workerId);
      const patchDirectory = await mkdtemp(join(tmpdir(), 'happier-twin-source-patch-'));
      const patchFile = join(patchDirectory, 'changes.patch');
      try {
        await writeTargetPatch({ workspace, transport: worker.workspace, patchFile, runProcess });
        if ((await stat(patchFile)).size === 0) return { status: 'no_changes' };
        const paths = readPatchPaths(await runGitText({
          cwd: workspace.sourceRootDirectory,
          args: ['apply', '--numstat', '-z', patchFile],
        }));
        const excludedPaths = await readSourceIgnoredPaths(workspace.sourceRootDirectory, paths);
        const fileCount = paths.length - excludedPaths.length;
        if (fileCount <= 0) return { status: 'no_changes' };
        const applied = await runSourceApply({
          sourceRoot: workspace.sourceRootDirectory,
          patchFile,
          excludedPaths,
          reverse: false,
        });
        if (applied.status === 'conflict') return applied;
        const nextRecord: SourceApplyRecord = {
          v: 1,
          appliedAt: Date.now(),
          fileCount,
          skippedIgnoredCount: excludedPaths.length,
          excludedPaths,
        };
        await mkdir(recordDirectory, { recursive: true, mode: 0o700 });
        await cp(patchFile, appliedPatchFile);
        await writeFile(recordFile, JSON.stringify(nextRecord), { mode: 0o600 });
        return appliedResult(nextRecord);
      } finally {
        await rm(patchDirectory, { recursive: true, force: true });
      }
    },
    finalize: async (input: Readonly<{
      attempt: TwinSessionSchedulerAttempt;
      sessionId: string;
    }>): Promise<TwinSessionWorkspaceMaterialization> => {
      const workspace = input.attempt.workspace;
      if (!workspace) throw new Error('Scheduled session workspace was not prepared');
      if (workspace.state === 'finalized') return workspace;
      const worker = resolveWorker(input.attempt.workerId);
      const patchDirectory = await mkdtemp(join(tmpdir(), 'happier-twin-target-patch-'));
      const patchFile = join(patchDirectory, 'changes.patch');
      try {
        await writeTargetPatch({
          workspace,
          transport: worker.workspace,
          patchFile,
          runProcess,
        });
        const patchDigest = await hashFile(patchFile);
        await applyPatchToReviewWorkspace({
          workspace,
          patchFile,
          patchDigest,
          runProcess,
        });
        const currentSourceHead = await runGitText({
          cwd: workspace.sourceRootDirectory,
          args: ['rev-parse', 'HEAD'],
        }).catch(() => '');
        const currentSourceSnapshot = await readSourceSnapshot(workspace.sourceRootDirectory).catch(() => '');
        const reviewState = currentSourceHead === workspace.sourceHead
          && currentSourceSnapshot === workspace.sourceSnapshot
          ? 'ready' as const
          : 'stale' as const;
        const scheduledWorkspace: ScheduledWorkspaceV1 = {
          v: 1,
          workerId: input.attempt.workerId,
          executionMachineId: input.attempt.machineId,
          executionPath: workspace.targetDirectory,
          reviewMachineId: controllerMachineId,
          reviewPath: workspace.reviewDirectory,
          sourcePath: workspace.sourceDirectory,
          sourceHead: workspace.sourceHead,
          sourceSnapshot: workspace.sourceSnapshot,
          baselineCommit: workspace.baselineCommit,
          patchDigest,
          reviewState,
        };
        await updateMetadata({
          sessionId: input.sessionId,
          machineId: controllerMachineId,
          path: workspace.reviewDirectory,
          scheduledWorkspace,
        });
        return {
          ...workspace,
          state: 'finalized',
          patchDigest,
          reviewState,
        };
      } finally {
        await rm(patchDirectory, { recursive: true, force: true });
      }
    },
  };
}
