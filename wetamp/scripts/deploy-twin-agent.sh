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
REPO_ROOT="${TWIN_AGENT_REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd -P)}"
SOURCE_DIR="$REPO_ROOT/wetamp/twin-agent"
WORKERS_CONFIG="$REPO_ROOT/wetamp/config/twin-agent-workers.json"
LOCAL_RUNTIME="${TWIN_AGENT_LOCAL_RUNTIME:-$HOME/.lan-dev-machine/twin-agent}"
LOCAL_BIN="${TWIN_AGENT_LOCAL_BIN:-$HOME/.lan-dev-machine/bin}"
LOCAL_BACKUP_ROOT="${TWIN_AGENT_LOCAL_BACKUP_ROOT:-$HOME/.lan-dev-machine/backups/twin-agent}"
QUEUE_HOST="${TWIN_AGENT_QUEUE_HOST:-twin-dev}"
MINI_HOST="${TWIN_AGENT_MINI_HOST:-twin-mini}"
SSH_BIN="${TWIN_AGENT_SSH_BIN:-ssh}"
SCP_BIN="${TWIN_AGENT_SCP_BIN:-scp}"
DEPLOY_TIMESTAMP="${TWIN_AGENT_DEPLOY_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"

SERVER_FILES=(
  server.mjs
  execution-policy.mjs
  operation-timeouts.mjs
  collaboration-policy.mjs
  workspace-paths.mjs
  collaboration-report.py
  package.json
  package-lock.json
  README.md
)
WORKER_SOURCES=(
  twin-agent-queue-client
  twin-agent-workspace-diff
  twin-agent-remote
  twin-agent-job-runner
  twin-agent-worker.py
  twin-agent-runner.py
  twin-agent-output.py
  twin-agent-stats
)
WORKER_TARGETS=(
  twin-agent-queue-client
  twin-agent-workspace-diff
  twin-agent-remote
  twin-agent-job-runner
  twin-agent-worker
  twin-agent-runner
  twin-agent-output
  twin-agent-stats
)
DEPLOY_PATHS=(
  wetamp/twin-agent
  wetamp/config/twin-agent-workers.json
  wetamp/scripts/deploy-twin-agent.sh
)

validate_sources() {
  local file worker_id
  for file in "${SERVER_FILES[@]}" "${WORKER_SOURCES[@]}"; do
    [[ -f "$SOURCE_DIR/$file" ]] || fail "deployment source missing: $SOURCE_DIR/$file"
  done
  [[ -f "$WORKERS_CONFIG" ]] || fail "worker config missing: $WORKERS_CONFIG"

  node --check "$SOURCE_DIR/server.mjs" >/dev/null
  bash -n "$SOURCE_DIR/twin-agent-remote"
  bash -n "$SOURCE_DIR/twin-agent-workspace-diff"
  bash -n "$SOURCE_DIR/twin-agent-job-runner"
  python3 - "$SOURCE_DIR/twin-agent-worker.py" <<'PY'
import ast
import pathlib
import sys

source = pathlib.Path(sys.argv[1])
ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
PY
  for worker_id in twin-control twin-dev mac-mini; do
    TWIN_AGENT_WORKERS_FILE="$WORKERS_CONFIG" \
      python3 "$SOURCE_DIR/twin-agent-worker.py" validate "$worker_id" >/dev/null
  done
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
  printf 'queue_host=%s\n' "$QUEUE_HOST"
  printf 'mini_host=%s\n' "$MINI_HOST"
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

backup_local_file() {
  local target="$1" relative="$2" backup_root="$3"
  [[ -f "$target" ]] || return 0
  install -d -m 0700 "$backup_root/$(dirname "$relative")"
  cp -p "$target" "$backup_root/$relative"
}

install_local_runtime() {
  local backup_root="$LOCAL_BACKUP_ROOT/$DEPLOY_TIMESTAMP" file index target
  install -d -m 0700 "$backup_root/server" "$backup_root/bin" "$LOCAL_RUNTIME" "$LOCAL_BIN"
  for file in "${SERVER_FILES[@]}"; do
    backup_local_file "$LOCAL_RUNTIME/$file" "server/$file" "$backup_root"
    case "$file" in
      *.py) install -m 0700 "$SOURCE_DIR/$file" "$LOCAL_RUNTIME/$file" ;;
      *) install -m 0600 "$SOURCE_DIR/$file" "$LOCAL_RUNTIME/$file" ;;
    esac
    cmp -s "$SOURCE_DIR/$file" "$LOCAL_RUNTIME/$file" || fail "local server install mismatch: $file"
  done

  for index in "${!WORKER_SOURCES[@]}"; do
    file=${WORKER_SOURCES[$index]}
    target=${WORKER_TARGETS[$index]}
    backup_local_file "$LOCAL_BIN/$target" "bin/$target" "$backup_root"
    install -m 0700 "$SOURCE_DIR/$file" "$LOCAL_BIN/$target"
    cmp -s "$SOURCE_DIR/$file" "$LOCAL_BIN/$target" || fail "local worker install mismatch: $target"
  done

  printf '%s\n' "$source_commit" > "$LOCAL_RUNTIME/.source-commit"
  chmod 0600 "$LOCAL_RUNTIME/.source-commit"
  (
    cd "$LOCAL_RUNTIME"
    node -e "Promise.all([import('@modelcontextprotocol/sdk/server/mcp.js'), import('zod')])" >/dev/null
  )
}

build_worker_bundle() {
  local index file target
  bundle_root=$(mktemp -d "${TMPDIR:-/tmp}/twin-agent-bundle.XXXXXX")
  bundle_archive="$bundle_root/twin-agent-runtime.tar.gz"
  install -d -m 0700 "$bundle_root/payload/bin" "$bundle_root/payload/config"
  for index in "${!WORKER_SOURCES[@]}"; do
    file=${WORKER_SOURCES[$index]}
    target=${WORKER_TARGETS[$index]}
    install -m 0700 "$SOURCE_DIR/$file" "$bundle_root/payload/bin/$target"
  done
  install -m 0600 "$WORKERS_CONFIG" "$bundle_root/payload/config/workers.json"
  printf '%s\n' "$source_commit" > "$bundle_root/payload/source-commit"
  tar -czf "$bundle_archive" -C "$bundle_root/payload" .
  archive_name=".twin-agent-deploy-$DEPLOY_TIMESTAMP.tar.gz"
}

install_remote_runtime() {
  local host="$1" install_config="$2"
  "$SCP_BIN" -q "$bundle_archive" "$host:$archive_name"
  "$SSH_BIN" -o BatchMode=yes -o ConnectTimeout=10 "$host" \
    bash -s -- "$archive_name" "$DEPLOY_TIMESTAMP" "$install_config" "$source_commit" <<'REMOTE'
set -euo pipefail
umask 077

archive_name="$1"
timestamp="$2"
install_config="$3"
source_commit="$4"
archive="$HOME/$archive_name"
stage=$(mktemp -d "${TMPDIR:-/tmp}/twin-agent-install.XXXXXX")
cleanup() {
  rm -f "$archive"
  rm -rf "$stage"
}
trap cleanup EXIT

tar -xzf "$archive" -C "$stage"
bin="$HOME/.lan-dev-machine/bin"
backup="$HOME/.lan-dev-machine/backups/twin-agent/$timestamp"
config="$HOME/.config/twin-agent/workers.json"
files=(
  twin-agent-queue-client
  twin-agent-workspace-diff
  twin-agent-remote
  twin-agent-job-runner
  twin-agent-worker
  twin-agent-runner
  twin-agent-output
  twin-agent-stats
)

install -d -m 0700 "$bin" "$backup/bin"
for file in "${files[@]}"; do
  if [[ -f "$bin/$file" ]]; then
    cp -p "$bin/$file" "$backup/bin/$file"
  fi
  install -m 0700 "$stage/bin/$file" "$bin/$file"
  cmp -s "$stage/bin/$file" "$bin/$file"
done

if [[ "$install_config" == "1" ]]; then
  install -d -m 0700 "$HOME/.config/twin-agent" "$backup/config"
  if [[ -f "$config" ]]; then
    cp -p "$config" "$backup/config/workers.json"
  fi
  install -m 0600 "$stage/config/workers.json" "$config"
  cmp -s "$stage/config/workers.json" "$config"
fi

install -m 0600 "$stage/source-commit" "$HOME/.lan-dev-machine/twin-agent-source-commit"
[[ "$(cat "$HOME/.lan-dev-machine/twin-agent-source-commit")" == "$source_commit" ]]
REMOTE
}

verify_remote_runtime() {
  local host="$1" install_config="$2"
  "$SSH_BIN" -o BatchMode=yes -o ConnectTimeout=10 "$host" \
    bash -s -- "$source_commit" "$install_config" <<'REMOTE'
set -euo pipefail
source_commit="$1"
install_config="$2"
[[ "$(cat "$HOME/.lan-dev-machine/twin-agent-source-commit")" == "$source_commit" ]]
for file in twin-agent-queue-client twin-agent-workspace-diff twin-agent-remote twin-agent-job-runner twin-agent-worker twin-agent-runner twin-agent-output twin-agent-stats; do
  [[ -x "$HOME/.lan-dev-machine/bin/$file" ]]
done
if [[ "$install_config" == "1" ]]; then
  TWIN_AGENT_WORKERS_FILE="$HOME/.config/twin-agent/workers.json" \
    "$HOME/.lan-dev-machine/bin/twin-agent-worker" validate twin-dev >/dev/null
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
bundle_root=""
trap '[[ -n "${bundle_root:-}" ]] && rm -rf "$bundle_root"' EXIT
build_worker_bundle
install_local_runtime
install_remote_runtime "$QUEUE_HOST" 1
install_remote_runtime "$MINI_HOST" 0
verify_remote_runtime "$QUEUE_HOST" 1
verify_remote_runtime "$MINI_HOST" 0

health=$("$SSH_BIN" -o BatchMode=yes -o ConnectTimeout=10 "$QUEUE_HOST" \
  '~/.lan-dev-machine/bin/twin-agent-remote health')
printf '%s\n' "$health"
if grep -q 'state=unavailable' <<<"$health"; then
  fail "deployed runtime reports an unavailable worker"
fi
echo "deployment=ok"
