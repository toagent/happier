#!/bin/bash
set -euo pipefail

usage() {
  echo "Usage: $0 --check|--deploy" >&2
  exit 2
}

fail() {
  echo "$*" >&2
  exit 1
}

[[ $# -eq 1 ]] || usage
mode="$1"
case "$mode" in
  --check|--deploy) ;;
  *) usage ;;
esac

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT="${HAPPIER_CLI_REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd -P)}"
CLI_DIR="$REPO_ROOT/apps/cli"
QUEUE_HOST="${HAPPIER_CLI_QUEUE_HOST:-twin-dev}"
MINI_HOST="${HAPPIER_CLI_MINI_HOST:-twin-mini}"
SSH_BIN="${HAPPIER_CLI_SSH_BIN:-ssh}"
SCP_BIN="${HAPPIER_CLI_SCP_BIN:-scp}"
LOCAL_DEPLOY_ROOT="${HAPPIER_CLI_LOCAL_DEPLOY_ROOT:-$HOME/.happier/wetamp-cli}"
CONTROLLER_HOME="${HAPPIER_CLI_CONTROLLER_HOME:-$HOME/.happier/stacks/main/cli}"
SCHEDULER_EXECUTABLE="${HAPPIER_CLI_SCHEDULER_EXECUTABLE:-$HOME/.lan-dev-machine/bin/twin-agent-queue-client}"
SCHEDULER_POLL_INTERVAL_MS="${HAPPIER_CLI_SCHEDULER_POLL_INTERVAL_MS:-1000}"
SCHEDULER_REVIEW_ROOT="${HAPPIER_CLI_SCHEDULER_REVIEW_ROOT:-$HOME/.happier/review-workspaces}"
SCHEDULER_LOCAL_WORKSPACE_ROOT="${HAPPIER_CLI_SCHEDULER_LOCAL_WORKSPACE_ROOT:-$HOME/.happier/twin-workspaces}"
DEPLOY_TIMESTAMP="${HAPPIER_CLI_DEPLOY_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
SCHEDULER_ENV_KEY="HAPPIER_TWIN_SESSION_SCHEDULER_CONFIG_JSON"
MINI_RELAY_TUNNEL_PORT="${HAPPIER_CLI_MINI_RELAY_TUNNEL_PORT:-3005}"
MINI_RELAY_TUNNEL_LABEL="io.toagent.happier.mac-mini-relay-tunnel"
MINI_RELAY_TUNNEL_PLIST="$HOME/Library/LaunchAgents/$MINI_RELAY_TUNNEL_LABEL.plist"
export HAPPIER_HOME_DIR="$CONTROLLER_HOME"
export HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR="$CONTROLLER_HOME"

DEPLOY_PATHS=(
  apps/cli
  packages/agents
  packages/cli-common
  packages/connection-supervisor
  packages/protocol
  packages/release-runtime
  packages/transfers
  package.json
  yarn.lock
  wetamp/scripts/deploy-happier-cli.sh
  wetamp/scripts/deploy-happier-cli.test.mjs
)

validate_sources() {
  [[ -f "$CLI_DIR/package.json" ]] || fail "CLI package is missing: $CLI_DIR/package.json"
  [[ -f "$CLI_DIR/scripts/syncPackageDist.mjs" ]] || fail "CLI prepack owner is missing"
  [[ -x "$SCHEDULER_EXECUTABLE" ]] || fail "scheduler executable is unavailable: $SCHEDULER_EXECUTABLE"
  [[ "$SCHEDULER_POLL_INTERVAL_MS" =~ ^[1-9][0-9]*$ ]] || fail "scheduler poll interval must be a positive integer"
  [[ "$SCHEDULER_REVIEW_ROOT" == /* ]] || fail "scheduler review root must be absolute"
  [[ "$SCHEDULER_LOCAL_WORKSPACE_ROOT" == /* ]] || fail "scheduler local workspace root must be absolute"
  [[ "$MINI_RELAY_TUNNEL_PORT" =~ ^[1-9][0-9]{0,4}$ && "$MINI_RELAY_TUNNEL_PORT" -le 65535 ]] || \
    fail "Mac mini relay tunnel port must be between 1 and 65535"
  [[ "$MINI_HOST" =~ ^[A-Za-z0-9._-]+$ ]] || fail "Mac mini SSH host contains unsupported characters"
  command -v "$SSH_BIN" >/dev/null || fail "SSH client is unavailable: $SSH_BIN"
  [[ -x /bin/launchctl ]] || fail "launchctl is unavailable"
  [[ -x /usr/bin/plutil ]] || fail "plutil is unavailable"
  [[ -x /usr/bin/curl ]] || fail "curl is unavailable"
  bash -n "$SCRIPT_DIR/deploy-happier-cli.sh"
}

load_git_basis() {
  local status remote remote_branch counts
  status=$(git -C "$REPO_ROOT" status --porcelain -- "${DEPLOY_PATHS[@]}")
  [[ -z "$status" ]] || fail "deployment sources are not committed:\n$status"

  branch=$(git -C "$REPO_ROOT" symbolic-ref --short HEAD)
  upstream=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}')
  [[ "$upstream" == */* ]] || fail "current branch has no remote-tracking upstream"
  remote=${upstream%%/*}
  remote_branch=${upstream#*/}
  git -C "$REPO_ROOT" fetch --quiet "$remote" "$remote_branch"
  counts=$(git -C "$REPO_ROOT" rev-list --left-right --count "$upstream...HEAD")
  read -r behind ahead <<<"$counts"
  [[ "$behind" == "0" ]] || fail "local $branch is behind $upstream by $behind commit(s)"
  source_commit=$(git -C "$REPO_ROOT" rev-parse HEAD)
}

probe_hosts() {
  "$SSH_BIN" -o BatchMode=yes -o ConnectTimeout=10 "$QUEUE_HOST" true
  "$SSH_BIN" -o BatchMode=yes -o ConnectTimeout=10 "$MINI_HOST" true
}

print_basis() {
  printf 'branch=%s\n' "$branch"
  printf 'upstream=%s\n' "$upstream"
  printf 'source_commit=%s\n' "$source_commit"
  printf 'behind=%s\n' "$behind"
  printf 'ahead=%s\n' "$ahead"
  printf 'controller_home=%s\n' "$CONTROLLER_HOME"
  printf 'scheduler_review_root=%s\n' "$SCHEDULER_REVIEW_ROOT"
  printf 'queue_host=%s\n' "$QUEUE_HOST"
  printf 'mini_host=%s\n' "$MINI_HOST"
  printf 'mini_relay_tunnel_port=%s\n' "$MINI_RELAY_TUNNEL_PORT"
}

require_idle_queue() {
  local queue_status running queued
  queue_status=$("$SSH_BIN" -o BatchMode=yes -o ConnectTimeout=10 "$QUEUE_HOST" \
    '~/.lan-dev-machine/bin/twin-agent-remote queue')
  running=$(awk -F= '$1 == "running" { print $2 }' <<<"$queue_status")
  queued=$(awk -F= '$1 == "queued" { print $2 }' <<<"$queue_status")
  [[ "$running" == "0" && "$queued" == "0" ]] || \
    fail "shared queue is not idle (running=${running:-unknown}, queued=${queued:-unknown})"
}

build_payload() {
  (
    cd "$REPO_ROOT"
    yarn workspace @happier-dev/cli prepack
  )

  [[ -f "$CLI_DIR/package-dist/index.mjs" ]] || fail "CLI prepack did not produce package-dist/index.mjs"
  [[ -d "$CLI_DIR/node_modules/@happier-dev/protocol" ]] || fail "CLI workspace bundle is incomplete"

  bundle_root=$(mktemp -d "${TMPDIR:-/tmp}/happier-cli-deploy.XXXXXX")
  payload_root="$bundle_root/payload"
  bundle_archive="$bundle_root/happier-cli-$source_commit.tar.gz"
  install -d -m 0700 "$payload_root"
  cp -R "$CLI_DIR/package-dist" "$payload_root/package-dist"
  node -e '
    const { pathToFileURL } = require("node:url");
    import(pathToFileURL(process.argv[1]).href).then(({ vendorBundledPackageRuntimeDependencies }) => {
      vendorBundledPackageRuntimeDependencies({
        srcPackageJsonPath: process.argv[2],
        destPackageDir: process.argv[3],
      });
    }).catch((error) => { console.error(error); process.exitCode = 1; });
  ' "$REPO_ROOT/packages/cli-common/dist/workspaces/index.js" "$CLI_DIR/package.json" "$payload_root"
  cp -R "$CLI_DIR/node_modules/@happier-dev" "$payload_root/node_modules/@happier-dev"
  cp -R "$CLI_DIR/scripts" "$payload_root/scripts"
  cp -R "$CLI_DIR/bin" "$payload_root/bin"
  cp -R "$CLI_DIR/tools" "$payload_root/tools"
  cp "$CLI_DIR/package.json" "$payload_root/package.json"
  printf '%s\n' "$source_commit" > "$payload_root/.source-commit"
  node "$payload_root/package-dist/index.mjs" daemon status --json >/dev/null
  tar -czf "$bundle_archive" -C "$payload_root" .
}

install_payload_local() {
  local versions target stage
  versions="$LOCAL_DEPLOY_ROOT/versions"
  target="$versions/$source_commit"
  install -d -m 0700 "$versions" "$LOCAL_DEPLOY_ROOT/backups/$DEPLOY_TIMESTAMP"
  if [[ -d "$target" ]]; then
    [[ "$(<"$target/.source-commit")" == "$source_commit" ]] || fail "local payload commit marker mismatch"
    local_payload="$target"
    return
  fi
  stage=$(mktemp -d "$versions/.install.XXXXXX")
  tar -xzf "$bundle_archive" -C "$stage"
  [[ "$(<"$stage/.source-commit")" == "$source_commit" ]] || fail "local staged payload commit marker mismatch"
  mv "$stage" "$target"
  local_payload="$target"
}

xml_escape() {
  local value="$1"
  value=${value//&/&amp;}
  value=${value//</&lt;}
  value=${value//>/&gt;}
  printf '%s' "$value"
}

render_mini_relay_tunnel_plist() {
  local ssh_program reverse_forward log_dir
  ssh_program=$(command -v "$SSH_BIN")
  [[ "$ssh_program" == /* ]] || fail "SSH client path is not absolute: $ssh_program"
  reverse_forward="127.0.0.1:$MINI_RELAY_TUNNEL_PORT:127.0.0.1:$MINI_RELAY_TUNNEL_PORT"
  log_dir="$HOME/.happier/logs"
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$MINI_RELAY_TUNNEL_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$ssh_program")</string>
    <string>-o</string>
    <string>BatchMode=yes</string>
    <string>-o</string>
    <string>ControlMaster=no</string>
    <string>-o</string>
    <string>ControlPath=none</string>
    <string>-o</string>
    <string>ExitOnForwardFailure=yes</string>
    <string>-o</string>
    <string>ServerAliveInterval=15</string>
    <string>-o</string>
    <string>ServerAliveCountMax=3</string>
    <string>-N</string>
    <string>-T</string>
    <string>-R</string>
    <string>$reverse_forward</string>
    <string>$MINI_HOST</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$log_dir/mac-mini-relay-tunnel.out.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$log_dir/mac-mini-relay-tunnel.err.log")</string>
</dict>
</plist>
PLIST
}

install_mini_relay_tunnel() {
  local domain plist_dir stage backup
  domain="gui/$(id -u)"
  plist_dir=$(dirname "$MINI_RELAY_TUNNEL_PLIST")
  backup="$LOCAL_DEPLOY_ROOT/backups/$DEPLOY_TIMESTAMP/$MINI_RELAY_TUNNEL_LABEL.plist"
  install -d -m 0700 "$plist_dir" "$HOME/.happier/logs" "$LOCAL_DEPLOY_ROOT/backups/$DEPLOY_TIMESTAMP"
  if [[ -f "$MINI_RELAY_TUNNEL_PLIST" ]]; then
    cp -p "$MINI_RELAY_TUNNEL_PLIST" "$backup"
  fi
  stage=$(mktemp "$plist_dir/.mac-mini-relay-tunnel.XXXXXX")
  render_mini_relay_tunnel_plist > "$stage"
  /usr/bin/plutil -lint "$stage" >/dev/null
  /bin/launchctl bootout "$domain/$MINI_RELAY_TUNNEL_LABEL" >/dev/null 2>&1 || true
  install -m 0600 "$stage" "$MINI_RELAY_TUNNEL_PLIST"
  rm -f "$stage"
  /bin/launchctl bootstrap "$domain" "$MINI_RELAY_TUNNEL_PLIST"
  /bin/launchctl enable "$domain/$MINI_RELAY_TUNNEL_LABEL"
  /bin/launchctl kickstart -k "$domain/$MINI_RELAY_TUNNEL_LABEL"
}

verify_mini_relay_tunnel() {
  local domain attempt health_url
  domain="gui/$(id -u)"
  health_url="http://127.0.0.1:$MINI_RELAY_TUNNEL_PORT/health"
  /usr/bin/curl -fsS --max-time 5 "$health_url" >/dev/null || fail "local Happier relay is unavailable"
  for attempt in {1..20}; do
    if /bin/launchctl print "$domain/$MINI_RELAY_TUNNEL_LABEL" >/dev/null 2>&1 \
      && "$SSH_BIN" -o BatchMode=yes -o ConnectTimeout=10 "$MINI_HOST" \
        curl -fsS --max-time 5 "$health_url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "Mac mini relay tunnel did not become healthy"
}

install_payload_remote() {
  local host="$1" archive_name remote_target
  archive_name=".happier-cli-deploy-$source_commit-$DEPLOY_TIMESTAMP.tar.gz"
  "$SCP_BIN" -q "$bundle_archive" "$host:$archive_name"
  remote_target=$("$SSH_BIN" -o BatchMode=yes -o ConnectTimeout=10 "$host" \
    bash -s -- "$archive_name" "$source_commit" <<'REMOTE'
set -euo pipefail
umask 077
archive="$HOME/$1"
source_commit="$2"
root="$HOME/.happier/wetamp-cli"
versions="$root/versions"
target="$versions/$source_commit"
install -d -m 0700 "$versions"
cleanup() {
  rm -f "$archive"
  [[ -z "${stage:-}" || ! -d "$stage" ]] || rm -rf "$stage"
}
trap cleanup EXIT
if [[ ! -d "$target" ]]; then
  stage=$(mktemp -d "$versions/.install.XXXXXX")
  tar -xzf "$archive" -C "$stage"
  [[ "$(<"$stage/.source-commit")" == "$source_commit" ]]
  mv "$stage" "$target"
fi
[[ "$(<"$target/.source-commit")" == "$source_commit" ]]
printf '%s\n' "$target"
REMOTE
  )
  [[ -n "$remote_target" ]] || fail "remote payload path is empty for $host"
  printf '%s\n' "$remote_target"
}

resolve_remote_node() {
  local host="$1" node_path
  node_path=$("$SSH_BIN" -o BatchMode=yes -o ConnectTimeout=10 "$host" 'command -v node')
  [[ "$node_path" == /* ]] || fail "remote node is unavailable on $host"
  printf '%s\n' "$node_path"
}

read_remote_home() {
  local host="$1" remote_home
  remote_home=$("$SSH_BIN" -o BatchMode=yes -o ConnectTimeout=10 "$host" 'cd "$HOME" && pwd -P')
  [[ "$remote_home" == /* ]] || fail "remote home is unavailable on $host"
  printf '%s\n' "$remote_home"
}

parse_identity() {
  node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      const auth = value.auth ?? value.data ?? {};
      const machineId = String(auth.machineId ?? "").trim();
      const accountId = String(auth.accountId ?? auth.validatedAccountId ?? "").trim();
      if (!machineId || !accountId) process.exit(2);
      process.stdout.write(`${machineId}\t${accountId}\n`);
    });
  '
}

read_local_identity() {
  local status
  status=$("$local_node" "$local_payload/package-dist/index.mjs" daemon status --json)
  parse_identity <<<"$status"
}

read_remote_identity() {
  local host="$1" node_path="$2" payload="$3" status
  status=$("$SSH_BIN" -o BatchMode=yes -o ConnectTimeout=10 "$host" \
    "$node_path" "$payload/package-dist/index.mjs" daemon status --json)
  parse_identity <<<"$status"
}

build_scheduler_config() {
  node -e '
    const [
      executable,
      pollInterval,
      reviewRoot,
      controller,
      controllerWorkspaceRoot,
      developer,
      queueHost,
      developerWorkspaceRoot,
      developerDiffExecutable,
      mini,
      miniHost,
      miniWorkspaceRoot,
      miniDiffExecutable,
    ] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({
      v: 1,
      executable,
      pollIntervalMs: Number(pollInterval),
      reviewRoot,
      defaultWorkerId: "twin-control",
      workers: {
        "twin-control": {
          machineId: controller,
          workspace: { kind: "local", root: controllerWorkspaceRoot },
        },
        "twin-dev": {
          machineId: developer,
          workspace: { kind: "ssh", host: queueHost, root: developerWorkspaceRoot, diffExecutable: developerDiffExecutable },
        },
        "mac-mini": {
          machineId: mini,
          workspace: { kind: "ssh", host: miniHost, root: miniWorkspaceRoot, diffExecutable: miniDiffExecutable },
        },
      },
    }));
  ' "$SCHEDULER_EXECUTABLE" "$SCHEDULER_POLL_INTERVAL_MS" "$SCHEDULER_REVIEW_ROOT" \
    "$controller_machine_id" "$SCHEDULER_LOCAL_WORKSPACE_ROOT" \
    "$developer_machine_id" "$QUEUE_HOST" "$developer_workspace_root" "$developer_diff_executable" \
    "$mini_machine_id" "$MINI_HOST" "$mini_workspace_root" "$mini_diff_executable"
}

backup_local_service() {
  local plist="$HOME/Library/LaunchAgents/com.happier.cli.daemon.default.plist"
  [[ -f "$plist" ]] || return 0
  cp -p "$plist" "$LOCAL_DEPLOY_ROOT/backups/$DEPLOY_TIMESTAMP/com.happier.cli.daemon.default.plist"
}

run_controller_service_command() {
  local entry="$local_payload/package-dist/index.mjs"
  HAPPIER_DAEMON_SERVICE_NODE_PATH="$local_node" \
  HAPPIER_DAEMON_SERVICE_ENTRY_PATH="$entry" \
  HAPPIER_DAEMON_SERVICE_CHANNEL=stable \
  HAPPIER_PUBLIC_RELEASE_CHANNEL=stable \
  HAPPIER_TWIN_SESSION_SCHEDULER_CONFIG_JSON="$scheduler_config" \
    "$local_node" "$entry" service "$@"
}

install_controller_service() {
  backup_local_service
  run_controller_service_command install --takeover --replace-existing=all --yes --json
  run_controller_service_command restart --takeover --json
}

install_worker_service() {
  local host="$1" node_path="$2" payload="$3"
  "$SSH_BIN" -o BatchMode=yes -o ConnectTimeout=10 "$host" \
    bash -s -- "$node_path" "$payload" "$DEPLOY_TIMESTAMP" "$SCHEDULER_POLL_INTERVAL_MS" <<'REMOTE'
set -euo pipefail
node_path="$1"
payload="$2"
timestamp="$3"
release_poll_interval_ms="$4"
entry="$payload/package-dist/index.mjs"
scheduler_config=""
backup_root="$HOME/.happier/wetamp-cli/backups/$timestamp"
plist="$HOME/Library/LaunchAgents/com.happier.cli.daemon.default.plist"
install -d -m 0700 "$backup_root"
if [[ -f "$plist" ]]; then
  cp -p "$plist" "$backup_root/com.happier.cli.daemon.default.plist"
fi
run_worker_service_command() {
  HAPPIER_DAEMON_SERVICE_NODE_PATH="$node_path" \
  HAPPIER_DAEMON_SERVICE_ENTRY_PATH="$entry" \
  HAPPIER_DAEMON_SERVICE_CHANNEL=stable \
  HAPPIER_PUBLIC_RELEASE_CHANNEL=stable \
  HAPPIER_TWIN_SESSION_SCHEDULER_CONFIG_JSON="$scheduler_config" \
  HAPPIER_TWIN_SESSION_RELEASE_OUTBOX_CONFIG_JSON="{\"v\":1,\"pollIntervalMs\":$release_poll_interval_ms}" \
    "$node_path" "$entry" service "$@"
}
run_worker_service_command install --takeover --replace-existing=all --yes --json
run_worker_service_command restart --takeover --json
REMOTE
}

verify_status() {
  local expected_machine_id="$1" expected_account_id="$2"
  node -e '
    const [expectedMachineId, expectedAccountId] = process.argv.slice(1);
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      if (value.daemon?.running !== true) throw new Error("daemon is not running");
      if (value.daemon?.serviceManaged !== true) throw new Error("daemon is not service managed");
      if (value.runtimeConvergence?.serviceOwnsRunningDaemon !== true) throw new Error("service does not own daemon");
      if (value.auth?.machineId !== expectedMachineId) throw new Error("machine id changed");
      const accountId = value.auth?.validatedAccountId ?? value.auth?.accountId;
      if (accountId !== expectedAccountId) throw new Error("account id changed");
      process.stdout.write(`${value.daemon.pid}\n`);
    });
  ' "$expected_machine_id" "$expected_account_id"
}

verify_local_runtime() {
  local entry="$local_payload/package-dist/index.mjs" status pid command plist configured
  [[ "$(<"$local_payload/.source-commit")" == "$source_commit" ]] || fail "local source commit mismatch"
  status=$("$local_node" "$entry" daemon status --json)
  pid=$(verify_status "$controller_machine_id" "$controller_account_id" <<<"$status")
  command=$(ps -p "$pid" -o command=)
  grep -Fq "$entry" <<<"$command" || fail "local daemon is not running the deployed payload"
  plist="$HOME/Library/LaunchAgents/com.happier.cli.daemon.default.plist"
  configured=$(plutil -extract "EnvironmentVariables.$SCHEDULER_ENV_KEY" raw "$plist")
  [[ "$configured" == "$scheduler_config" ]] || fail "controller scheduler config was not persisted"
}

verify_remote_runtime() {
  local host="$1" node_path="$2" payload="$3" expected_machine_id="$4" expected_account_id="$5"
  local status pid command
  status=$("$SSH_BIN" -o BatchMode=yes -o ConnectTimeout=10 "$host" \
    "$node_path" "$payload/package-dist/index.mjs" daemon status --json)
  pid=$(verify_status "$expected_machine_id" "$expected_account_id" <<<"$status")
  command=$("$SSH_BIN" -o BatchMode=yes -o ConnectTimeout=10 "$host" ps -p "$pid" -o command=)
  grep -Fq "$payload/package-dist/index.mjs" <<<"$command" || fail "$host daemon is not running the deployed payload"
  "$SSH_BIN" -o BatchMode=yes -o ConnectTimeout=10 "$host" \
    bash -s -- "$payload" "$source_commit" "$SCHEDULER_ENV_KEY" <<'REMOTE'
set -euo pipefail
payload="$1"
source_commit="$2"
scheduler_env_key="$3"
[[ "$(<"$payload/.source-commit")" == "$source_commit" ]]
plist="$HOME/Library/LaunchAgents/com.happier.cli.daemon.default.plist"
if plutil -extract "EnvironmentVariables.$scheduler_env_key" raw "$plist" >/dev/null 2>&1; then
  echo "worker service unexpectedly owns the scheduler" >&2
  exit 1
fi
REMOTE
}

validate_sources
load_git_basis
probe_hosts
print_basis

if [[ "$mode" == "--check" ]]; then
  echo "deployment_check=ok"
  exit 0
fi

require_idle_queue
initial_source_commit="$source_commit"
bundle_root=""
trap '[[ -n "${bundle_root:-}" && -d "$bundle_root" ]] && rm -rf "$bundle_root"' EXIT
build_payload
load_git_basis
[[ "$source_commit" == "$initial_source_commit" ]] || fail "HEAD changed while building the CLI payload"
require_idle_queue

local_node=$(command -v node)
[[ "$local_node" == /* ]] || fail "local node is unavailable"
install_payload_local
developer_payload=$(install_payload_remote "$QUEUE_HOST")
mini_payload=$(install_payload_remote "$MINI_HOST")
developer_node=$(resolve_remote_node "$QUEUE_HOST")
mini_node=$(resolve_remote_node "$MINI_HOST")
install_mini_relay_tunnel
verify_mini_relay_tunnel

controller_identity=$(read_local_identity) || fail "controller identity is unavailable from the deployed payload"
developer_identity=$(read_remote_identity "$QUEUE_HOST" "$developer_node" "$developer_payload") || fail "$QUEUE_HOST identity is unavailable from the deployed payload"
mini_identity=$(read_remote_identity "$MINI_HOST" "$mini_node" "$mini_payload") || fail "$MINI_HOST identity is unavailable from the deployed payload"
IFS=$'\t' read -r controller_machine_id controller_account_id <<<"$controller_identity"
IFS=$'\t' read -r developer_machine_id developer_account_id <<<"$developer_identity"
IFS=$'\t' read -r mini_machine_id mini_account_id <<<"$mini_identity"
[[ "$controller_account_id" == "$developer_account_id" && "$controller_account_id" == "$mini_account_id" ]] || \
  fail "all three machines must be paired to the same Happier account"
[[ "$controller_machine_id" != "$developer_machine_id" \
  && "$controller_machine_id" != "$mini_machine_id" \
  && "$developer_machine_id" != "$mini_machine_id" ]] || fail "machine ids must be distinct"

developer_home=$(read_remote_home "$QUEUE_HOST")
mini_home=$(read_remote_home "$MINI_HOST")
developer_workspace_root="$developer_home/.happier/twin-workspaces"
developer_diff_executable="$developer_home/.lan-dev-machine/bin/twin-agent-workspace-diff"
mini_workspace_root="$mini_home/.happier/twin-workspaces"
mini_diff_executable="$mini_home/.lan-dev-machine/bin/twin-agent-workspace-diff"

scheduler_config=$(build_scheduler_config)
install_worker_service "$QUEUE_HOST" "$developer_node" "$developer_payload"
install_worker_service "$MINI_HOST" "$mini_node" "$mini_payload"
install_controller_service

verify_remote_runtime "$QUEUE_HOST" "$developer_node" "$developer_payload" "$developer_machine_id" "$developer_account_id"
verify_remote_runtime "$MINI_HOST" "$mini_node" "$mini_payload" "$mini_machine_id" "$mini_account_id"
verify_local_runtime
verify_mini_relay_tunnel

load_git_basis
[[ "$source_commit" == "$initial_source_commit" ]] || fail "HEAD changed during deployment"
printf 'controller_machine_id=%s\n' "$controller_machine_id"
printf 'developer_machine_id=%s\n' "$developer_machine_id"
printf 'mini_machine_id=%s\n' "$mini_machine_id"
echo "deployment=ok"
