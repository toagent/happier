import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, readdir } from 'node:fs/promises';
import { createHash, randomBytes as nodeRandomBytes, randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

import {
  openAccountScopedBlobCiphertext,
  RPC_METHODS,
  sealAccountScopedBlobCiphertext,
  SPAWN_SESSION_ERROR_CODES,
  type AccountScopedCryptoMaterial,
  type TwinSessionSchedulingV1,
  type SpawnSessionErrorCode,
  type SpawnSessionNonceResolution,
} from '@happier-dev/protocol';
import * as z from 'zod';

import type { Credentials } from '@/persistence';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import { callMachineRpc } from '@/session/transport/rpc/machineRpc';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import { startSingleFlightIntervalLoop, type SingleFlightIntervalLoopHandle } from '@/daemon/lifecycle/singleFlightIntervalLoop';

import {
  createTwinSessionScheduler,
  type TwinSessionLeaseState,
  type TwinSessionSchedulerAttempt,
  type TwinSessionSchedulerAttemptStore,
  type TwinSessionReleaseReceiptPayload,
} from './twinSessionScheduler';
import { TWIN_SESSION_SCHEDULER_CONFIG_ENV_KEY } from './twinSessionSchedulerConfig';
import {
  createTwinSessionWorkspaceMaterializer,
  type TwinSessionWorkspaceMetadataUpdate,
} from './twinSessionWorkspaceMaterializer';

export { TWIN_SESSION_SCHEDULER_CONFIG_ENV_KEY } from './twinSessionSchedulerConfig';

const AbsolutePathSchema = z.string().trim().min(1).refine(isAbsolute, {
  message: 'Twin session scheduler paths must be absolute',
});

const WorkspaceTransportConfigSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('local'),
    root: AbsolutePathSchema,
  }).strict(),
  z.object({
    kind: z.literal('ssh'),
    host: z.string().trim().min(1),
    root: AbsolutePathSchema,
    diffExecutable: AbsolutePathSchema,
  }).strict(),
]);

const WorkerConfigSchema = z.object({
  machineId: z.string().trim().min(1),
  workspace: WorkspaceTransportConfigSchema,
}).strict();

const TwinSessionSchedulerConfigSchema = z.object({
  v: z.literal(1),
  executable: z.string().trim().min(1).refine(isAbsolute, {
    message: 'Twin session scheduler requires an absolute executable path',
  }),
  pollIntervalMs: z.number().int().positive(),
  reviewRoot: AbsolutePathSchema,
  defaultWorkerId: z.string().trim().min(1).optional(),
  workers: z.record(z.string(), WorkerConfigSchema).refine((workers) => {
    const entries = Object.entries(workers);
    return entries.length > 0 && entries.every(([workerId]) => workerId.length > 0 && workerId.trim() === workerId);
  }, {
    message: 'Twin session scheduler requires nonblank worker ids',
  }),
}).strict().superRefine((config, context) => {
  if (config.defaultWorkerId && !(config.defaultWorkerId in config.workers)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Default scheduling worker must exist in the worker map',
      path: ['defaultWorkerId'],
    });
  }
}).transform((config) => ({
  ...config,
  defaultWorkerId: config.defaultWorkerId
    ?? (config.workers['twin-control'] ? 'twin-control' : Object.keys(config.workers)[0]!),
}));

export type TwinSessionSchedulerConfig = z.infer<typeof TwinSessionSchedulerConfigSchema>;

export function buildTwinSessionSchedulingCapability(
  config: TwinSessionSchedulerConfig,
): TwinSessionSchedulingV1 {
  return {
    v: 1,
    defaultWorkerId: config.defaultWorkerId,
    workers: Object.entries(config.workers).map(([workerId, worker]) => ({
      workerId,
      machineId: worker.machineId,
    })),
  };
}

export function resolveTwinSessionSchedulerConfig(
  env: NodeJS.ProcessEnv = process.env,
): TwinSessionSchedulerConfig | null {
  const raw = env[TWIN_SESSION_SCHEDULER_CONFIG_ENV_KEY]?.trim() ?? '';
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid ${TWIN_SESSION_SCHEDULER_CONFIG_ENV_KEY} JSON`);
  }
  return TwinSessionSchedulerConfigSchema.parse(parsed);
}

type SchedulerCommandRunner = (input: Readonly<{
  executable: string;
  args: readonly string[];
}>) => Promise<Readonly<{ stdout: string }>>;

const runSchedulerCommand: SchedulerCommandRunner = async ({ executable, args }) => await new Promise((resolve, reject) => {
  execFile(executable, [...args], { encoding: 'utf8' }, (error, stdout) => {
    if (error) {
      reject(error);
      return;
    }
    resolve({ stdout });
  });
});

function parseLeaseState(stdout: string): TwinSessionLeaseState {
  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/u)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const state = values.get('state');
  if (state !== 'queued' && state !== 'acquired' && state !== 'released') {
    throw new Error('Twin session scheduler returned an invalid lease state');
  }
  const queuePositionRaw = values.get('queue_position');
  if (state !== 'queued' || queuePositionRaw === undefined) return { state };
  const queuePosition = Number(queuePositionRaw);
  if (!Number.isSafeInteger(queuePosition) || queuePosition < 1) {
    throw new Error('Twin session scheduler returned an invalid queue position');
  }
  return { state, queuePosition };
}

export function createTwinSessionLeaseClient(params: Readonly<{
  executable: string;
  runCommand?: SchedulerCommandRunner;
}>) {
  const run = params.runCommand ?? runSchedulerCommand;
  const invoke = async (action: 'lease-acquire' | 'lease-status' | 'lease-release', args: readonly string[]) => {
    try {
      return parseLeaseState((await run({ executable: params.executable, args: [action, ...args] })).stdout);
    } catch {
      throw new Error(`Twin session scheduler ${action} failed`);
    }
  };
  return {
    acquire: async (input: Readonly<{ leaseId: string; workerId: string; ownerToken: string }>) =>
      await invoke('lease-acquire', [input.leaseId, input.workerId, input.ownerToken]),
    read: async (input: Readonly<{ leaseId: string; ownerToken: string }>) =>
      await invoke('lease-status', [input.leaseId, input.ownerToken]),
    release: async (input: Readonly<{ leaseId: string; ownerToken: string }>) =>
      await invoke('lease-release', [input.leaseId, input.ownerToken]),
    forget: async (input: Readonly<{ leaseId: string; ownerToken: string }>): Promise<void> => {
      try {
        const output = await run({
          executable: params.executable,
          args: ['lease-forget', input.leaseId, input.ownerToken],
        });
        if (!output.stdout.split(/\r?\n/u).includes('state=forgotten')) {
          throw new Error('invalid response');
        }
      } catch {
        throw new Error('Twin session scheduler lease-forget failed');
      }
    },
  };
}

const AttemptEnvelopeSchema = z.object({
  v: z.literal(1),
  ciphertext: z.string().min(1),
}).strict();

const SpawnErrorCodeSchema = z.enum(Object.values(SPAWN_SESSION_ERROR_CODES) as [SpawnSessionErrorCode, ...SpawnSessionErrorCode[]]);
const SpawnResultSchema = z.union([
  z.object({
    type: z.literal('success'),
    sessionId: z.string().optional(),
    spawnNonce: z.string().optional(),
    sessionIdStatus: z.enum(['available', 'pending']).optional(),
    pendingFirstInputAccepted: z.boolean().optional(),
    runnerAcceptance: z.enum(['newly_accepted', 'same_request_runner', 'preexisting_or_adopted']).optional(),
  }).passthrough(),
  z.object({
    type: z.literal('requestToApproveDirectoryCreation'),
    directory: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal('error'),
    errorCode: SpawnErrorCodeSchema,
    errorMessage: z.string(),
    errorDetail: z.unknown().optional(),
  }).passthrough(),
]);

const AttemptSchema = z.object({
  v: z.literal(1),
  spawnNonce: z.string().min(1),
  requestDigest: z.string().min(1),
  workerId: z.string().min(1),
  machineId: z.string().min(1),
  leaseId: z.string().min(1),
  ownerToken: z.string().min(1),
  phase: z.enum(['created', 'queued', 'dispatching', 'running', 'failed', 'released']),
  options: z.object({ directory: z.string() }).passthrough(),
  dispatchOptions: z.object({ directory: z.string() }).passthrough().optional(),
  workspace: z.object({
    v: z.literal(1),
    state: z.enum(['prepared', 'finalized']),
    sourceDirectory: z.string().min(1),
    sourceRootDirectory: z.string().min(1),
    sourceRelativeDirectory: z.string(),
    reviewDirectory: z.string().min(1),
    reviewRootDirectory: z.string().min(1),
    targetDirectory: z.string().min(1),
    targetRootDirectory: z.string().min(1),
    sourceHead: z.string().min(1),
    sourceSnapshot: z.string().min(1),
    baselineCommit: z.string().min(1),
    patchDigest: z.string().min(1).optional(),
    reviewState: z.enum(['ready', 'stale']).optional(),
  }).strict().optional(),
  result: SpawnResultSchema.optional(),
  terminalSessionId: z.string().min(1).optional(),
  runnerAcceptanceRequired: z.boolean().optional(),
  runnerAcceptanceRecorded: z.boolean().optional(),
  leaseForgotten: z.boolean().optional(),
}).strict();

const ReleaseReceiptPayloadSchema = z.object({
  v: z.literal(1),
  purpose: z.literal('twin_session_release_ack'),
  attemptLookupId: z.string().trim().min(1),
  leaseId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
}).strict();

function parseAttempt(value: unknown): TwinSessionSchedulerAttempt {
  return AttemptSchema.parse(value) as unknown as TwinSessionSchedulerAttempt;
}

function attemptPath(directory: string, spawnNonce: string): string {
  const digest = createHash('sha256').update(spawnNonce).digest('hex');
  return join(directory, `${digest}.json`);
}

export function createTwinSessionAttemptStore(params: Readonly<{
  directory: string;
  encryptionMaterial: AccountScopedCryptoMaterial;
  randomBytes?: (length: number) => Uint8Array;
}>): TwinSessionSchedulerAttemptStore {
  let mutationTail: Promise<void> = Promise.resolve();
  const withMutationLock = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = mutationTail;
    let release!: () => void;
    mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
  const ensureDirectory = async () => {
    await mkdir(params.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(params.directory, 0o700);
  };
  const readAttempt = async (path: string): Promise<TwinSessionSchedulerAttempt | null> => {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    let envelope: z.infer<typeof AttemptEnvelopeSchema>;
    try {
      envelope = AttemptEnvelopeSchema.parse(JSON.parse(raw));
    } catch {
      throw new Error('Invalid twin session scheduler attempt envelope');
    }
    const opened = openAccountScopedBlobCiphertext({
      kind: 'twin_session_scheduler_attempt',
      material: params.encryptionMaterial,
      ciphertext: envelope.ciphertext,
    });
    if (!opened) throw new Error('Failed to decrypt twin session scheduler attempt');
    try {
      return parseAttempt(opened.value);
    } catch {
      throw new Error('Invalid twin session scheduler attempt payload');
    }
  };
  const writeAttempt = async (attempt: TwinSessionSchedulerAttempt): Promise<void> => {
    await ensureDirectory();
    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'twin_session_scheduler_attempt',
      material: params.encryptionMaterial,
      payload: attempt,
      randomBytes: params.randomBytes ?? ((length) => new Uint8Array(nodeRandomBytes(length))),
    });
    await writeJsonAtomic(attemptPath(params.directory, attempt.spawnNonce), { v: 1, ciphertext });
  };
  const listAttempts = async (): Promise<readonly TwinSessionSchedulerAttempt[]> => {
    await ensureDirectory();
    const names = (await readdir(params.directory)).filter((name) => name.endsWith('.json')).sort();
    const attempts = await Promise.all(names.map(async (name) => await readAttempt(join(params.directory, name))));
    return attempts.filter((attempt): attempt is TwinSessionSchedulerAttempt => attempt !== null);
  };
  return {
    createIfAbsent: async (attempt) => await withMutationLock(async () => {
      const path = attemptPath(params.directory, attempt.spawnNonce);
      const existing = await readAttempt(path);
      if (existing) return existing;
      await writeAttempt(attempt);
      return attempt;
    }),
    load: async (spawnNonce) => await readAttempt(attemptPath(params.directory, spawnNonce)),
    listRecoverable: async () => (await listAttempts()).filter((attempt) => attempt.phase !== 'released'),
    update: async (spawnNonce, transition) => await withMutationLock(async () => {
      const path = attemptPath(params.directory, spawnNonce);
      const current = await readAttempt(path);
      if (!current) return null;
      const next = transition(current);
      await writeAttempt(next);
      return next;
    }),
    save: async (attempt) => await withMutationLock(async () => await writeAttempt(attempt)),
  };
}

function parseSpawnResult(value: unknown): SpawnSessionResult {
  return SpawnResultSchema.parse(value) as SpawnSessionResult;
}

const SpawnResolutionSchema = z.union([
  z.object({ status: z.literal('success'), sessionId: z.string().trim().min(1) }).strict(),
  z.object({
    status: z.literal('error'),
    errorCode: SpawnErrorCodeSchema,
    errorMessage: z.string(),
    errorDetail: z.unknown().optional(),
  }).passthrough(),
  z.object({ status: z.literal('pending') }).strict(),
  z.object({ status: z.literal('not_found') }).strict(),
  z.object({ status: z.literal('unsupported') }).strict(),
]);

function parseSpawnResolution(value: unknown): SpawnSessionNonceResolution {
  return SpawnResolutionSchema.parse(value) as SpawnSessionNonceResolution;
}

export type TwinSessionSchedulerAdapter = ReturnType<typeof createTwinSessionScheduler> & Readonly<{
  start: () => Promise<void>;
  stop: () => void;
}>;

export function createTwinSessionSchedulerAdapter(params: Readonly<{
  config: TwinSessionSchedulerConfig;
  attemptDirectory: string;
  encryptionMaterial: AccountScopedCryptoMaterial;
  credentials: Credentials;
  controllerMachineId: string;
  runCommand?: SchedulerCommandRunner;
  callMachineRpcFn?: typeof callMachineRpc;
  updateSessionMetadata?: (input: TwinSessionWorkspaceMetadataUpdate) => Promise<void>;
  logWarning: (message: string, error: unknown) => void;
}>): TwinSessionSchedulerAdapter {
  const leaseClient = createTwinSessionLeaseClient({
    executable: params.config.executable,
    ...(params.runCommand ? { runCommand: params.runCommand } : {}),
  });
  const store = createTwinSessionAttemptStore({
    directory: params.attemptDirectory,
    encryptionMaterial: params.encryptionMaterial,
  });
  const callRpc = params.callMachineRpcFn ?? callMachineRpc;
  const workspaceMaterializer = createTwinSessionWorkspaceMaterializer({
    reviewRoot: params.config.reviewRoot,
    controllerMachineId: params.controllerMachineId,
    workers: params.config.workers,
    credentials: params.credentials,
    ...(params.updateSessionMetadata ? { updateSessionMetadata: params.updateSessionMetadata } : {}),
  });
  const scheduler = createTwinSessionScheduler({
    controllerMachineId: params.controllerMachineId,
    store,
    resolveWorker: (workerId) => params.config.workers[workerId] ?? null,
    // The default worker is the controller itself in production config, so it is tried first.
    autoWorkerOrder: () => [
      params.config.defaultWorkerId,
      ...Object.keys(params.config.workers).filter((workerId) => workerId !== params.config.defaultWorkerId),
    ],
    acquireLease: async (input) => await leaseClient.acquire(input),
    readLease: async (input) => await leaseClient.read(input),
    releaseLease: async (input) => await leaseClient.release(input),
    forgetLease: async (input) => await leaseClient.forget(input),
    prepareWorkspace: workspaceMaterializer.prepare,
    finalizeWorkspace: workspaceMaterializer.finalize,
    spawnTarget: async (input) => parseSpawnResult(await callRpc({
      credentials: params.credentials,
      machineId: input.machineId,
      method: RPC_METHODS.DAEMON_SCHEDULED_SESSION_SPAWN_TARGET_V1,
      request: { options: input.options, lease: input.lease },
    })),
    resolveTargetSpawn: async (input) => parseSpawnResolution(await callRpc({
      credentials: params.credentials,
      machineId: input.machineId,
      method: RPC_METHODS.DAEMON_SCHEDULED_SESSION_RESOLVE_TARGET_V1,
      request: { spawnNonce: input.spawnNonce },
    })),
    createOwnerToken: randomUUID,
    sealReleaseReceipt: ({ attempt, sessionId }) => sealAccountScopedBlobCiphertext({
      kind: 'twin_session_release_receipt',
      material: params.encryptionMaterial,
      payload: {
        v: 1,
        purpose: 'twin_session_release_ack',
        attemptLookupId: attempt.spawnNonce,
        leaseId: attempt.leaseId,
        sessionId,
      } satisfies TwinSessionReleaseReceiptPayload,
      randomBytes: (length) => new Uint8Array(nodeRandomBytes(length)),
    }),
    openReleaseReceipt: (receipt) => {
      const opened = openAccountScopedBlobCiphertext({
        kind: 'twin_session_release_receipt',
        material: params.encryptionMaterial,
        ciphertext: receipt,
      });
      if (!opened) return null;
      const parsed = ReleaseReceiptPayloadSchema.safeParse(opened.value);
      return parsed.success ? parsed.data : null;
    },
  });
  let loop: SingleFlightIntervalLoopHandle | null = null;
  return {
    ...scheduler,
    start: async () => {
      if (loop) return;
      await scheduler.recover();
      loop = startSingleFlightIntervalLoop({
        intervalMs: params.config.pollIntervalMs,
        task: scheduler.recover,
        onError: (error) => params.logWarning('Twin session scheduler recovery failed', error),
        unref: true,
      });
    },
    stop: () => {
      loop?.stop();
      loop = null;
    },
  };
}
