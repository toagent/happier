import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const deployScript = path.join(root, 'wetamp', 'scripts', 'deploy-happier-cli.sh');

function makeHarness(t, overrides = {}) {
  const temp = mkdtempSync(path.join(tmpdir(), 'happier-cli-deploy-test-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const fakeBin = path.join(temp, 'bin');
  const sshLog = path.join(temp, 'ssh.log');
  mkdirSync(fakeBin);

  const git = path.join(fakeBin, 'git');
  writeFileSync(
    git,
    `#!/bin/sh
case "$*" in
  *"status --porcelain"*) printf '%s' "${'$'}{FAKE_GIT_STATUS:-}" ;;
  *"fetch --quiet"*) exit 0 ;;
  *"rev-list --left-right --count"*) printf '%s %s\\n' "${'$'}{FAKE_GIT_BEHIND:-0}" "${'$'}{FAKE_GIT_AHEAD:-1}" ;;
  *"rev-parse --abbrev-ref --symbolic-full-name"*) printf 'origin/dev\\n' ;;
  *"rev-parse HEAD"*) printf '2222222222222222222222222222222222222222\\n' ;;
  *"symbolic-ref --short HEAD"*) printf 'dev\\n' ;;
  *) printf 'unexpected git invocation: %s\\n' "$*" >&2; exit 2 ;;
esac
`,
  );
  chmodSync(git, 0o700);

  const ssh = path.join(fakeBin, 'ssh');
  writeFileSync(
    ssh,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_SSH_LOG"
`,
  );
  chmodSync(ssh, 0o700);

  return {
    sshLog,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_SSH_LOG: sshLog,
      ...overrides,
    },
  };
}

function runCheck(env) {
  return spawnSync('bash', [deployScript, '--check'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
}

test('deployment check pins a committed current source and probes both remote machines', (t) => {
  const harness = makeHarness(t);

  const result = runCheck(harness.env);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^branch=dev$/m);
  assert.match(result.stdout, /^source_commit=2222222222222222222222222222222222222222$/m);
  assert.match(result.stdout, /^behind=0$/m);
  assert.match(result.stdout, /^ahead=1$/m);
  assert.match(result.stdout, /^controller_home=.+\/\.happier\/stacks\/main\/cli$/m);
  assert.match(result.stdout, /^deployment_check=ok$/m);
  const sshCalls = readFileSync(harness.sshLog, 'utf8');
  assert.match(sshCalls, /twin-dev true/);
  assert.match(sshCalls, /twin-mini true/);
});

test('deployment check rejects dirty deployment sources and a stale branch', (t) => {
  const dirtyHarness = makeHarness(t, { FAKE_GIT_STATUS: ' M apps/cli/src/index.ts\\n' });
  const dirty = runCheck(dirtyHarness.env);
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /deployment sources are not committed/);

  const behindHarness = makeHarness(t, { FAKE_GIT_BEHIND: '1' });
  const behind = runCheck(behindHarness.env);
  assert.notEqual(behind.status, 0);
  assert.match(behind.stderr, /behind origin\/dev/);
});

test('deployment uses one immutable payload, official service lifecycle, and controller-only scheduling authority', () => {
  const script = readFileSync(deployScript, 'utf8');

  assert.match(script, /yarn workspace @happier-dev\/cli prepack/);
  assert.match(script, /vendorBundledPackageRuntimeDependencies/);
  assert.match(script, /\$CLI_DIR\/node_modules\/@happier-dev/);
  assert.doesNotMatch(script, /cp -R "\$CLI_DIR\/node_modules"/);
  assert.match(script, /\.source-commit/);
  assert.match(script, /versions="\$LOCAL_DEPLOY_ROOT\/versions"/);
  assert.match(script, /export HAPPIER_HOME_DIR="\$CONTROLLER_HOME"/);
  assert.match(script, /export HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR="\$CONTROLLER_HOME"/);
  assert.match(script, /service install --takeover --replace-existing=all --yes --json/);
  assert.match(script, /HAPPIER_TWIN_SESSION_SCHEDULER_CONFIG_JSON/);
  assert.match(script, /install_controller_service/);
  assert.match(script, /install_worker_service/);
  assert.match(script, /scheduler_config=""/);
  assert.match(script, /twin-agent-remote queue/);
  assert.match(script, /read_local_identity\) \|\| fail/);
  assert.match(script, /read_remote_identity "\$MINI_HOST" "\$mini_node" "\$mini_payload"\) \|\| fail/);
  assert.doesNotMatch(script, /(?:cp|scp|tar).*\.(?:happier|happier-dev)\/(?:auth|credentials|settings)/);
});
