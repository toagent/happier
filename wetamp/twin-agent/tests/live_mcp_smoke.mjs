#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = new URL("../", import.meta.url).pathname;
const collaborationId = process.argv[2] || `twin-agent-live-${Date.now()}`;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["server.mjs"],
  cwd: root,
  stderr: "inherit",
});
const client = new Client({ name: "twin-agent-live-smoke", version: "1.0.0" });

function resultText(result) {
  return (result.content || [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const output = resultText(result);
  if (result.isError) throw new Error(`${name}: ${output}`);
  return output;
}

async function waitUntilTerminal(jobId, deadlineMs) {
  let output = "";
  while (Date.now() < deadlineMs) {
    output = await call("wait_job", {
      job_id: jobId,
      wait_seconds: 40,
      max_chars: 8000,
    });
    const state = value(output, "state");
    if (!["running", "queued"].includes(state)) return output;
  }
  return output;
}

function value(output, key) {
  const match = String(output).match(new RegExp(`^${key}=(.*)$`, "m"));
  return match ? match[1].trim() : null;
}

await client.connect(transport);
try {
  await call("collaboration_event", {
    collaboration_id: collaborationId,
    caller: "codex",
    action: "start",
    task_title: "twin-agent 三 Agent 端到端验证",
    summary: "本机完成实现、部署并执行真实 Agent 验收",
  });

  const specs = [
    { agent: "codex", marker: "TWIN_CODEX_OK", model: "default" },
    { agent: "claude", marker: "TWIN_CLAUDE_OK", model: "sonnet" },
    { agent: "opencode", marker: "TWIN_OPENCODE_OK", model: "default" },
  ];
  const delegated = await Promise.all(
    specs.map(async (spec) => {
      const output = await call("delegate_agent", {
        prompt: `不要调用工具，不要修改文件，只回复 ${spec.marker}`,
        collaboration_id: collaborationId,
        caller: "codex",
        task_title: "twin-agent 三 Agent 端到端验证",
        local_work: "本机核对进度、最终输出、统计与回收门禁",
        agent: spec.agent,
        task_type: "general",
        complexity: "short",
        model: spec.model,
        timeout_seconds: 300,
        idle_timeout_seconds: 90,
        fallback_agent: "none",
        max_attempts: 1,
        mode: "read_only",
        workspace_mode: "remote_workspace",
        cwd: `twin-agent-live-smoke-${spec.agent}-20260915`,
        wait_seconds: 0,
      });
      const jobId = value(output, "job_id");
      if (!jobId) throw new Error(`delegate_agent(${spec.agent}) 未返回 job_id: ${output}`);
      return { ...spec, jobId };
    }),
  );

  const settled = await Promise.all(
    delegated.map(async (item) => {
      let output = await waitUntilTerminal(item.jobId, Date.now() + 300_000);
      let state = value(output, "state");
      if (state === "running" || state === "queued" || state === "unknown") {
        await call("cancel_job", { job_id: item.jobId, reason: "other" });
        output = await call("job_result", { job_id: item.jobId, max_chars: 8000 });
        state = value(output, "state");
      }
      const exitCode = value(output, "exit_code");
      const accepted = state === "finished" && exitCode === "0" && output.includes(item.marker);
      if (["finished", "failed", "cancelled"].includes(state)) {
        await call("evaluate_job", {
          job_id: item.jobId,
          collaboration_id: collaborationId,
          caller: "codex",
          verdict: accepted ? "accepted" : "rejected",
          summary: accepted ? `${item.agent} 返回预期 marker` : `${item.agent} 未返回预期 marker`,
        });
      }
      return {
        agent: item.agent,
        job_id: item.jobId,
        state,
        exit_code: exitCode,
        accepted,
        effective_agent: value(output, "effective_agent"),
        run_seconds: value(output, "run_seconds"),
        result_collection_delay_seconds: value(output, "result_collection_delay_seconds"),
      };
    }),
  );

  const allAccepted = settled.every((item) => item.accepted);
  await call("collaboration_event", {
    collaboration_id: collaborationId,
    caller: "codex",
    action: "finish",
    task_title: "twin-agent 三 Agent 端到端验证",
    summary: allAccepted ? "三种真实 Agent 均完成、回收并通过验收" : "端到端验证存在失败，已回收所有结果",
    outcome: allAccepted ? "success" : "partial",
  });
  const stats = await call("collaboration_stats", {
    collaboration_id: collaborationId,
    caller: "codex",
    include_jobs: true,
    format: "json",
  });
  console.log(JSON.stringify({ collaboration_id: collaborationId, jobs: settled, stats: JSON.parse(stats) }, null, 2));
  if (!allAccepted) process.exitCode = 1;
} finally {
  await client.close();
}
