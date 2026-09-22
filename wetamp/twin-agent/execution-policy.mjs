const CLAUDE_AUTO_TASK_TYPES = new Set(["architecture", "research"]);

const DEFAULT_TIMEOUTS = {
  short: 600,
  standard: 1200,
  long: 1800,
};

const DEFAULT_IDLE_TIMEOUTS = {
  short: 180,
  standard: 300,
  long: 420,
};

const FALLBACK_PRIMARY_TIMEOUTS = {
  short: 240,
  standard: 480,
  long: 600,
};

export function selectExecutionPolicy({
  agent = "auto",
  taskType = "general",
  complexity = "standard",
  timeoutSeconds,
  idleTimeoutSeconds,
  model = "auto",
  mode = "read_only",
  fallbackAgent = "auto",
  maxAttempts,
}) {
  const selectedAgent =
    agent === "auto"
      ? CLAUDE_AUTO_TASK_TYPES.has(taskType) && complexity === "long"
        ? "claude"
        : "codex"
      : agent;

  let selectedModel = model;
  if (model === "auto") {
    selectedModel = selectedAgent === "claude" ? "sonnet" : "default";
  }

  let selectedFallback = fallbackAgent;
  if (fallbackAgent === "auto") {
    selectedFallback =
      mode === "read_only" && agent === "auto" && selectedAgent === "claude" ? "codex" : "none";
  }
  if (mode !== "read_only" || selectedFallback === selectedAgent) selectedFallback = "none";

  const selectedMaxAttempts = Math.max(
    1,
    Math.min(2, maxAttempts ?? (selectedFallback === "none" ? 1 : 2)),
  );
  const totalTimeout = timeoutSeconds ?? DEFAULT_TIMEOUTS[complexity];

  return {
    requestedAgent: agent,
    selectedAgent,
    taskType,
    complexity,
    selectedModel,
    timeoutSeconds: totalTimeout,
    idleTimeoutSeconds: idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUTS[complexity],
    fallbackAgent: selectedFallback,
    maxAttempts: selectedFallback === "none" ? 1 : selectedMaxAttempts,
    primaryTimeoutSeconds:
      selectedFallback === "none" ? totalTimeout : Math.min(totalTimeout, FALLBACK_PRIMARY_TIMEOUTS[complexity]),
  };
}
