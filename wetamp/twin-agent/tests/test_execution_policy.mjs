import assert from "node:assert/strict";
import test from "node:test";

import { selectExecutionPolicy } from "../execution-policy.mjs";

test("short and implementation tasks route to Codex", () => {
  const shortReview = selectExecutionPolicy({
    agent: "auto",
    taskType: "code_review",
    complexity: "short",
    model: "auto",
  });
  assert.equal(shortReview.selectedAgent, "codex");
  assert.equal(shortReview.selectedModel, "default");
  assert.equal(shortReview.timeoutSeconds, 600);

  const implementation = selectExecutionPolicy({
    agent: "auto",
    taskType: "implementation",
    complexity: "long",
    model: "auto",
  });
  assert.equal(implementation.selectedAgent, "codex");
  assert.equal(implementation.timeoutSeconds, 1800);
  assert.equal(implementation.fallbackAgent, "none");
});

test("only long architecture and research tasks route to Claude Sonnet", () => {
  const research = selectExecutionPolicy({
    agent: "auto",
    taskType: "research",
    complexity: "standard",
    model: "auto",
  });
  assert.equal(research.selectedAgent, "codex");
  assert.equal(research.selectedModel, "default");

  const architecture = selectExecutionPolicy({
    agent: "auto",
    taskType: "architecture",
    complexity: "long",
    model: "auto",
  });
  assert.equal(architecture.selectedAgent, "claude");
  assert.equal(architecture.selectedModel, "sonnet");
  assert.equal(architecture.fallbackAgent, "codex");
  assert.equal(architecture.maxAttempts, 2);
  assert.equal(architecture.primaryTimeoutSeconds, 600);
  assert.equal(architecture.idleTimeoutSeconds, 420);
});

test("explicit agent, model and timeout override automatic policy", () => {
  const policy = selectExecutionPolicy({
    agent: "opencode",
    taskType: "general",
    complexity: "standard",
    model: "provider/model",
    timeoutSeconds: 900,
  });
  assert.equal(policy.selectedAgent, "opencode");
  assert.equal(policy.selectedModel, "provider/model");
  assert.equal(policy.timeoutSeconds, 900);
  assert.equal(policy.fallbackAgent, "none");
});

test("write mode disables fallback and attempt count is clamped", () => {
  const policy = selectExecutionPolicy({
    agent: "claude",
    taskType: "research",
    complexity: "long",
    mode: "write",
    fallbackAgent: "codex",
    maxAttempts: 9,
  });
  assert.equal(policy.selectedAgent, "claude");
  assert.equal(policy.fallbackAgent, "none");
  assert.equal(policy.maxAttempts, 1);
});
