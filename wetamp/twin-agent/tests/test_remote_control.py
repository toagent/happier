#!/usr/bin/env python3

import json
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REMOTE = ROOT / "twin-agent-remote"


class RemoteControlTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.base = self.root / "state"
        self.fake_bin = self.root / "bin"
        self.fake_bin.mkdir()
        tmux = self.fake_bin / "tmux"
        tmux.write_text(
            "#!/bin/sh\n"
            "if [ \"$1\" = 'list-sessions' ]; then echo 'no server running on /tmp/tmux' >&2; exit 1; fi\n"
            "if [ \"$1\" = 'has-session' ]; then echo \"can't find session\" >&2; exit 1; fi\n"
            "exit 0\n",
            encoding="utf-8",
        )
        tmux.chmod(0o700)
        self.env = os.environ.copy()
        self.env["PATH"] = f"{self.fake_bin}:{self.env['PATH']}"
        self.env["TWIN_AGENT_BASE"] = str(self.base)
        self.env["TWIN_AGENT_STATS_BIN"] = str(ROOT / "twin-agent-stats")

    def tearDown(self):
        self.temp_dir.cleanup()

    def make_job(self, job_id: str, *, queued: bool = False, exit_code: int = 0) -> Path:
        job = self.base / "jobs" / job_id
        job.mkdir(parents=True)
        metadata = {
            "job_id": job_id,
            "collaboration_id": "collab-test",
            "caller": "codex",
            "agent": "codex",
            "mode": "read_only",
            "workspace_mode": "remote_workspace",
            "remote_cwd": "/tmp/work",
            "created_at": "2026-09-15T00:00:00Z",
        }
        (job / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
        (job / "workspace_mode").write_text("remote_workspace\n", encoding="utf-8")
        (job / "run_cwd").write_text("/tmp/work\n", encoding="utf-8")
        if queued:
            (job / "queued_at").write_text("2026-09-15T00:00:01Z\n", encoding="utf-8")
        else:
            (job / "started_at").write_text("2026-09-15T00:00:01Z\n", encoding="utf-8")
            (job / "finished_at").write_text("2026-09-15T00:00:02Z\n", encoding="utf-8")
            (job / "exit_code").write_text(f"{exit_code}\n", encoding="utf-8")
            (job / "final.txt").write_text("远端结果\n", encoding="utf-8")
        return job

    def run_remote(self, *args: str) -> str:
        result = subprocess.run(
            [str(REMOTE), *args],
            check=True,
            capture_output=True,
            text=True,
            env=self.env,
            timeout=10,
        )
        return result.stdout

    def test_pending_result_collection_and_collaboration_state(self):
        job_id = "20260915000000-aaaaaa"
        job = self.make_job(job_id)
        self.assertIn(f"job_id={job_id}", self.run_remote("pending", "collab-test", "codex", "10"))
        before = self.run_remote("collaboration-state", "collab-test", "codex")
        self.assertIn("active=0", before)
        self.assertIn("uncollected=1", before)

        result = self.run_remote("result", job_id, "5000")
        self.assertIn("远端结果", result)
        self.assertIn("newly_collected=1", result)
        self.assertIn("result_collection_delay_seconds=", result)
        self.assertTrue((job / "result_collected_at").exists())
        self.assertIn("pending=0", self.run_remote("pending", "collab-test", "codex", "10"))
        after = self.run_remote("collaboration-state", "collab-test", "codex")
        self.assertIn("uncollected=0", after)

    def test_wait_returns_terminal_result_and_active_jobs_block_close(self):
        finished_id = "20260915000001-bbbbbb"
        self.make_job(finished_id)
        output = self.run_remote("wait", finished_id, "1", "5000")
        self.assertIn("state=finished", output)
        self.assertIn("newly_collected=1", output)

        self.make_job("20260915000002-cccccc", queued=True)
        state = self.run_remote("collaboration-state", "collab-test", "codex")
        self.assertIn("queued=1", state)
        self.assertIn("active=1", state)

    def test_failed_job_can_be_rejected_but_not_accepted(self):
        job_id = "20260915000003-dddddd"
        job = self.make_job(job_id, exit_code=1)
        evaluation = {
            "job_id": job_id,
            "collaboration_id": "collab-test",
            "caller": "codex",
            "verdict": "rejected",
            "summary": "进程失败且没有有效交付",
            "evaluated_at": "2026-09-15T00:00:03Z",
        }
        (job / "evaluation.json").write_text(json.dumps(evaluation), encoding="utf-8")
        output = self.run_remote("evaluate", job_id)
        self.assertIn("verdict=rejected", output)

        evaluation["verdict"] = "accepted"
        (job / "evaluation.json").write_text(json.dumps(evaluation), encoding="utf-8")
        result = subprocess.run(
            [str(REMOTE), "evaluate", job_id],
            capture_output=True,
            text=True,
            env=self.env,
            timeout=10,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("accepted requires a process-success job", result.stderr)

    def test_expired_job_cleanup_does_not_block_new_work(self):
        expired_id = "20260901000000-eeeeee"
        expired = self.make_job(expired_id)
        old_timestamp = time.time() - (9 * 24 * 60 * 60)
        os.utime(expired, (old_timestamp, old_timestamp))

        fake_rm = self.fake_bin / "rm"
        fake_rm.write_text(
            "#!/bin/sh\n"
            f"case \"$*\" in *{expired_id}*) sleep 5; echo 'simulated cleanup denial' >&2; exit 1;; esac\n"
            "exec /bin/rm \"$@\"\n",
            encoding="utf-8",
        )
        fake_rm.chmod(0o700)

        new_id = "20260922000000-ffffff"
        new_job = self.base / "jobs" / new_id
        new_job.mkdir(parents=True)
        (new_job / "prompt.txt").write_text("inspect\n", encoding="utf-8")
        (new_job / "metadata.json").write_text(
            json.dumps(
                {
                    "job_id": new_id,
                    "requested_agent": "codex",
                    "agent": "codex",
                    "mode": "read_only",
                    "workspace_mode": "remote_workspace",
                    "remote_cwd": "/tmp/work",
                    "created_at": "2026-09-22T00:00:00Z",
                }
            ),
            encoding="utf-8",
        )
        self.env["TWIN_AGENT_RUNNER_BIN"] = "/usr/bin/true"
        self.env["TWIN_AGENT_OUTPUT_BIN"] = "/usr/bin/true"
        self.env["TWIN_AGENT_JOB_RUNNER_BIN"] = "/usr/bin/true"
        self.env["TWIN_AGENT_REMOTE_WORKSPACE_ROOT"] = str(self.root / "workspaces")

        started = time.monotonic()
        output = self.run_remote(
            "start",
            new_id,
            "codex",
            "read_only",
            "remote_workspace",
            "review",
        )
        elapsed = time.monotonic() - started

        self.assertIn(f"job_id={new_id}", output)
        self.assertIn("cleanup_scheduled=1", output)
        self.assertLess(elapsed, 2)
        self.assertTrue(expired.exists())

    def test_cleanup_failure_is_recorded_without_deleting_the_job(self):
        expired_id = "20260901000000-eeeeee"
        expired = self.make_job(expired_id)
        old_timestamp = time.time() - (9 * 24 * 60 * 60)
        os.utime(expired, (old_timestamp, old_timestamp))

        fake_rm = self.fake_bin / "rm"
        fake_rm.write_text(
            "#!/bin/sh\n"
            f"case \"$*\" in *{expired_id}*) exit 1;; esac\n"
            "exec /bin/rm \"$@\"\n",
            encoding="utf-8",
        )
        fake_rm.chmod(0o700)

        output = self.run_remote("cleanup-old", "7")

        self.assertIn("cleanup_failures=1", output)
        self.assertTrue(expired.exists())
        cleanup_log = self.base / "history" / "cleanup-errors.log"
        self.assertIn(expired_id, cleanup_log.read_text(encoding="utf-8"))

    def test_health_reports_zero_cleanup_failures_without_stderr(self):
        home = self.root / "home"
        runtime_config = home / ".config" / "ai-runtime"
        runtime_config.mkdir(parents=True)
        (runtime_config / "env.zsh").write_text(
            f"AI_NODE_BIN={self.fake_bin}\n",
            encoding="utf-8",
        )
        for name in ("codex", "claude"):
            executable = self.fake_bin / name
            executable.write_text("#!/bin/sh\necho test-version\n", encoding="utf-8")
            executable.chmod(0o700)
        opencode = home / ".opencode" / "bin" / "opencode"
        opencode.parent.mkdir(parents=True)
        opencode.write_text("#!/bin/sh\necho test-version\n", encoding="utf-8")
        opencode.chmod(0o700)
        self.env["HOME"] = str(home)
        self.env["TWIN_AGENT_OUTPUT_BIN"] = "/usr/bin/true"
        self.env["TWIN_AGENT_JOB_RUNNER_BIN"] = "/usr/bin/true"

        result = subprocess.run(
            [str(REMOTE), "health"],
            check=True,
            capture_output=True,
            text=True,
            env=self.env,
            timeout=10,
        )

        self.assertIn("cleanup_failures_total=0", result.stdout)
        self.assertEqual("", result.stderr)

    def test_local_snapshot_baseline_does_not_run_user_commit_hooks(self):
        job_id = "20260922000001-aaaaaa"
        job = self.base / "jobs" / job_id
        workspace = job / "workspace"
        workspace.mkdir(parents=True)
        (workspace / "tracked.txt").write_text("snapshot\n", encoding="utf-8")
        (job / "snapshot-files.z").write_bytes(b"tracked.txt\0")
        (job / "prompt.txt").write_text("inspect\n", encoding="utf-8")
        (job / "metadata.json").write_text(
            json.dumps(
                {
                    "job_id": job_id,
                    "requested_agent": "codex",
                    "agent": "codex",
                    "mode": "read_only",
                    "workspace_mode": "local_snapshot",
                    "local_root": "/tmp/source",
                    "local_head": "0123456789abcdef",
                    "local_cwd": "/tmp/source",
                    "created_at": "2026-09-22T00:00:00Z",
                }
            ),
            encoding="utf-8",
        )

        hooks = self.root / "hooks"
        hooks.mkdir()
        hook_marker = self.root / "pre-commit-ran"
        pre_commit = hooks / "pre-commit"
        pre_commit.write_text(
            "#!/bin/sh\n"
            f"touch '{hook_marker}'\n"
            "exit 91\n",
            encoding="utf-8",
        )
        pre_commit.chmod(0o700)

        self.env["GIT_CONFIG_COUNT"] = "1"
        self.env["GIT_CONFIG_KEY_0"] = "core.hooksPath"
        self.env["GIT_CONFIG_VALUE_0"] = str(hooks)
        self.env["TWIN_AGENT_RUNNER_BIN"] = "/usr/bin/true"
        self.env["TWIN_AGENT_OUTPUT_BIN"] = "/usr/bin/true"
        self.env["TWIN_AGENT_JOB_RUNNER_BIN"] = "/usr/bin/true"

        output = self.run_remote(
            "start",
            job_id,
            "codex",
            "read_only",
            "local_snapshot",
            ".",
        )

        self.assertIn(f"job_id={job_id}", output)
        self.assertFalse(hook_marker.exists())
        baseline = (job / "baseline_commit").read_text(encoding="utf-8").strip()
        resolved = subprocess.run(
            ["git", "-C", str(workspace), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
            env=self.env,
            timeout=10,
        ).stdout.strip()
        self.assertEqual(baseline, resolved)


if __name__ == "__main__":
    unittest.main()
