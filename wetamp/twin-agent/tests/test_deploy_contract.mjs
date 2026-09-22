import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const deployScript = path.join(root, "scripts", "deploy-twin-agent.sh");

function makeHarness(t, overrides = {}) {
  const temp = mkdtempSync(path.join(tmpdir(), "twin-agent-deploy-test-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const fakeBin = path.join(temp, "bin");
  const sshLog = path.join(temp, "ssh.log");
  mkdirSync(fakeBin);

  const git = path.join(fakeBin, "git");
  writeFileSync(
    git,
    `#!/bin/sh
case "$*" in
  *"status --porcelain"*) printf '%s' "${"$"}{FAKE_GIT_STATUS:-}" ;;
  *"fetch --quiet"*) exit 0 ;;
  *"rev-list --left-right --count"*) printf '%s %s\\n' "${"$"}{FAKE_GIT_BEHIND:-0}" "${"$"}{FAKE_GIT_AHEAD:-1}" ;;
  *"rev-parse --abbrev-ref --symbolic-full-name"*) printf 'origin/dev\\n' ;;
  *"rev-parse HEAD"*) printf '1111111111111111111111111111111111111111\\n' ;;
  *"symbolic-ref --short HEAD"*) printf 'dev\\n' ;;
  *) printf 'unexpected git invocation: %s\\n' "$*" >&2; exit 2 ;;
esac
`,
  );
  chmodSync(git, 0o700);

  const ssh = path.join(fakeBin, "ssh");
  writeFileSync(
    ssh,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_SSH_LOG"
case "$*" in
  *"twin-agent-remote queue"*)
    printf 'running=%s\\nqueued=%s\\nmax_concurrent=3\\n' "${"$"}{FAKE_QUEUE_RUNNING:-0}" "${"$"}{FAKE_QUEUE_QUEUED:-0}"
    ;;
esac
`,
  );
  chmodSync(ssh, 0o700);

  const home = path.join(temp, "home");
  mkdirSync(home);
  return {
    temp,
    sshLog,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      HOME: home,
      FAKE_SSH_LOG: sshLog,
      TWIN_AGENT_LOCAL_RUNTIME: path.join(home, ".lan-dev-machine", "twin-agent"),
      TWIN_AGENT_LOCAL_BIN: path.join(home, ".lan-dev-machine", "bin"),
      ...overrides,
    },
  };
}

function runDeploy(args, env) {
  return spawnSync("bash", [deployScript, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
  });
}

test("deployment check pins a clean current dev commit and probes both remote nodes", (t) => {
  const harness = makeHarness(t);

  const result = runDeploy(["--check"], harness.env);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^branch=dev$/m);
  assert.match(result.stdout, /^source_commit=1111111111111111111111111111111111111111$/m);
  assert.match(result.stdout, /^behind=0$/m);
  assert.match(result.stdout, /^ahead=1$/m);
  assert.match(result.stdout, /^queue_host=twin-dev$/m);
  assert.match(result.stdout, /^mini_host=twin-mini$/m);
  const sshCalls = readFileSync(harness.sshLog, "utf8");
  assert.match(sshCalls, /twin-dev true/);
  assert.match(sshCalls, /twin-mini true/);
});

test("deployment refuses a stale or dirty source basis", (t) => {
  const behindHarness = makeHarness(t, { FAKE_GIT_BEHIND: "1" });
  const behind = runDeploy(["--check"], behindHarness.env);
  assert.notEqual(behind.status, 0);
  assert.match(behind.stderr, /behind origin\/dev/);

  const dirtyHarness = makeHarness(t, { FAKE_GIT_STATUS: " M wetamp/twin-agent/server.mjs\\n" });
  const dirty = runDeploy(["--check"], dirtyHarness.env);
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /deployment sources are not committed/);
});

test("deployment refuses to replace a runtime while the shared queue is active", (t) => {
  const harness = makeHarness(t, { FAKE_QUEUE_RUNNING: "1" });

  const result = runDeploy(["--deploy"], harness.env);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /shared queue is not idle/);
  assert.equal(existsSync(harness.env.TWIN_AGENT_LOCAL_RUNTIME), false);
});
