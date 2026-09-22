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
const queueClient = path.join(root, "twin-agent", "twin-agent-queue-client");
const workspaceDiff = path.join(root, "twin-agent", "twin-agent-workspace-diff");

function runGit(cwd, args, options = {}) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    ...options,
  });
  assert.equal(result.status, 0, result.stderr?.toString() ?? "git failed");
  return result.stdout.toString().trim();
}

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

test("controller queue client forwards scheduler commands to the one twin-dev queue owner", (t) => {
  const temp = mkdtempSync(path.join(tmpdir(), "twin-agent-queue-client-test-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const sshLog = path.join(temp, "ssh.log");
  const fakeSsh = path.join(temp, "ssh");
  writeFileSync(fakeSsh, `#!/bin/sh\nprintf '%s\\n' "$*" > "$FAKE_SSH_LOG"\nprintf 'state=acquired\\n'\n`);
  chmodSync(fakeSsh, 0o700);

  const result = spawnSync(queueClient, ["lease-status", "lease-1", "owner-1"], {
    env: {
      ...process.env,
      FAKE_SSH_LOG: sshLog,
      TWIN_AGENT_QUEUE_CLIENT_SSH_BIN: fakeSsh,
      TWIN_AGENT_QUEUE_HOST: "twin-dev",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "state=acquired\n");
  assert.equal(
    readFileSync(sshLog, "utf8").trim(),
    "-o BatchMode=yes -o ConnectTimeout=10 twin-dev ~/.lan-dev-machine/bin/twin-agent-remote lease-status lease-1 owner-1",
  );
});

test("workspace helper produces a binary-safe patch and rejects targets outside its root", (t) => {
  const temp = mkdtempSync(path.join(tmpdir(), "twin-agent-workspace-diff-test-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const workspaceRoot = path.join(temp, "workspaces");
  const target = path.join(workspaceRoot, "session-1");
  const review = path.join(temp, "review");
  mkdirSync(workspaceRoot);
  const env = { ...process.env, TWIN_AGENT_WORKSPACE_ROOT: workspaceRoot };

  const prepare = spawnSync(workspaceDiff, ["prepare", target], { env, encoding: "utf8" });
  assert.equal(prepare.status, 0, prepare.stderr);
  runGit(target, ["init", "--initial-branch=review"]);
  runGit(target, ["config", "user.name", "Test User"]);
  runGit(target, ["config", "user.email", "test@example.com"]);
  writeFileSync(path.join(target, "tracked.txt"), "base\n");
  writeFileSync(path.join(target, "delete.txt"), "delete me\n");
  writeFileSync(path.join(target, "image.bin"), Buffer.from([0, 1, 2, 3]));
  runGit(target, ["add", "--all"]);
  runGit(target, ["commit", "-m", "baseline"]);
  const baseline = runGit(target, ["rev-parse", "HEAD"]);
  runGit(temp, ["clone", target, review]);

  writeFileSync(path.join(target, "tracked.txt"), "agent change\n");
  writeFileSync(path.join(target, "image.bin"), Buffer.from([9, 8, 0, 7]));
  writeFileSync(path.join(target, "new.txt"), "new file\n");
  rmSync(path.join(target, "delete.txt"));

  const diff = spawnSync(workspaceDiff, ["diff", target, baseline], { env });
  assert.equal(diff.status, 0, diff.stderr.toString());
  const apply = spawnSync("git", ["-C", review, "apply", "--binary", "-"], {
    input: diff.stdout,
    encoding: "utf8",
  });
  assert.equal(apply.status, 0, apply.stderr);
  assert.equal(readFileSync(path.join(review, "tracked.txt"), "utf8"), "agent change\n");
  assert.deepEqual(readFileSync(path.join(review, "image.bin")), Buffer.from([9, 8, 0, 7]));
  assert.equal(readFileSync(path.join(review, "new.txt"), "utf8"), "new file\n");
  assert.equal(existsSync(path.join(review, "delete.txt")), false);

  const outside = spawnSync(workspaceDiff, ["prepare", path.join(temp, "outside")], { env, encoding: "utf8" });
  assert.notEqual(outside.status, 0);
  assert.match(outside.stderr, /outside configured workspace root/);
});
