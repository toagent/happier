import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { selectExecutionPolicy } from "./execution-policy.mjs";
import {
  REMOTE_HELPER_TIMEOUT_MS,
  SNAPSHOT_PREPARATION_TIMEOUT_MS,
  remoteStartTimeoutMs,
} from "./operation-timeouts.mjs";
import {
  assertCollaborationClosable,
  boundedMcpWaitSeconds,
  parseKeyValueOutput,
} from "./collaboration-policy.mjs";
import { canonicalRealPath } from "./workspace-paths.mjs";

const SSH_HOST = process.env.TWIN_AGENT_SSH_HOST || "twin-dev";
const configuredWorkspaceRoots =
  process.env.TWIN_AGENT_ALLOWED_ROOTS ||
  process.env.TWIN_AGENT_LOCAL_WORKSPACE ||
  "/Users/yong/work/_mcp_workspace";
const ALLOWED_WORKSPACES = [
  ...new Set(
    configuredWorkspaceRoots
      .split(path.delimiter)
      .filter(Boolean)
      .map((root) => canonicalRealPath(root)),
  ),
];
const REMOTE_HELPER =
  process.env.TWIN_AGENT_REMOTE_HELPER ||
  "/Users/yong/.lan-dev-machine/bin/twin-agent-remote";
const REMOTE_BASE = process.env.TWIN_AGENT_REMOTE_BASE || "/Users/yong/.twin-agent";
const REMOTE_WORKSPACE_ROOT =
  process.env.TWIN_AGENT_REMOTE_WORKSPACE_ROOT || "/Users/yong/work/_mcp_workspace";
const LOCAL_ACTIVITY_DIR =
  process.env.TWIN_AGENT_ACTIVITY_DIR || "/Users/yong/.lan-dev-machine/twin-agent/activity";
const LOCAL_EVENTS_FILE = path.join(LOCAL_ACTIVITY_DIR, "events.jsonl");
const COLLABORATION_REPORT =
  process.env.TWIN_AGENT_COLLABORATION_REPORT ||
  "/Users/yong/.lan-dev-machine/twin-agent/collaboration-report.py";

const callerSchema = z.enum(["codex", "claude", "opencode"]);
const workerIdSchema = z.enum(["twin-control", "twin-dev", "mac-mini"]);
const collaborationIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  .describe("一次本机主任务的稳定标识；同一主任务的多次远端委派必须复用同一个值");

function recordLocalEvent(event) {
  mkdirSync(LOCAL_ACTIVITY_DIR, { recursive: true, mode: 0o700 });
  appendFileSync(
    LOCAL_EVENTS_FILE,
    `${JSON.stringify({ schema_version: 1, timestamp: new Date().toISOString(), ...event })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function text(content, isError = false) {
  return { content: [{ type: "text", text: content }], ...(isError ? { isError: true } : {}) };
}

function shell(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    let timedOut = false;
    let killTimer = null;
    const timeoutMs = options.timeoutMs || 120_000;
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 5_000);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const result = {
        code: code ?? 128,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (timedOut) {
        reject(Object.assign(new Error(`${command} timed out after ${timeoutMs}ms`), result));
      } else if (result.code === 0) resolve(result);
      else reject(Object.assign(new Error(result.stderr || result.stdout || `${command} failed`), result));
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[A-Za-z0-9_=-]{32,}/g, "<redacted>").slice(0, 4000);
}

async function gitRoot(cwd) {
  const result = await shell("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    timeoutMs: 10_000,
  });
  return canonicalRealPath(result.stdout.trim());
}

async function gitHead(root) {
  try {
    const result = await shell("git", ["-C", root, "rev-parse", "--verify", "HEAD"], {
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  } catch {
    return "UNBORN";
  }
}

function localWorkspaceFor(candidate) {
  for (const workspace of ALLOWED_WORKSPACES) {
    const relative = path.relative(workspace, candidate);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) return workspace;
  }
  return null;
}

function assertWithinLocalWorkspace(candidate) {
  const workspace = localWorkspaceFor(candidate);
  if (workspace) return workspace;
  throw new Error(`cwd 必须位于白名单目录内: ${ALLOWED_WORKSPACES.join(", ")}`);
}

function existingRealPath(candidate) {
  try {
    const resolved = canonicalRealPath(candidate);
    statSync(resolved);
    return resolved;
  } catch {
    return null;
  }
}

function resolveWorkspaceMode(requestedMode, cwd) {
  if (requestedMode !== "auto") return requestedMode;
  if (!cwd) return "local_snapshot";
  const resolved = existingRealPath(cwd);
  return resolved && localWorkspaceFor(resolved) ? "local_snapshot" : "remote_workspace";
}

function remoteWorkspaceRelative(cwd, id) {
  const requested = (cwd || `task-${id}`).trim();
  if (!requested) throw new Error("remote_workspace 的 cwd 不能为空");

  let relative = requested;
  if (path.posix.isAbsolute(requested)) {
    const fromRemoteRoot = path.posix.relative(REMOTE_WORKSPACE_ROOT, requested);
    relative =
      fromRemoteRoot && !fromRemoteRoot.startsWith("..") && !path.posix.isAbsolute(fromRemoteRoot)
        ? fromRemoteRoot
        : path.posix.basename(requested);
  }

  const normalized = path.posix.normalize(relative);
  const segments = normalized.split("/");
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    path.posix.isAbsolute(normalized) ||
    normalized.startsWith("../") ||
    segments.some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))
  ) {
    throw new Error("remote_workspace 的 cwd 只能包含安全的相对目录名");
  }
  return normalized;
}

function jobId() {
  const now = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `${now}-${randomBytes(3).toString("hex")}`;
}

async function remoteHelper(...args) {
  return shell("ssh", ["-o", "BatchMode=yes", SSH_HOST, REMOTE_HELPER, ...args], {
    timeoutMs: REMOTE_HELPER_TIMEOUT_MS,
  });
}

async function remoteHelperTimed(timeoutMs, ...args) {
  return shell("ssh", ["-o", "BatchMode=yes", SSH_HOST, REMOTE_HELPER, ...args], {
    timeoutMs,
  });
}

function collaborationJobIds(collaborationId, caller) {
  let lines = [];
  try {
    lines = readFileSync(LOCAL_EVENTS_FILE, "utf8").split("\n");
  } catch {
    return [];
  }
  const ids = new Set();
  for (const line of lines) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (
        event.collaboration_id === collaborationId &&
        event.caller === caller &&
        event.action === "delegate_submitted" &&
        event.job_id
      ) {
        ids.add(event.job_id);
      }
    } catch {
      // Ignore incomplete historical lines; append-only writes keep later events readable.
    }
  }
  return [...ids];
}

function recordCollection(metadata, output) {
  const values = parseKeyValueOutput(output);
  if (values.newly_collected !== "1") return;
  recordLocalEvent({
    collaboration_id: metadata.collaboration_id || `legacy-${metadata.job_id}`,
    caller: metadata.caller || "unknown",
    action: "remote_result_collected",
    task_title: metadata.task_title || "历史远端任务",
    summary: "已回收远端终态结果",
    job_id: metadata.job_id,
    remote_agent: values.effective_agent || metadata.agent || "unknown",
    result_collected_at: values.result_collected_at,
    control_host: hostname(),
  });
}

async function readJobMetadata(id) {
  const metadata = await readRemoteJobMetadata(id);
  const workspaceMode = metadata.workspace_mode || "local_snapshot";
  if (workspaceMode !== "local_snapshot" || !metadata.local_root) {
    throw new Error("remote_workspace 任务没有可应用到本机的 patch");
  }
  const root = canonicalRealPath(metadata.local_root);
  assertWithinLocalWorkspace(root);
  return { metadata, root };
}

async function readRemoteJobMetadata(id) {
  const remotePath = `${REMOTE_BASE}/jobs/${id}/metadata.json`;
  const result = await shell("ssh", [SSH_HOST, "cat", remotePath], { timeoutMs: 15_000 });
  return JSON.parse(result.stdout);
}

async function fetchPatch(id) {
  const { metadata, root } = await readJobMetadata(id);
  const result = await shell(
    "ssh",
    [SSH_HOST, "cat", `${REMOTE_BASE}/jobs/${id}/changes.patch`],
    { timeoutMs: 60_000 },
  );
  const patchDir = "/Users/yong/.lan-dev-machine/twin-agent/patches";
  mkdirSync(patchDir, { recursive: true, mode: 0o700 });
  const patchPath = `${patchDir}/${id}.patch`;
  writeFileSync(patchPath, result.stdout, { mode: 0o600 });
  return { metadata, root, patchPath, bytes: Buffer.byteLength(result.stdout) };
}

async function waitForJob(id, waitSeconds) {
  const waitSliceSeconds = boundedMcpWaitSeconds(waitSeconds);
  const output = (
    await remoteHelperTimed(
      (waitSliceSeconds + 10) * 1000,
      "wait",
      id,
      String(waitSliceSeconds),
      "30000",
    )
  ).stdout.trim();
  return [
    output,
    `wait_requested_seconds=${waitSeconds}`,
    `wait_slice_seconds=${waitSliceSeconds}`,
    `wait_capped=${waitSliceSeconds < waitSeconds ? 1 : 0}`,
  ].join("\n");
}

const server = new McpServer({ name: "twin-agent", version: "1.0.0" });

server.registerTool(
  "collaboration_event",
  {
    description:
      "记录本机控制面的协同任务开始、进展或结束。首次远端委派前记录 start，最终回复前记录 finish，用于统计本机做了什么和本机协同墙钟耗时。",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      collaboration_id: collaborationIdSchema,
      caller: callerSchema.describe("发起本机协同的 AI 客户端"),
      action: z.enum(["start", "update", "finish"]),
      task_title: z.string().min(1).max(200),
      summary: z.string().min(1).max(1000).describe("本机已做或正在做的工作摘要"),
      outcome: z.enum(["success", "partial", "failed", "cancelled"]).optional(),
    },
  },
  async ({ collaboration_id, caller, action, task_title, summary, outcome }) => {
    try {
      if (action === "finish" && !outcome) {
        throw new Error("finish 事件必须提供 outcome");
      }
      if (action === "finish") {
        const jobIds = collaborationJobIds(collaboration_id, caller);
        if (jobIds.length > 0) {
          const remoteState = await remoteHelper("collaboration-state", collaboration_id, caller);
          assertCollaborationClosable(parseKeyValueOutput(remoteState.stdout), jobIds.length);
        }
      }
      recordLocalEvent({
        collaboration_id,
        caller,
        action,
        task_title,
        summary,
        ...(outcome ? { outcome } : {}),
        control_host: hostname(),
      });
      return text(
        `collaboration_id=${collaboration_id}\naction=${action}\ncaller=${caller}\nrecorded_at=${new Date().toISOString()}`,
      );
    } catch (error) {
      return text(`记录协同事件失败: ${safeError(error)}`, true);
    }
  },
);

server.registerTool(
  "delegate_agent",
  {
    description:
      "把任务异步委派给统一 FIFO 管理的 twin-control、twin-dev 或 mac-mini worker。支持本机源码隔离快照和 worker 持久工作区；返回 job_id 后用 job_status 和 job_result 回收结果。",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      prompt: z.string().min(1).describe("给远端子 Agent 的完整任务说明"),
      collaboration_id: collaborationIdSchema,
      caller: callerSchema.describe("发起委派的本机 AI 客户端"),
      task_title: z.string().min(1).max(200).describe("用户可读的主任务名称"),
      local_work: z
        .string()
        .min(1)
        .max(1000)
        .describe("本机 Agent 在远端任务运行期间负责的工作；禁止写入秘密或隐私内容"),
      agent: z.enum(["auto", "codex", "claude", "opencode"]).default("auto"),
      task_type: z
        .enum(["general", "implementation", "test", "code_review", "architecture", "research", "operations"])
        .default("general")
        .describe("任务类型；auto 路由据此选择远端 Agent"),
      complexity: z.enum(["short", "standard", "long"]).default("standard"),
      model: z
        .string()
        .regex(/^(auto|default|[A-Za-z0-9][A-Za-z0-9._:/-]{0,99})$/)
        .default("auto")
        .describe("默认 auto；自动路由到 Claude 时使用 sonnet"),
      timeout_seconds: z.number().int().min(60).max(7200).optional(),
      idle_timeout_seconds: z.number().int().min(30).max(7200).optional(),
      fallback_agent: z.enum(["auto", "none", "codex", "claude", "opencode"]).default("auto"),
      max_attempts: z.number().int().min(1).max(2).optional(),
      mode: z.enum(["read_only", "write"]).default("read_only"),
      workspace_mode: z
        .enum(["auto", "local_snapshot", "remote_workspace"])
        .default("auto")
        .describe(
          "auto: 白名单内现有本机目录走快照，否则走开发机工作区；local_snapshot: 上传本机 Git 项目；remote_workspace: 在开发机 _mcp_workspace 下直接工作",
        ),
      cwd: z
        .string()
        .optional()
        .describe(
          "local_snapshot 时为本机 Git 目录；remote_workspace 时为开发机工作区名或任意同名路径，目录不存在会自动创建",
        ),
      worker_id: workerIdSchema
        .default("twin-dev")
        .describe("执行 worker；三台机器共享 queue owner 的同一个 FIFO 和总计 3 个运行槽位"),
      wait_seconds: z.number().int().min(0).max(120).default(0),
    },
  },
  async ({
    prompt,
    collaboration_id,
    caller,
    task_title,
    local_work,
    agent,
    task_type,
    complexity,
    model,
    timeout_seconds,
    idle_timeout_seconds,
    fallback_agent,
    max_attempts,
    mode,
    workspace_mode,
    cwd,
    worker_id,
    wait_seconds,
  }) => {
    let id = null;
    try {
      id = jobId();
      const createdAt = new Date().toISOString();
      const policy = selectExecutionPolicy({
        agent,
        taskType: task_type,
        complexity,
        model,
        timeoutSeconds: timeout_seconds,
        idleTimeoutSeconds: idle_timeout_seconds,
        mode,
        fallbackAgent: fallback_agent,
        maxAttempts: max_attempts,
      });
      recordLocalEvent({
        collaboration_id,
        caller,
        action: "delegate_requested",
        task_title,
        local_work,
        job_id: id,
        requested_agent: policy.requestedAgent,
        remote_agent: policy.selectedAgent,
        task_type: policy.taskType,
        complexity: policy.complexity,
        model: policy.selectedModel,
        timeout_seconds: policy.timeoutSeconds,
        idle_timeout_seconds: policy.idleTimeoutSeconds,
        fallback_agent: policy.fallbackAgent,
        max_attempts: policy.maxAttempts,
        primary_timeout_seconds: policy.primaryTimeoutSeconds,
        mode,
        worker_id,
        control_host: hostname(),
      });
      const workspaceMode = resolveWorkspaceMode(workspace_mode, cwd);
      const remoteJob = `${REMOTE_BASE}/jobs/${id}`;
      let root = null;
      let requestedCwd = null;
      let localHead = null;
      let helperCwd;
      let remoteWorkspace;
      let snapshotFiles = null;

      if (workspaceMode === "local_snapshot") {
        requestedCwd = canonicalRealPath(cwd || process.cwd());
        statSync(requestedCwd);
        assertWithinLocalWorkspace(requestedCwd);
        root = await gitRoot(requestedCwd);
        assertWithinLocalWorkspace(root);
        helperCwd = path.relative(root, requestedCwd) || ".";
        localHead = await gitHead(root);
        remoteWorkspace = `${remoteJob}/workspace`;
        snapshotFiles = await shell(
          "git",
          ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
          { timeoutMs: 30_000 },
        );
      } else {
        helperCwd = remoteWorkspaceRelative(cwd, id);
        remoteWorkspace = path.posix.join(REMOTE_WORKSPACE_ROOT, helperCwd);
      }

      await shell("ssh", [SSH_HOST, "mkdir", "-p", remoteJob], {
        timeoutMs: 15_000,
      });

      if (workspaceMode === "local_snapshot") {
        await shell("ssh", [SSH_HOST, "mkdir", "-p", remoteWorkspace], {
          timeoutMs: 15_000,
        });
        await shell(
          "rsync",
          [
            "-a",
            "--from0",
            "--files-from=-",
            "--exclude=.git",
            "--exclude=.context",
            "--exclude=.idea",
            "--exclude=.vscode",
            "--exclude=node_modules",
            "--exclude=target",
            "--exclude=build",
            "--exclude=dist",
            "--exclude=.next",
            "--exclude=.nuxt",
            "--exclude=.cache",
            "--exclude=.gradle",
            "--exclude=.venv",
            "--exclude=venv",
            "--exclude=__pycache__",
            "--exclude=.pytest_cache",
            `${root}/`,
            `${SSH_HOST}:${remoteWorkspace}/`,
          ],
          { input: snapshotFiles.stdout, timeoutMs: SNAPSHOT_PREPARATION_TIMEOUT_MS },
        );
        await shell(
          "ssh",
          [SSH_HOST, "sh", "-c", `umask 077; cat > '${remoteJob}/snapshot-files.z'`],
          { input: snapshotFiles.stdout, timeoutMs: 30_000 },
        );
      }

      const taskHeader = [
        "你是本机 AI 通过统一调度队列委派到三机 worker 的子 Agent。",
        `任务模式: ${mode}`,
        `工作区模式: ${workspaceMode}`,
        `执行 worker: ${worker_id}`,
        workspaceMode === "local_snapshot"
          ? "只处理当前隔离快照内的项目。"
          : `只处理目标 worker 的持久工作目录请求 ${helperCwd}，不得读取其他项目目录。`,
        "禁止读取 iCloud、_private、钥匙串、浏览器资料或其他个人目录。",
        mode === "read_only"
          ? "只读分析：禁止修改文件。给出结论、证据和建议验证命令。"
          : workspaceMode === "local_snapshot"
            ? "可修改隔离副本：完成修改和最小验证；不要 git push。最终说明改动、测试和剩余风险。"
            : "可修改开发机工作目录：完成修改和最小验证；不要 git push。最终说明改动、测试和剩余风险。",
        "",
        prompt,
      ].join("\n");
      await shell(
        "ssh",
        [SSH_HOST, "sh", "-c", `umask 077; cat > '${remoteJob}/prompt.txt'`],
        { input: taskHeader, timeoutMs: 15_000 },
      );
      const metadata = JSON.stringify({
        job_id: id,
        collaboration_id,
        caller,
        task_title,
        local_work,
        control_host: hostname(),
        requested_agent: policy.requestedAgent,
        agent: policy.selectedAgent,
        task_type: policy.taskType,
        complexity: policy.complexity,
        model: policy.selectedModel,
        timeout_seconds: policy.timeoutSeconds,
        idle_timeout_seconds: policy.idleTimeoutSeconds,
        fallback_agent: policy.fallbackAgent,
        max_attempts: policy.maxAttempts,
        primary_timeout_seconds: policy.primaryTimeoutSeconds,
        mode,
        worker_id,
        workspace_mode: workspaceMode,
        local_root: root,
        local_head: localHead,
        local_cwd: requestedCwd,
        remote_workspace_relative: workspaceMode === "remote_workspace" ? helperCwd : null,
        remote_cwd:
          workspaceMode === "local_snapshot"
            ? path.posix.join(remoteWorkspace, helperCwd)
            : worker_id === "twin-dev"
              ? remoteWorkspace
              : null,
        created_at: createdAt,
      });
      await shell(
        "ssh",
        [SSH_HOST, "sh", "-c", `umask 077; cat > '${remoteJob}/metadata.json'`],
        { input: metadata, timeoutMs: 15_000 },
      );
      const started = await remoteHelperTimed(
        remoteStartTimeoutMs(workspaceMode),
        "start",
        id,
        policy.selectedAgent,
        mode,
        workspaceMode,
        helperCwd,
        worker_id,
      );
      const status = wait_seconds > 0 ? await waitForJob(id, wait_seconds) : started.stdout.trim();
      recordLocalEvent({
        collaboration_id,
        caller,
        action: "delegate_submitted",
        task_title,
        local_work,
        job_id: id,
        requested_agent: policy.requestedAgent,
        remote_agent: policy.selectedAgent,
        task_type: policy.taskType,
        complexity: policy.complexity,
        model: policy.selectedModel,
        timeout_seconds: policy.timeoutSeconds,
        idle_timeout_seconds: policy.idleTimeoutSeconds,
        fallback_agent: policy.fallbackAgent,
        max_attempts: policy.maxAttempts,
        primary_timeout_seconds: policy.primaryTimeoutSeconds,
        mode,
        worker_id,
        workspace_mode: workspaceMode,
        control_host: hostname(),
      });
      const workspaceSummary =
        workspaceMode === "local_snapshot"
          ? `local_root=${root}\nqueue_snapshot=${remoteWorkspace}\n实际 execution_cwd 由 job_status 回报`
          : `remote_workspace_request=${helperCwd}\n本机源码未上传；实际 execution_cwd 由 job_status 回报`;
      if (status.includes("newly_collected=1")) {
        recordCollection(JSON.parse(metadata), status);
      }
      return text(
        `${status}\ncollaboration_id=${collaboration_id}\ncaller=${caller}\ntask_title=${task_title}\nlocal_work=${local_work}\nrequested_agent=${policy.requestedAgent}\nselected_agent=${policy.selectedAgent}\nworker_id=${worker_id}\ntask_type=${policy.taskType}\ncomplexity=${policy.complexity}\nmodel=${policy.selectedModel}\ntimeout_seconds=${policy.timeoutSeconds}\nidle_timeout_seconds=${policy.idleTimeoutSeconds}\nfallback_agent=${policy.fallbackAgent}\nmax_attempts=${policy.maxAttempts}\nprimary_timeout_seconds=${policy.primaryTimeoutSeconds}\nworkspace_mode=${workspaceMode}\n${workspaceSummary}\n任务未完成时调用 wait_job，已结束时调用 job_result；也可用 collect_ready_results 批量回收。`,
      );
    } catch (error) {
      try {
        recordLocalEvent({
          collaboration_id,
          caller,
          action: "delegate_failed",
          task_title,
          local_work,
          ...(id ? { job_id: id } : {}),
          requested_agent: agent,
          remote_agent: agent,
          mode,
          error: safeError(error),
          control_host: hostname(),
        });
      } catch {
        // Preserve the original delegation error if local observability storage also fails.
      }
      return text(`委派失败: ${safeError(error)}`, true);
    }
  },
);

server.registerTool(
  "collaboration_stats",
  {
    description:
      "按日期或 collaboration_id 汇总本机与开发机协同效率：本机工作、远端任务数、成功率、取消率、排队时间和运行耗时。",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      date: z
        .string()
        .regex(/^(all|[0-9]{4}-[0-9]{2}-[0-9]{2})$/)
        .optional()
        .describe("统计日期 YYYY-MM-DD；默认 Asia/Taipei 的今天；all 表示全部历史"),
      timezone: z.string().default("Asia/Taipei"),
      collaboration_id: collaborationIdSchema.optional(),
      caller: callerSchema.optional(),
      include_jobs: z.boolean().default(false),
      format: z.enum(["text", "json"]).default("text"),
    },
  },
  async ({ date, timezone, collaboration_id, caller, include_jobs, format }) => {
    try {
      const args = [COLLABORATION_REPORT];
      if (date) args.push(date);
      args.push("--timezone", timezone, "--format", format);
      if (collaboration_id) args.push("--collaboration-id", collaboration_id);
      if (caller) args.push("--caller", caller);
      if (include_jobs) args.push("--include-jobs");
      const report = await shell("python3", args, { timeoutMs: 90_000 });
      return text(report.stdout.trim());
    } catch (error) {
      return text(`生成协同统计失败: ${safeError(error)}`, true);
    }
  },
);

server.registerTool(
  "evaluate_job",
  {
    description:
      "本机回收并核对远端结果后记录质量验收。进程退出码 0 不等于任务有效成功；必须标记 accepted、partial 或 rejected。",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      job_id: z.string().regex(/^[0-9]{14}-[a-f0-9]{6}$/),
      collaboration_id: collaborationIdSchema,
      caller: callerSchema,
      verdict: z.enum(["accepted", "partial", "rejected"]),
      summary: z.string().min(1).max(1000).describe("本机核对结论及主要证据，禁止写入秘密或隐私"),
    },
  },
  async ({ job_id, collaboration_id, caller, verdict, summary }) => {
    try {
      const metadata = await readRemoteJobMetadata(job_id);
      if (metadata.collaboration_id && metadata.collaboration_id !== collaboration_id) {
        throw new Error(
          `collaboration_id 不匹配: job=${metadata.collaboration_id} request=${collaboration_id}`,
        );
      }
      if (metadata.caller && metadata.caller !== caller) {
        throw new Error(`caller 不匹配: job=${metadata.caller} request=${caller}`);
      }
      const evaluation = {
        schema_version: 1,
        job_id,
        collaboration_id,
        caller,
        verdict,
        summary,
        evaluated_at: new Date().toISOString(),
        control_host: hostname(),
      };
      await shell(
        "ssh",
        [SSH_HOST, "sh", "-c", `umask 077; cat > '${REMOTE_BASE}/jobs/${job_id}/evaluation.json'`],
        { input: JSON.stringify(evaluation), timeoutMs: 15_000 },
      );
      const archived = await remoteHelper("evaluate", job_id);
      recordLocalEvent({
        collaboration_id,
        caller,
        action: "remote_evaluated",
        task_title: metadata.task_title || "历史远端任务",
        summary,
        job_id,
        verdict,
        remote_agent: metadata.agent || "unknown",
        control_host: hostname(),
      });
      return text(archived.stdout.trim());
    } catch (error) {
      return text(`记录远端验收失败: ${safeError(error)}`, true);
    }
  },
);

server.registerTool(
  "job_status",
  {
    description: "查询远端子 Agent 任务状态。",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: { job_id: z.string().regex(/^[0-9]{14}-[a-f0-9]{6}$/) },
  },
  async ({ job_id }) => {
    try {
      return text((await remoteHelper("status", job_id)).stdout.trim());
    } catch (error) {
      return text(`查询失败: ${safeError(error)}`, true);
    }
  },
);

server.registerTool(
  "wait_job",
  {
    description:
      "等待一个远端任务进入终态；单次最多阻塞 40 秒，完成后登记结果回收，未完成则返回最新进度。可重复调用以替代高频轮询。",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      job_id: z.string().regex(/^[0-9]{14}-[a-f0-9]{6}$/),
      wait_seconds: z.number().int().min(1).max(7200).default(60),
      max_chars: z.number().int().min(1000).max(100000).default(30000),
    },
  },
  async ({ job_id, wait_seconds, max_chars }) => {
    try {
      const metadata = await readRemoteJobMetadata(job_id);
      const waitSliceSeconds = boundedMcpWaitSeconds(wait_seconds);
      const result = await remoteHelperTimed(
        (waitSliceSeconds + 10) * 1000,
        "wait",
        job_id,
        String(waitSliceSeconds),
        String(max_chars),
      );
      recordCollection(metadata, result.stdout);
      return text(
        [
          result.stdout.trim(),
          `wait_requested_seconds=${wait_seconds}`,
          `wait_slice_seconds=${waitSliceSeconds}`,
          `wait_capped=${waitSliceSeconds < wait_seconds ? 1 : 0}`,
        ].join("\n"),
      );
    } catch (error) {
      return text(`等待失败: ${safeError(error)}`, true);
    }
  },
);

server.registerTool(
  "job_result",
  {
    description: "读取已完成任务的最终答复、退出码、工作区状态和 patch。",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      job_id: z.string().regex(/^[0-9]{14}-[a-f0-9]{6}$/),
      max_chars: z.number().int().min(1000).max(100000).default(30000),
    },
  },
  async ({ job_id, max_chars }) => {
    try {
      const metadata = await readRemoteJobMetadata(job_id);
      const result = await remoteHelper("result", job_id, String(max_chars));
      recordCollection(metadata, result.stdout);
      return text(result.stdout);
    } catch (error) {
      return text(`读取失败: ${safeError(error)}`, true);
    }
  },
);

server.registerTool(
  "collect_ready_results",
  {
    description:
      "批量回收已经进入终态但尚未读取的远端任务结果。可按 collaboration_id 或 caller 过滤。",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      collaboration_id: collaborationIdSchema.optional(),
      caller: callerSchema.optional(),
      limit: z.number().int().min(1).max(20).default(10),
      max_chars: z.number().int().min(1000).max(30000).default(10000),
    },
  },
  async ({ collaboration_id, caller, limit, max_chars }) => {
    try {
      const pending = await remoteHelper(
        "pending",
        collaboration_id || "-",
        caller || "-",
        String(limit),
      );
      const ids = [...pending.stdout.matchAll(/^job_id=([0-9]{14}-[a-f0-9]{6})\b/gm)].map(
        (match) => match[1],
      );
      if (ids.length === 0) return text("ready=0\n没有待回收的终态结果");

      const sections = [];
      for (const id of ids) {
        const metadata = await readRemoteJobMetadata(id);
        const result = await remoteHelper("result", id, String(max_chars));
        recordCollection(metadata, result.stdout);
        sections.push(`===== ${id} =====\n${result.stdout.trim()}`);
      }
      return text(`ready=${ids.length}\n${sections.join("\n\n")}`);
    } catch (error) {
      return text(`批量回收失败: ${safeError(error)}`, true);
    }
  },
);

server.registerTool(
  "fetch_job_patch",
  {
    description:
      "把远端任务的完整 patch 下载到本机安全目录并执行 git apply --check；不修改项目文件。适合 job_result 输出被截断时使用。",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: { job_id: z.string().regex(/^[0-9]{14}-[a-f0-9]{6}$/) },
  },
  async ({ job_id }) => {
    try {
      const { root, patchPath, bytes } = await fetchPatch(job_id);
      if (bytes === 0) return text(`job_id=${job_id}\npatch 为空，没有可应用的改动。`);
      const check = await shell("git", ["-C", root, "apply", "--check", patchPath], {
        timeoutMs: 30_000,
      });
      return text(
        `job_id=${job_id}\npatch=${patchPath}\nbytes=${bytes}\nlocal_root=${root}\napply_check=ok${check.stdout}`,
      );
    } catch (error) {
      return text(`下载或校验失败: ${safeError(error)}`, true);
    }
  },
);

server.registerTool(
  "apply_job_patch",
  {
    description:
      "将远端子 Agent patch 应用到本机原项目。默认 dry_run=true，只校验；仅当本机 HEAD 与委派时一致且 git apply --check 通过才允许实际应用。不会提交或 push。",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      job_id: z.string().regex(/^[0-9]{14}-[a-f0-9]{6}$/),
      dry_run: z.boolean().default(true),
    },
  },
  async ({ job_id, dry_run }) => {
    try {
      const { metadata, root, patchPath, bytes } = await fetchPatch(job_id);
      if (bytes === 0) return text(`job_id=${job_id}\npatch 为空，没有可应用的改动。`);
      const currentHead = await gitHead(root);
      if (currentHead !== metadata.local_head) {
        throw new Error(
          `本机 HEAD 已变化，拒绝自动应用。委派时=${metadata.local_head} 当前=${currentHead}`,
        );
      }
      await shell("git", ["-C", root, "apply", "--check", patchPath], { timeoutMs: 30_000 });
      if (dry_run) {
        return text(`job_id=${job_id}\ndry_run=true\napply_check=ok\npatch=${patchPath}\nlocal_root=${root}`);
      }
      await shell("git", ["-C", root, "apply", patchPath], { timeoutMs: 30_000 });
      const status = await shell("git", ["-C", root, "status", "--short"], { timeoutMs: 10_000 });
      return text(`job_id=${job_id}\napplied=true\nlocal_root=${root}\n--- git status ---\n${status.stdout}`);
    } catch (error) {
      return text(`应用失败: ${safeError(error)}`, true);
    }
  },
);

server.registerTool(
  "cancel_job",
  {
    description: "终止指定远端子 Agent 任务，不删除已产生的结果和 patch。",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    inputSchema: {
      job_id: z.string().regex(/^[0-9]{14}-[a-f0-9]{6}$/),
      reason: z
        .enum(["user_request", "superseded", "duplicate", "wrong_scope", "resource_pressure", "other"])
        .default("user_request"),
    },
  },
  async ({ job_id, reason }) => {
    try {
      return text((await remoteHelper("cancel", job_id, reason)).stdout.trim());
    } catch (error) {
      return text(`取消失败: ${safeError(error)}`, true);
    }
  },
);

server.registerTool(
  "list_jobs",
  {
    description: "列出最近的远端子 Agent 任务。",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: { limit: z.number().int().min(1).max(50).default(10) },
  },
  async ({ limit }) => {
    try {
      return text((await remoteHelper("list", String(limit))).stdout.trim() || "暂无任务");
    } catch (error) {
      return text(`列出失败: ${safeError(error)}`, true);
    }
  },
);

server.registerTool(
  "queue_status",
  {
    description: "查看三个本机 AI 共用的远端 FIFO 队列、运行数和统一并发上限。",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {},
  },
  async () => {
    try {
      return text((await remoteHelper("queue")).stdout.trim());
    } catch (error) {
      return text(`查询队列失败: ${safeError(error)}`, true);
    }
  },
);

server.registerTool(
  "twin_agent_health",
  {
    description: "检查开发机 SSH、tmux 和三个远端 AI CLI 的可用性。",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {},
  },
  async () => {
    try {
      return text((await remoteHelper("health")).stdout.trim());
    } catch (error) {
      return text(`健康检查失败: ${safeError(error)}`, true);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
