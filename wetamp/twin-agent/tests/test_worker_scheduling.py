#!/usr/bin/env python3

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REMOTE = ROOT / "twin-agent-remote"


class WorkerSchedulingTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.base = self.root / "state"
        self.fake_bin = self.root / "bin"
        self.fake_bin.mkdir()
        self.tmux_state = self.root / "tmux-state"
        self.tmux_state.mkdir()
        self.tmux_log = self.root / "tmux.jsonl"
        self.adapter_log = self.root / "adapter.jsonl"

        tmux = self.fake_bin / "tmux"
        tmux.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, pathlib, sys\n"
            "state = pathlib.Path(os.environ['FAKE_TMUX_STATE'])\n"
            "log = pathlib.Path(os.environ['FAKE_TMUX_LOG'])\n"
            "args = sys.argv[1:]\n"
            "command = args[0] if args else ''\n"
            "def target(flag):\n"
            "    return args[args.index(flag) + 1]\n"
            "if command == 'list-sessions':\n"
            "    sessions = sorted(item.name for item in state.iterdir())\n"
            "    if not sessions:\n"
            "        print('no server running on /tmp/tmux', file=sys.stderr)\n"
            "        raise SystemExit(1)\n"
            "    print('\\n'.join(sessions))\n"
            "elif command == 'has-session':\n"
            "    if not (state / target('-t')).exists():\n"
            "        print(\"can't find session\", file=sys.stderr)\n"
            "        raise SystemExit(1)\n"
            "elif command == 'new-session':\n"
            "    name = target('-s')\n"
            "    (state / name).touch()\n"
            "    with log.open('a', encoding='utf-8') as handle:\n"
            "        handle.write(json.dumps(args) + '\\n')\n"
            "elif command == 'kill-session':\n"
            "    (state / target('-t')).unlink(missing_ok=True)\n"
            "elif command == '-V':\n"
            "    print('tmux test')\n",
            encoding="utf-8",
        )
        tmux.chmod(0o700)

        adapter = self.fake_bin / "twin-agent-worker"
        adapter.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, pathlib, sys\n"
            "args = sys.argv[1:]\n"
            "with pathlib.Path(os.environ['FAKE_ADAPTER_LOG']).open('a', encoding='utf-8') as handle:\n"
            "    handle.write(json.dumps(args) + '\\n')\n"
            "if args and args[0] == 'validate':\n"
            "    if len(args) != 2 or args[1] not in {'twin-control', 'twin-dev', 'mac-mini'}:\n"
            "        print('unknown worker', file=sys.stderr)\n"
            "        raise SystemExit(2)\n"
            "    print('transport=' + ('local' if args[1] == 'twin-dev' else 'ssh'))\n"
            "if args and args[0] == 'cancel' and os.environ.get('FAKE_ADAPTER_CANCEL_FAIL') == '1':\n"
            "    print('worker unreachable', file=sys.stderr)\n"
            "    raise SystemExit(7)\n",
            encoding="utf-8",
        )
        adapter.chmod(0o700)

        self.env = os.environ.copy()
        self.env.update(
            {
                "PATH": f"{self.fake_bin}:{self.env['PATH']}",
                "TWIN_AGENT_BASE": str(self.base),
                "TWIN_AGENT_STATS_BIN": str(ROOT / "twin-agent-stats"),
                "TWIN_AGENT_RUNNER_BIN": "/usr/bin/true",
                "TWIN_AGENT_OUTPUT_BIN": "/usr/bin/true",
                "TWIN_AGENT_JOB_RUNNER_BIN": "/usr/bin/true",
                "TWIN_AGENT_WORKER_ADAPTER_BIN": str(adapter),
                "TWIN_AGENT_REMOTE_WORKSPACE_ROOT": str(self.root / "workspaces"),
                "FAKE_TMUX_STATE": str(self.tmux_state),
                "FAKE_TMUX_LOG": str(self.tmux_log),
                "FAKE_ADAPTER_LOG": str(self.adapter_log),
            }
        )

    def tearDown(self):
        self.temp_dir.cleanup()

    def prepare_job(self, job_id: str) -> None:
        job = self.base / "jobs" / job_id
        job.mkdir(parents=True)
        (job / "prompt.txt").write_text("inspect\n", encoding="utf-8")
        (job / "metadata.json").write_text(
            json.dumps(
                {
                    "job_id": job_id,
                    "requested_agent": "codex",
                    "agent": "codex",
                    "mode": "read_only",
                    "workspace_mode": "remote_workspace",
                    "remote_cwd": "review",
                }
            ),
            encoding="utf-8",
        )

    def run_remote(self, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(REMOTE), *args],
            check=check,
            capture_output=True,
            text=True,
            env=self.env,
            timeout=10,
        )

    def adapter_events(self) -> list[list[str]]:
        if not self.adapter_log.exists():
            return []
        return [json.loads(line) for line in self.adapter_log.read_text(encoding="utf-8").splitlines()]

    def acquire_lease(
        self,
        lease_id: str,
        worker_id: str = "twin-dev",
        owner_token: str = "owner-token",
        *,
        check: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        return self.run_remote(
            "lease-acquire",
            lease_id,
            worker_id,
            owner_token,
            check=check,
        )

    def test_three_workers_share_one_fifo_and_the_fourth_job_stays_queued(self):
        specs = [
            ("20260922010000-aaaaaa", "twin-control"),
            ("20260922010001-bbbbbb", "twin-dev"),
            ("20260922010002-cccccc", "mac-mini"),
            ("20260922010003-dddddd", "twin-control"),
        ]
        outputs = []
        for job_id, worker_id in specs:
            self.prepare_job(job_id)
            outputs.append(
                self.run_remote(
                    "start",
                    job_id,
                    "codex",
                    "read_only",
                    "remote_workspace",
                    "review",
                    worker_id,
                ).stdout
            )

        self.assertTrue(all("state=running" in output for output in outputs[:3]))
        self.assertIn("state=queued", outputs[3])
        self.assertIn("queue_position=1", outputs[3])
        queue = self.run_remote("queue").stdout
        self.assertIn("running=3", queue)
        self.assertIn("queued=1", queue)
        self.assertIn("max_concurrent=3", queue)
        for job_id, worker_id in specs:
            self.assertEqual(
                worker_id,
                (self.base / "jobs" / job_id / "worker_id").read_text(encoding="utf-8").strip(),
            )

        tmux_events = [
            json.loads(line)
            for line in self.tmux_log.read_text(encoding="utf-8").splitlines()
        ]
        launches = [event for event in tmux_events if "launch" in event]
        self.assertEqual(
            ["twin-control", "twin-dev", "mac-mini"],
            [event[event.index("launch") + 2] for event in launches],
        )

    def test_unknown_worker_is_rejected_before_enqueue(self):
        job_id = "20260922010100-eeeeee"
        self.prepare_job(job_id)

        result = self.run_remote(
            "start",
            job_id,
            "codex",
            "read_only",
            "remote_workspace",
            "review",
            "unknown-worker",
            check=False,
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn("unknown worker", result.stderr)
        self.assertFalse((self.base / "jobs" / job_id / "queued_at").exists())

    def test_cancel_routes_to_the_worker_that_owns_the_running_process(self):
        job_id = "20260922010200-ffffff"
        self.prepare_job(job_id)
        self.run_remote(
            "start",
            job_id,
            "codex",
            "read_only",
            "remote_workspace",
            "review",
            "mac-mini",
        )

        result = self.run_remote("cancel", job_id, "user_request")

        self.assertIn("state=cancelled", result.stdout)
        self.assertIn(["cancel", str(self.base / "jobs" / job_id), "mac-mini"], self.adapter_events())

    def test_cancel_does_not_claim_success_when_the_worker_cannot_be_stopped(self):
        job_id = "20260922010300-abcabc"
        self.prepare_job(job_id)
        self.run_remote(
            "start",
            job_id,
            "codex",
            "read_only",
            "remote_workspace",
            "review",
            "mac-mini",
        )
        self.env["FAKE_ADAPTER_CANCEL_FAIL"] = "1"

        result = self.run_remote("cancel", job_id, "user_request", check=False)

        self.assertNotEqual(0, result.returncode)
        self.assertIn("worker cancellation failed", result.stderr)
        self.assertFalse((self.base / "jobs" / job_id / "cancelled_at").exists())
        self.assertIn("state=running", self.run_remote("status", job_id).stdout)

    def test_interactive_session_leases_and_jobs_share_one_fifo_and_capacity(self):
        first_job = "20260922010400-aaaaaa"
        second_job = "20260922010401-bbbbbb"
        queued_job = "20260922010402-cccccc"
        self.prepare_job(first_job)
        self.prepare_job(second_job)
        self.prepare_job(queued_job)

        self.assertIn(
            "state=running",
            self.run_remote(
                "start",
                first_job,
                "codex",
                "read_only",
                "remote_workspace",
                "review",
                "twin-control",
            ).stdout,
        )
        self.assertIn(
            "state=acquired",
            self.acquire_lease("session-lease-1", "twin-dev", "owner-1").stdout,
        )
        self.assertIn(
            "state=running",
            self.run_remote(
                "start",
                second_job,
                "codex",
                "read_only",
                "remote_workspace",
                "review",
                "mac-mini",
            ).stdout,
        )
        queued = self.run_remote(
            "start",
            queued_job,
            "codex",
            "read_only",
            "remote_workspace",
            "review",
            "twin-control",
        ).stdout

        self.assertIn("state=queued", queued)
        self.assertIn("queue_position=1", queued)
        queue = self.run_remote("queue").stdout
        self.assertIn("running=3", queue)
        self.assertIn("queued=1", queue)
        self.assertIn(f"job:{queued_job}", queue)

    def test_releasing_a_lease_makes_the_oldest_mixed_queue_entry_dispatchable(self):
        active_job_a = "20260922010500-aaaaaa"
        active_job_b = "20260922010501-bbbbbb"
        oldest_queued_job = "20260922010502-cccccc"
        for job_id in (active_job_a, active_job_b, oldest_queued_job):
            self.prepare_job(job_id)

        self.acquire_lease("session-active", "twin-dev", "owner-active")
        for job_id, worker_id in (
            (active_job_a, "twin-control"),
            (active_job_b, "mac-mini"),
        ):
            self.run_remote(
                "start",
                job_id,
                "codex",
                "read_only",
                "remote_workspace",
                "review",
                worker_id,
            )
        self.run_remote(
            "start",
            oldest_queued_job,
            "codex",
            "read_only",
            "remote_workspace",
            "review",
            "twin-control",
        )
        queued_lease = self.acquire_lease("session-queued", "twin-dev", "owner-queued").stdout
        self.assertIn("state=queued", queued_lease)
        self.assertIn("queue_position=2", queued_lease)

        released = self.run_remote(
            "lease-release",
            "session-active",
            "owner-active",
        ).stdout
        self.assertIn("state=released", released)
        self.assertTrue((self.tmux_state / "twin-scheduler").exists())

        dispatched = self.run_remote("dispatch", oldest_queued_job).stdout
        self.assertIn("state=running", dispatched)
        self.assertIn(
            "state=queued",
            self.run_remote("lease-status", "session-queued", "owner-queued").stdout,
        )

    def test_acquired_lease_survives_controller_process_restarts_until_explicit_release(self):
        self.assertIn(
            "state=acquired",
            self.acquire_lease("session-recovery", "mac-mini", "owner-recovery").stdout,
        )

        recovered = self.run_remote(
            "lease-status",
            "session-recovery",
            "owner-recovery",
        ).stdout

        self.assertIn("state=acquired", recovered)
        self.assertIn("worker_id=mac-mini", recovered)
        self.assertIn("running=1", self.run_remote("queue").stdout)

    def test_lease_identity_and_owner_checks_fail_closed(self):
        first = self.acquire_lease("session-owned", "twin-dev", "owner-a")
        duplicate = self.acquire_lease("session-owned", "twin-dev", "owner-a")
        wrong_worker = self.acquire_lease(
            "session-owned",
            "mac-mini",
            "owner-a",
            check=False,
        )
        wrong_status = self.run_remote(
            "lease-status",
            "session-owned",
            "owner-b",
            check=False,
        )
        wrong_release = self.run_remote(
            "lease-release",
            "session-owned",
            "owner-b",
            check=False,
        )
        unknown_worker = self.acquire_lease(
            "session-unknown-worker",
            "missing-worker",
            "owner-c",
            check=False,
        )

        self.assertIn("state=acquired", first.stdout)
        self.assertIn("state=acquired", duplicate.stdout)
        self.assertNotEqual(0, wrong_worker.returncode)
        self.assertIn("lease worker mismatch", wrong_worker.stderr)
        self.assertNotEqual(0, wrong_status.returncode)
        self.assertIn("lease owner mismatch", wrong_status.stderr)
        self.assertNotEqual(0, wrong_release.returncode)
        self.assertIn("lease owner mismatch", wrong_release.stderr)
        self.assertNotEqual(0, unknown_worker.returncode)
        self.assertIn("unknown worker", unknown_worker.stderr)
        self.assertFalse((self.base / "leases" / "session-unknown-worker").exists())
        owner_digest = (self.base / "leases" / "session-owned" / "owner_digest").read_text(
            encoding="utf-8"
        ).strip()
        self.assertNotEqual("owner-a", owner_digest)
        self.assertEqual(64, len(owner_digest))


if __name__ == "__main__":
    unittest.main()
