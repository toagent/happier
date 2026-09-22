export function parseKeyValueOutput(output) {
  const values = {};
  for (const line of String(output || "").split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}

export const MAX_MCP_WAIT_SLICE_SECONDS = 40;

export function boundedMcpWaitSeconds(requestedSeconds) {
  const value = Number(requestedSeconds);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.trunc(value), MAX_MCP_WAIT_SLICE_SECONDS);
}

export function assertCollaborationClosable(state, expectedJobs = 0) {
  const total = Number(state.total || 0);
  const active = Number(state.active || 0);
  const uncollected = Number(state.uncollected || 0);
  if (![total, active, uncollected].every(Number.isFinite)) {
    throw new Error("开发机返回了无效的协同状态");
  }
  if (total < expectedJobs) {
    throw new Error(`远端任务记录不完整: 本机已提交=${expectedJobs} 开发机可见=${total}`);
  }
  if (active > 0) {
    throw new Error(
      `仍有远端任务未结束: queued=${state.queued || 0} running=${state.running || 0} unknown=${state.unknown || 0}`,
    );
  }
  if (uncollected > 0) {
    throw new Error(`仍有 ${uncollected} 个终态任务未回收；先调用 wait_job、job_result 或 collect_ready_results`);
  }
}
