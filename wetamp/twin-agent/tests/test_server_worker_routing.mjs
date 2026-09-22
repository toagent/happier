import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("../", import.meta.url));

function resultText(result) {
  return (result.content || [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

test("delegate_agent publishes and persists the selected worker", async (t) => {
  const temp = mkdtempSync(path.join(tmpdir(), "twin-agent-worker-routing-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const sshLog = path.join(temp, "ssh.log");
  const metadataPath = path.join(temp, "metadata.json");
  const fakeSsh = path.join(temp, "ssh");
  writeFileSync(
    fakeSsh,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_SSH_LOG"
case "$*" in
  *metadata.json*) cat > "$FAKE_METADATA_PATH" ;;
  *" twin-agent-remote start "*) echo "job_id=$6"; echo "state=queued" ;;
  *) cat >/dev/null ;;
esac
`,
  );
  chmodSync(fakeSsh, 0o700);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["server.mjs"],
    cwd: root,
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: `${temp}:${process.env.PATH}`,
      TWIN_AGENT_SSH_HOST: "queue-host",
      TWIN_AGENT_REMOTE_HELPER: "/opt/twin-agent-remote",
      TWIN_AGENT_REMOTE_BASE: "/remote/twin-agent",
      TWIN_AGENT_REMOTE_WORKSPACE_ROOT: "/remote/workspaces",
      TWIN_AGENT_ACTIVITY_DIR: path.join(temp, "activity"),
      FAKE_SSH_LOG: sshLog,
      FAKE_METADATA_PATH: metadataPath,
    },
  });
  const client = new Client({ name: "worker-routing-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => client.close());

  const tools = await client.listTools();
  const delegate = tools.tools.find((item) => item.name === "delegate_agent");
  assert.ok(delegate);
  assert.deepEqual(delegate.inputSchema.properties.worker_id.enum, [
    "twin-control",
    "twin-dev",
    "mac-mini",
  ]);
  assert.equal(delegate.inputSchema.properties.worker_id.default, "twin-dev");

  const result = await client.callTool({
    name: "delegate_agent",
    arguments: {
      prompt: "inspect",
      collaboration_id: "worker-routing-test",
      caller: "codex",
      task_title: "worker routing contract",
      local_work: "verify the queue owner contract",
      agent: "codex",
      task_type: "test",
      complexity: "short",
      mode: "read_only",
      workspace_mode: "remote_workspace",
      cwd: "worker-routing-test",
      worker_id: "mac-mini",
      wait_seconds: 0,
    },
  });
  assert.equal(result.isError, undefined, resultText(result));
  assert.match(resultText(result), /^worker_id=mac-mini$/m);

  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  assert.equal(metadata.worker_id, "mac-mini");
  assert.match(readFileSync(sshLog, "utf8"), /twin-agent-remote start .* mac-mini/);
});
