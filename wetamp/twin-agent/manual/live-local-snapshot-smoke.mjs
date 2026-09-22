#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = new URL("../", import.meta.url).pathname;
const project = process.argv[2];
const collaborationId = process.argv[3] || `local-snapshot-smoke-${Date.now()}`;

if (!project) {
  throw new Error("usage: live-local-snapshot-smoke.mjs <project> [collaboration-id]");
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["server.mjs"],
  cwd: root,
  stderr: "inherit",
});
const client = new Client({ name: "twin-agent-local-snapshot-smoke", version: "1.0.0" });

function resultText(result) {
  return (result.content || [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

async function call(name, args, timeout = 60_000) {
  const result = await client.callTool(
    { name, arguments: args },
    undefined,
    { timeout },
  );
  const output = resultText(result);
  if (result.isError) throw new Error(`${name}: ${output}`);
  return output;
}

function value(output, key) {
  const match = String(output).match(new RegExp(`^${key}=(.*)$`, "m"));
  return match ? match[1].trim() : null;
}

await client.connect(transport);
let jobId = null;
try {
  const delegated = await call(
    "delegate_agent",
    {
      prompt: "只读检查 package.json 的 name 字段，并在结论中原样包含 LOCAL_SNAPSHOT_OK。不要修改文件。",
      collaboration_id: collaborationId,
      caller: "codex",
      task_title: "Y700 生产链大仓快照验证",
      local_work: "本机验证新版快照准备预算并追踪 Happier session canonical owner",
      agent: "codex",
      task_type: "test",
      complexity: "short",
      timeout_seconds: 600,
      idle_timeout_seconds: 180,
      fallback_agent: "none",
      max_attempts: 1,
      mode: "read_only",
      workspace_mode: "local_snapshot",
      cwd: project,
      wait_seconds: 0,
    },
    360_000,
  );
  jobId = value(delegated, "job_id");
  if (!jobId) throw new Error(`delegate_agent 未返回 job_id: ${delegated}`);

  let status = delegated;
  const deadline = Date.now() + 600_000;
  while (["running", "queued"].includes(value(status, "state")) && Date.now() < deadline) {
    status = await call("wait_job", { job_id: jobId, wait_seconds: 40, max_chars: 8000 }, 55_000);
  }
  const result = await call("job_result", { job_id: jobId, max_chars: 12000 });
  const state = value(result, "state");
  const exitCode = value(result, "exit_code");
  const accepted = state === "finished" && exitCode === "0" && result.includes("LOCAL_SNAPSHOT_OK");
  await call("evaluate_job", {
    job_id: jobId,
    collaboration_id: collaborationId,
    caller: "codex",
    verdict: accepted ? "accepted" : "rejected",
    summary: accepted ? "大仓 local_snapshot 初始化与只读任务通过" : "大仓 local_snapshot 未返回预期标记",
  });
  console.log(JSON.stringify({ job_id: jobId, state, exit_code: exitCode, accepted }, null, 2));
  if (!accepted) process.exitCode = 1;
} catch (error) {
  if (jobId) {
    try {
      await call("cancel_job", { job_id: jobId, reason: "other" });
      await call("job_result", { job_id: jobId, max_chars: 8000 });
    } catch {
      // Preserve the original smoke-test failure.
    }
  }
  throw error;
} finally {
  await client.close();
}
