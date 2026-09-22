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


if __name__ == "__main__":
    unittest.main()
