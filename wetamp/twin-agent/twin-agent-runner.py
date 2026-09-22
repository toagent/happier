#!/usr/bin/env python3
"""Run one AI CLI command with portable process-group timeout handling."""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


def open_output(path: str):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    return target.open("wb", buffering=0)


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def atomic_write(path: Path | None, content: str) -> None:
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.replace(path)


def atomic_update_json(path: Path | None, values: dict) -> None:
    if path is None:
        return
    try:
        current = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(current, dict):
            current = {}
    except (OSError, json.JSONDecodeError):
        current = {}
    current.update(values)
    atomic_write(path, json.dumps(current, separators=(",", ":")) + "\n")


def output_size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def terminate_process_group(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--timeout", type=int, required=True)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--stdin", required=True)
    parser.add_argument("--stdout", required=True)
    parser.add_argument("--stderr", required=True)
    parser.add_argument("--timeout-marker", required=True)
    parser.add_argument("--idle-timeout", type=int, default=0)
    parser.add_argument("--startup-grace", type=int, default=120)
    parser.add_argument("--progress")
    parser.add_argument("--pid-file")
    parser.add_argument("--timeout-reason")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()

    if not 1 <= args.timeout <= 7200:
        parser.error("timeout must be between 1 and 7200 seconds")
    if not 0 <= args.idle_timeout <= 7200:
        parser.error("idle-timeout must be between 0 and 7200 seconds")
    if not 1 <= args.startup_grace <= 7200:
        parser.error("startup-grace must be between 1 and 7200 seconds")
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("command is required")

    stdout_path = Path(args.stdout)
    stderr_path = Path(args.stderr)
    progress_path = Path(args.progress) if args.progress else None
    pid_path = Path(args.pid_file) if args.pid_file else None
    timeout_reason_path = Path(args.timeout_reason) if args.timeout_reason else None
    stdin_handle = Path(args.stdin).open("rb")
    stdout_handle = open_output(args.stdout)
    if args.stderr == args.stdout:
        stderr_handle = subprocess.STDOUT
        stderr_file = None
    else:
        stderr_file = open_output(args.stderr)
        stderr_handle = stderr_file

    try:
        process = subprocess.Popen(
            command,
            cwd=args.cwd,
            env=os.environ.copy(),
            stdin=stdin_handle,
            stdout=stdout_handle,
            stderr=stderr_handle,
            start_new_session=True,
        )
        atomic_write(pid_path, f"{process.pid}\n")
        started = time.monotonic()
        last_activity = started
        last_activity_at = iso_now()
        last_sizes = (output_size(stdout_path), output_size(stderr_path))
        saw_output = any(last_sizes)
        next_progress = 0.0
        exit_code: int | None = None
        terminal_reason = "completed"

        while exit_code is None:
            polled = process.poll()
            if polled is not None:
                exit_code = polled
                terminal_reason = "completed" if polled == 0 else "process_exit"
                break

            now = time.monotonic()
            sizes = (output_size(stdout_path), output_size(stderr_path))
            if sizes != last_sizes:
                last_sizes = sizes
                last_activity = now
                last_activity_at = iso_now()
                saw_output = saw_output or any(sizes)

            elapsed = now - started
            idle_seconds = now - last_activity
            if elapsed >= args.timeout:
                terminal_reason = "hard_timeout"
                atomic_write(Path(args.timeout_marker), "hard_timeout\n")
                atomic_write(timeout_reason_path, "hard_timeout\n")
                terminate_process_group(process)
                exit_code = 124
                break

            idle_limit = args.idle_timeout if saw_output else args.startup_grace
            if args.idle_timeout and idle_seconds >= idle_limit:
                terminal_reason = "idle_timeout" if saw_output else "startup_timeout"
                atomic_write(Path(args.timeout_marker), f"{terminal_reason}\n")
                atomic_write(timeout_reason_path, f"{terminal_reason}\n")
                terminate_process_group(process)
                exit_code = 125
                break

            if now >= next_progress:
                atomic_update_json(
                    progress_path,
                    {
                        "state": "running",
                        "pid": process.pid,
                        "updated_at": iso_now(),
                        "last_activity_at": last_activity_at,
                        "elapsed_seconds": round(elapsed, 3),
                        "idle_seconds": round(idle_seconds, 3),
                        "stdout_bytes": sizes[0],
                        "stderr_bytes": sizes[1],
                        "saw_output": saw_output,
                    },
                )
                next_progress = now + 2
            time.sleep(0.5)

        finished = time.monotonic()
        sizes = (output_size(stdout_path), output_size(stderr_path))
        atomic_update_json(
            progress_path,
            {
                "state": "finished",
                "pid": process.pid,
                "updated_at": iso_now(),
                "last_activity_at": last_activity_at,
                "elapsed_seconds": round(finished - started, 3),
                "idle_seconds": round(finished - last_activity, 3),
                "stdout_bytes": sizes[0],
                "stderr_bytes": sizes[1],
                "saw_output": saw_output or any(sizes),
                "exit_code": exit_code,
                "terminal_reason": terminal_reason,
            },
        )
        return exit_code
    finally:
        stdin_handle.close()
        stdout_handle.close()
        if stderr_file is not None:
            stderr_file.close()


if __name__ == "__main__":
    raise SystemExit(main())
