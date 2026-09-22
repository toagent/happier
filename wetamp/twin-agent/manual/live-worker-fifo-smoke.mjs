#!/usr/bin/env node

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const runtime =
  process.env.TWIN_AGENT_LIVE_RUNTIME ||
  path.join(os.homedir(), ".lan-dev-machine", "twin-agent");
const collaborationId = process.argv[2] || `worker-fifo-live-${Date.now()}`;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["server.mjs"],
  cwd: runtime,
  stderr: "inherit",
});
const client = new Client({ name: "twin-agent-worker-fifo-smoke", version: "1.0.0" });
const jobs = [];

function resultText(result) {
  return (result.content || [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function value(output, key) {
  const match = String(output).match(new RegExp(`^${key}=(.*)$`, "m"));
  return match ? match[1].trim() : null;
}

async function call(name, args, timeout = 60_000) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout });
  const output = resultText(result);
  if (result.isError) throw new Error(`${name}: ${output}`);
  return output;
}

async function waitUntilTerminal(jobId, deadlineMs) {
  let output = "";
  while (Date.now() < deadlineMs) {
    output = await call(
      "wait_job",
      { job_id: jobId, wait_seconds: 40, max_chars: 12000 },
      55_000,
    );
    if (!["running", "queued", "unknown"].includes(value(output, "state"))) return output;
  }
  return output;
}

async function collectAndEvaluate(spec) {
  let output = await waitUntilTerminal(spec.jobId, Date.now() + 420_000);
  let state = value(output, "state");
  if (["running", "queued", "unknown"].includes(state)) {
    await call("cancel_job", { job_id: spec.jobId, reason: "other" });
  }
  output = await call("job_result", { job_id: spec.jobId, max_chars: 16000 });
  state = value(output, "state");
  const exitCode = value(output, "exit_code");
  const accepted = state === "finished" && exitCode === "0" && output.includes(spec.marker);
  await call("evaluate_job", {
    job_id: spec.jobId,
    collaboration_id: collaborationId,
    caller: "codex",
    verdict: accepted ? "accepted" : "rejected",
    summary: accepted
      ? `${spec.workerId}/${spec.agent} 返回预期 marker`
      : `${spec.workerId}/${spec.agent} 未通过真实任务验收`,
  });
  return {
    job_id: spec.jobId,
    worker_id: value(output, "worker_id"),
    execution_host: value(output, "execution_host"),
    execution_cwd: value(output, "execution_cwd"),
    requested_agent: spec.agent,
    effective_agent: value(output, "effective_agent"),
    state,
    exit_code: exitCode,
    accepted,
    queue_wait_seconds: value(output, "queue_wait_seconds"),
    run_seconds: value(output, "run_seconds"),
  };
}

await client.connect(transport);
let collaborationStarted = false;
try {
  const tools = await client.listTools();
  const delegate = tools.tools.find((item) => item.name === "delegate_agent");
  assert.ok(delegate, "delegate_agent is missing");
  assert.deepEqual(delegate.inputSchema.properties.worker_id.enum, [
    "twin-control",
    "twin-dev",
    "mac-mini",
  ]);
  assert.equal(delegate.inputSchema.properties.worker_id.default, "twin-dev");

  const initialQueue = await call("queue_status", {});
  assert.equal(value(initialQueue, "running"), "0", initialQueue);
  assert.equal(value(initialQueue, "queued"), "0", initialQueue);
  assert.equal(value(initialQueue, "max_concurrent"), "3", initialQueue);

  await call("collaboration_event", {
    collaboration_id: collaborationId,
    caller: "codex",
    action: "start",
    task_title: "三 worker 单 FIFO 真实验收",
    summary: "本机核对新 MCP schema、三 worker 执行身份、第四任务排队和结果回收",
  });
  collaborationStarted = true;

  const specs = [
    { workerId: "twin-control", agent: "codex", marker: "CONTROL_CODEX_OK" },
    { workerId: "twin-dev", agent: "claude", marker: "DEV_CLAUDE_OK", model: "sonnet" },
    { workerId: "mac-mini", agent: "opencode", marker: "MINI_OPENCODE_OK" },
    { workerId: "twin-control", agent: "codex", marker: "FIFO_FOURTH_OK" },
  ];

  const delegated = await Promise.all(
    specs.map(async (spec) => {
      const output = await call("delegate_agent", {
        prompt: `Use Bash to run sleep 20 once. After it exits, do not call more tools and reply exactly ${spec.marker}. Do not modify files.`,
        collaboration_id: collaborationId,
        caller: "codex",
        task_title: "三 worker 单 FIFO 真实验收",
        local_work: "本机观察统一队列、回收结果并核对实际执行主机",
        worker_id: spec.workerId,
        agent: spec.agent,
        task_type: "test",
        complexity: "short",
        model: spec.model || "default",
        timeout_seconds: 300,
        idle_timeout_seconds: 120,
        fallback_agent: "none",
        max_attempts: 1,
        mode: "read_only",
        workspace_mode: "remote_workspace",
        cwd: `twin-agent-live-${spec.workerId}-${spec.agent}`,
        wait_seconds: 0,
      });
      const jobId = value(output, "job_id");
      assert.ok(jobId, `delegate_agent(${spec.workerId}/${spec.agent}) returned no job_id`);
      assert.equal(value(output, "worker_id"), spec.workerId, output);
      const item = { ...spec, jobId, initial_state: value(output, "state") };
      jobs.push(item);
      return item;
    }),
  );

  const queueProof = await call("queue_status", {});
  assert.equal(value(queueProof, "running"), "3", queueProof);
  assert.equal(value(queueProof, "queued"), "1", queueProof);
  assert.equal(value(queueProof, "max_concurrent"), "3", queueProof);
  assert.equal(delegated[3].initial_state, "queued", JSON.stringify(delegated[3]));

  const results = await Promise.all(delegated.map(collectAndEvaluate));
  const allAccepted = results.every((item) => item.accepted);
  await call("collaboration_event", {
    collaboration_id: collaborationId,
    caller: "codex",
    action: "finish",
    task_title: "三 worker 单 FIFO 真实验收",
    summary: allAccepted
      ? "三 worker 真实任务均完成，第四任务按 FIFO 排队后执行"
      : "真实任务存在失败，所有任务已回收并完成质量标记",
    outcome: allAccepted ? "success" : "partial",
  });
  collaborationStarted = false;

  const stats = JSON.parse(
    await call("collaboration_stats", {
      collaboration_id: collaborationId,
      caller: "codex",
      include_jobs: true,
      format: "json",
    }),
  );
  console.log(
    JSON.stringify(
      {
        collaboration_id: collaborationId,
        runtime,
        queue_proof: {
          running: value(queueProof, "running"),
          queued: value(queueProof, "queued"),
          max_concurrent: value(queueProof, "max_concurrent"),
        },
        jobs: results,
        stats,
      },
      null,
      2,
    ),
  );
  if (!allAccepted) process.exitCode = 1;
} catch (error) {
  for (const job of jobs) {
    try {
      const status = await call("job_status", { job_id: job.jobId });
      if (["running", "queued", "unknown"].includes(value(status, "state"))) {
        await call("cancel_job", { job_id: job.jobId, reason: "other" });
      }
      await call("job_result", { job_id: job.jobId, max_chars: 8000 });
      await call("evaluate_job", {
        job_id: job.jobId,
        collaboration_id: collaborationId,
        caller: "codex",
        verdict: "rejected",
        summary: "真实 FIFO 验收中断后已取消或回收",
      });
    } catch {
      // Preserve the original failure; any unrecovered job remains visible in queue_status.
    }
  }
  if (collaborationStarted) {
    try {
      await call("collaboration_event", {
        collaboration_id: collaborationId,
        caller: "codex",
        action: "finish",
        task_title: "三 worker 单 FIFO 真实验收",
        summary: `验收失败：${error instanceof Error ? error.message : String(error)}`,
        outcome: "failed",
      });
    } catch {
      // The original error and queue state are the deciding evidence.
    }
  }
  throw error;
} finally {
  await client.close();
}
