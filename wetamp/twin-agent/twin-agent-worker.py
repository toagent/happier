#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import re
import shlex
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import NoReturn


REQUIRED_WORKER_IDS = {"twin-control", "twin-dev", "mac-mini"}
JOB_ID_PATTERN = re.compile(r"^[0-9]{14}-[a-f0-9]{6}$")
SAFE_HOST_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SAFE_ABSOLUTE_PATH_PATTERN = re.compile(
    r"^/(?:[A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+$"
)
SAFE_RELATIVE_PATTERN = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*$"
)


class WorkerConfigError(ValueError):
    pass


@dataclass(frozen=True)
class Worker:
    worker_id: str
    transport: str
    home: PurePosixPath
    ai_node_bin: PurePosixPath
    host: str | None = None
    tmux: PurePosixPath | None = None
    login_shell: PurePosixPath | None = None

    @property
    def runtime_bin(self) -> PurePosixPath:
        return self.home / ".lan-dev-machine" / "bin"

    @property
    def worker_base(self) -> PurePosixPath:
        return self.home / ".twin-agent-worker"

    @property
    def workspace_root(self) -> PurePosixPath:
        return self.home / "work" / "_mcp_workspace"

    @property
    def required_executables(self) -> tuple[PurePosixPath, ...]:
        executables = [
            self.runtime_bin / "twin-agent-job-runner",
            self.runtime_bin / "twin-agent-worker",
            self.runtime_bin / "twin-agent-remote",
            self.runtime_bin / "twin-agent-runner",
            self.runtime_bin / "twin-agent-output",
            self.runtime_bin / "twin-agent-stats",
            self.ai_node_bin / "codex",
            self.ai_node_bin / "claude",
            self.home / ".opencode" / "bin" / "opencode",
        ]
        if self.tmux is not None:
            executables.insert(0, self.tmux)
        if self.login_shell is not None:
            executables.insert(0, self.login_shell)
        return tuple(executables)


def fail(message: str, code: int = 2) -> NoReturn:
    print(message, file=sys.stderr)
    raise SystemExit(code)


def load_workers(path: Path) -> dict[str, Worker]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise WorkerConfigError(f"worker config unreadable: {path}: {exc}") from exc
    if payload.get("version") != 1 or not isinstance(payload.get("workers"), list):
        raise WorkerConfigError("worker config must contain version=1 and a workers array")

    workers: dict[str, Worker] = {}
    for item in payload["workers"]:
        if not isinstance(item, dict):
            raise WorkerConfigError("worker entries must be objects")
        worker_id = item.get("id")
        transport = item.get("transport")
        home = item.get("home")
        host = item.get("host")
        tmux = item.get("tmux")
        ai_node_bin = item.get("ai_node_bin")
        login_shell = item.get("login_shell")
        if worker_id not in REQUIRED_WORKER_IDS or worker_id in workers:
            raise WorkerConfigError(f"invalid or duplicate worker id: {worker_id}")
        if transport not in {"local", "ssh"}:
            raise WorkerConfigError(f"invalid transport for {worker_id}: {transport}")
        if not isinstance(home, str) or not home.startswith("/") or "\n" in home:
            raise WorkerConfigError(f"invalid home for {worker_id}")
        if not isinstance(ai_node_bin, str) or not SAFE_ABSOLUTE_PATH_PATTERN.fullmatch(
            ai_node_bin
        ):
            raise WorkerConfigError(f"invalid ai_node_bin for {worker_id}")
        if transport == "ssh" and (
            not isinstance(host, str) or not SAFE_HOST_PATTERN.fullmatch(host)
        ):
            raise WorkerConfigError(f"invalid ssh host for {worker_id}")
        if transport == "ssh" and (
            not isinstance(tmux, str) or not SAFE_ABSOLUTE_PATH_PATTERN.fullmatch(tmux)
        ):
            raise WorkerConfigError(f"invalid tmux path for {worker_id}")
        if transport == "ssh" and (
            not isinstance(login_shell, str)
            or not SAFE_ABSOLUTE_PATH_PATTERN.fullmatch(login_shell)
        ):
            raise WorkerConfigError(f"invalid login_shell for {worker_id}")
        if transport == "local" and host is not None:
            raise WorkerConfigError(f"local worker {worker_id} must not define host")
        if transport == "local" and tmux is not None:
            raise WorkerConfigError(f"local worker {worker_id} must not define tmux")
        if transport == "local" and login_shell is not None:
            raise WorkerConfigError(f"local worker {worker_id} must not define login_shell")
        workers[worker_id] = Worker(
            worker_id=worker_id,
            transport=transport,
            home=PurePosixPath(home),
            ai_node_bin=PurePosixPath(ai_node_bin),
            host=host,
            tmux=PurePosixPath(tmux) if tmux is not None else None,
            login_shell=PurePosixPath(login_shell) if login_shell is not None else None,
        )

    if set(workers) != REQUIRED_WORKER_IDS:
        raise WorkerConfigError(
            "worker config must contain exactly the required worker ids: "
            + ", ".join(sorted(REQUIRED_WORKER_IDS))
        )
    if workers["twin-dev"].transport != "local":
        raise WorkerConfigError("twin-dev must be the local queue-host worker")
    if workers["twin-control"].transport != "ssh" or workers["mac-mini"].transport != "ssh":
        raise WorkerConfigError("twin-control and mac-mini must use ssh transport")
    return workers


def config_path() -> Path:
    configured = os.environ.get("TWIN_AGENT_WORKERS_FILE")
    if configured:
        return Path(configured)
    return Path.home() / ".config" / "twin-agent" / "workers.json"


def worker_for(worker_id: str) -> Worker:
    try:
        workers = load_workers(config_path())
    except WorkerConfigError as exc:
        fail(str(exc))
    worker = workers.get(worker_id)
    if worker is None:
        fail(f"unknown worker: {worker_id}")
    return worker


def atomic_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(f"{value}\n", encoding="utf-8")
    temporary.replace(path)


def run(command: list[str], *, check: bool = True, capture_output: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        check=check,
        capture_output=capture_output,
        text=True,
    )


def ssh_command(worker: Worker, remote_args: list[str]) -> list[str]:
    assert worker.host is not None
    ssh_bin = os.environ.get("TWIN_AGENT_SSH_BIN", "ssh")
    return [
        ssh_bin,
        "-o",
        "BatchMode=yes",
        worker.host,
        *remote_args,
    ]


def validate_job(job: Path) -> str:
    job_id = job.name
    if not JOB_ID_PATTERN.fullmatch(job_id) or not job.is_dir():
        fail("invalid job directory")
    return job_id


def remote_workspace_paths(
    worker: Worker,
    job: Path,
    workspace_mode: str,
    run_cwd: str,
    work: str,
) -> tuple[PurePosixPath, PurePosixPath]:
    remote_job = worker.worker_base / "jobs" / job.name
    if workspace_mode == "local_snapshot":
        local_work = Path(work).resolve()
        local_cwd = Path(run_cwd).resolve()
        try:
            relative_cwd = local_cwd.relative_to(local_work)
        except ValueError:
            fail("local snapshot cwd escaped its workspace")
        remote_work = remote_job / "workspace"
        return remote_work / PurePosixPath(relative_cwd.as_posix()), remote_work

    requested_path = job / "requested_cwd"
    requested = requested_path.read_text(encoding="utf-8").strip() if requested_path.exists() else run_cwd
    if not SAFE_RELATIVE_PATTERN.fullmatch(requested):
        fail("invalid remote workspace path")
    remote_work = worker.workspace_root / requested
    return remote_work, remote_work


def record_worker(job: Path, worker: Worker, execution_cwd: str | None = None) -> None:
    atomic_text(job / "execution_worker_id", worker.worker_id)
    atomic_text(job / "worker_transport", worker.transport)
    atomic_text(job / "execution_host", worker.host or "localhost")
    if execution_cwd is not None:
        atomic_text(job / "execution_cwd", execution_cwd)


def launch_local(
    worker: Worker,
    job: Path,
    agent: str,
    mode: str,
    workspace_mode: str,
    run_cwd: str,
    work: str,
) -> NoReturn:
    runner = os.environ.get(
        "TWIN_AGENT_JOB_RUNNER_BIN",
        str(worker.runtime_bin / "twin-agent-job-runner"),
    )
    os.execvpe(
        runner,
        [runner, str(job), agent, mode, workspace_mode, run_cwd, work],
        {**os.environ, "AI_NODE_BIN": str(worker.ai_node_bin)},
    )


def sync_progress(worker: Worker, remote_job: PurePosixPath, job: Path) -> None:
    result = run(
        ssh_command(worker, ["cat", str(remote_job / "progress.json")]),
        check=False,
        capture_output=True,
    )
    if result.returncode == 0 and result.stdout:
        temporary = job / f"progress.json.{os.getpid()}.tmp"
        temporary.write_text(result.stdout, encoding="utf-8")
        temporary.replace(job / "progress.json")


def cancel_remote(worker: Worker, job_id: str) -> subprocess.CompletedProcess[str]:
    assert worker.tmux is not None
    session = f"twin-worker-{job_id}"
    return run(
        ssh_command(worker, [str(worker.tmux), "kill-session", "-t", session]),
        check=False,
    )


def sync_remote_results(worker: Worker, remote_job: PurePosixPath, job: Path) -> bool:
    assert worker.host is not None
    rsync_bin = os.environ.get("TWIN_AGENT_RSYNC_BIN", "rsync")
    result = run(
        [
            rsync_bin,
            "-a",
            "--exclude=workspace",
            f"{worker.host}:{remote_job}/",
            f"{job}/",
        ],
        check=False,
    )
    return result.returncode == 0


def prepare_remote_job(job: Path, run_cwd: str, work: str) -> int:
    validate_job(job)
    atomic_text(job / "run_cwd", run_cwd)
    atomic_text(job / "work", work)
    return 0


def finalize_cancelled_job(job: Path) -> int:
    validate_job(job)
    workspace_mode = (job / "workspace_mode").read_text(encoding="utf-8").strip()
    work_path = job / "work"
    work = Path(work_path.read_text(encoding="utf-8").strip()) if work_path.exists() else job / "workspace"
    if workspace_mode == "local_snapshot" and work.is_dir():
        status = run(["git", "-C", str(work), "status", "--short"], check=False, capture_output=True)
        (job / "git-status.txt").write_text(status.stdout, encoding="utf-8")
        run(["git", "-C", str(work), "add", "-A"], check=False)
        baseline_path = job / "baseline_commit"
        if baseline_path.exists():
            diff = run(
                [
                    "git",
                    "-C",
                    str(work),
                    "diff",
                    "--cached",
                    "--binary",
                    baseline_path.read_text(encoding="utf-8").strip(),
                ],
                check=False,
                capture_output=True,
            )
            (job / "changes.patch").write_text(diff.stdout, encoding="utf-8")
    elif workspace_mode == "remote_workspace" and work.is_dir():
        status = run(["git", "-C", str(work), "status", "--short"], check=False, capture_output=True)
        (job / "git-status.txt").write_text(status.stdout, encoding="utf-8")
    return 0


def launch_ssh(
    worker: Worker,
    job: Path,
    agent: str,
    mode: str,
    workspace_mode: str,
    run_cwd: str,
    work: str,
) -> int:
    job_id = job.name
    remote_job = worker.worker_base / "jobs" / job_id
    remote_run_cwd, remote_work = remote_workspace_paths(
        worker,
        job,
        workspace_mode,
        run_cwd,
        work,
    )
    session = f"twin-worker-{job_id}"
    rsync_bin = os.environ.get("TWIN_AGENT_RSYNC_BIN", "rsync")
    poll_seconds = max(0.0, float(os.environ.get("TWIN_AGENT_WORKER_POLL_SECONDS", "2")))
    assert worker.host is not None
    assert worker.tmux is not None
    assert worker.login_shell is not None

    run(ssh_command(worker, ["mkdir", "-p", str(remote_job), str(remote_work)]))
    outbound = [rsync_bin, "-a", "--delete"]
    if workspace_mode == "remote_workspace":
        outbound.extend(["--exclude=workspace"])
    outbound.extend([f"{job}/", f"{worker.host}:{remote_job}/"])
    run(outbound)

    runner = worker.runtime_bin / "twin-agent-job-runner"
    remote_adapter = worker.runtime_bin / "twin-agent-worker"
    remote_helper = worker.runtime_bin / "twin-agent-remote"
    runner_helper = worker.runtime_bin / "twin-agent-runner"
    output_helper = worker.runtime_bin / "twin-agent-output"
    stats_helper = worker.runtime_bin / "twin-agent-stats"
    run(
        ssh_command(
            worker,
            [str(remote_adapter), "prepare", str(remote_job), str(remote_run_cwd), str(remote_work)],
        )
    )
    record_worker(job, worker, str(remote_run_cwd))
    remote_command = [
        str(worker.tmux),
        "new-session",
        "-d",
        "-s",
        session,
        str(worker.login_shell),
        "-lic",
        'exec "$@"',
        "twin-agent-worker",
        "env",
        f"TWIN_AGENT_BASE={worker.worker_base}",
        "TWIN_AGENT_NOTIFY_SCHEDULER=0",
        "TWIN_AGENT_ARCHIVE_STATS=0",
        f"TWIN_AGENT_REMOTE_HELPER={remote_helper}",
        f"TWIN_AGENT_RUNNER_BIN={runner_helper}",
        f"TWIN_AGENT_OUTPUT_BIN={output_helper}",
        f"TWIN_AGENT_STATS_BIN={stats_helper}",
        f"AI_NODE_BIN={worker.ai_node_bin}",
        str(runner),
        str(remote_job),
        agent,
        mode,
        workspace_mode,
        str(remote_run_cwd),
        str(remote_work),
    ]
    run(ssh_command(worker, [shlex.join(remote_command)]))

    cancelled = False

    def stop_remote(_signum: int, _frame: object) -> None:
        nonlocal cancelled
        cancelled = True
        cancel_remote(worker, job_id)

    previous_term = signal.signal(signal.SIGTERM, stop_remote)
    previous_int = signal.signal(signal.SIGINT, stop_remote)
    try:
        while not cancelled:
            status = run(
                ssh_command(
                    worker,
                    [str(worker.tmux), "has-session", "-t", session],
                ),
                check=False,
            )
            if status.returncode == 1:
                break
            if status.returncode != 0:
                time.sleep(poll_seconds)
                continue
            sync_progress(worker, remote_job, job)
            time.sleep(poll_seconds)
    finally:
        signal.signal(signal.SIGTERM, previous_term)
        signal.signal(signal.SIGINT, previous_int)

    while not cancelled and not sync_remote_results(worker, remote_job, job):
        time.sleep(poll_seconds)
    if cancelled:
        return 143
    if not (job / "exit_code").exists() or not (job / "finished_at").exists():
        atomic_text(job / "exit_code", "75")
        atomic_text(job / "finished_at", datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"))
        atomic_text(job / "last_failure_reason", "worker_result_missing")
        atomic_text(job / "final.txt", f"worker {worker.worker_id} exited without a complete result")
        return 75
    try:
        return int((job / "exit_code").read_text(encoding="utf-8").strip())
    except ValueError:
        return 75


def command_validate(worker_id: str) -> int:
    worker = worker_for(worker_id)
    print(f"worker_id={worker.worker_id}")
    print(f"transport={worker.transport}")
    print(f"host={worker.host or 'localhost'}")
    print(f"home={worker.home}")
    if worker.tmux is not None:
        print(f"tmux={worker.tmux}")
    if worker.login_shell is not None:
        print(f"login_shell={worker.login_shell}")
    print(f"ai_node_bin={worker.ai_node_bin}")
    print(f"workspace_root={worker.workspace_root}")
    return 0


def command_launch(args: list[str]) -> int:
    if len(args) != 7:
        fail("usage: launch <job> <worker_id> <agent> <mode> <workspace_mode> <run_cwd> <work>")
    job = Path(args[0]).resolve()
    validate_job(job)
    worker = worker_for(args[1])
    agent, mode, workspace_mode, run_cwd, work = args[2:]
    if worker.transport == "local":
        record_worker(job, worker, run_cwd)
        launch_local(worker, job, agent, mode, workspace_mode, run_cwd, work)
    return launch_ssh(worker, job, agent, mode, workspace_mode, run_cwd, work)


def command_cancel(args: list[str]) -> int:
    if len(args) != 2:
        fail("usage: cancel <job> <worker_id>")
    job = Path(args[0]).resolve()
    job_id = validate_job(job)
    worker = worker_for(args[1])
    if worker.transport == "ssh":
        cancelled = cancel_remote(worker, job_id)
        if cancelled.returncode not in {0, 1}:
            return cancelled.returncode
        remote_job = worker.worker_base / "jobs" / job_id
        remote_adapter = worker.runtime_bin / "twin-agent-worker"
        finalized = run(
            ssh_command(worker, [str(remote_adapter), "finalize-cancel", str(remote_job)]),
            check=False,
        )
        if finalized.returncode != 0:
            return finalized.returncode
        if not sync_remote_results(worker, remote_job, job):
            return 74
    return 0


def command_health() -> int:
    workers = load_workers(config_path())
    for worker_id in sorted(workers):
        worker = workers[worker_id]
        if worker.transport == "local":
            state = (
                "ready"
                if all(
                    Path(path).is_file() and os.access(path, os.X_OK)
                    for path in worker.required_executables
                )
                else "unavailable"
            )
        else:
            test_args = ["test"]
            for index, executable in enumerate(worker.required_executables):
                if index:
                    test_args.append("-a")
                test_args.extend(["-x", str(executable)])
            state = (
                "ready"
                if run(ssh_command(worker, test_args), check=False).returncode == 0
                else "unavailable"
            )
        print(
            f"worker_id={worker.worker_id} transport={worker.transport} "
            f"host={worker.host or 'localhost'} state={state}"
        )
    return 0


def main(argv: list[str]) -> int:
    if not argv:
        fail("usage: twin-agent-worker.py {validate|launch|cancel|health} ...")
    command, *args = argv
    if command == "validate" and len(args) == 1:
        return command_validate(args[0])
    if command == "launch":
        return command_launch(args)
    if command == "cancel":
        return command_cancel(args)
    if command == "prepare" and len(args) == 3:
        return prepare_remote_job(Path(args[0]).resolve(), args[1], args[2])
    if command == "finalize-cancel" and len(args) == 1:
        return finalize_cancelled_job(Path(args[0]).resolve())
    if command == "health" and not args:
        return command_health()
    fail("usage: twin-agent-worker.py {validate|launch|cancel|health} ...")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
