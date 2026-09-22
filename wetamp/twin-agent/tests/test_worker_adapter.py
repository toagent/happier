#!/usr/bin/env python3

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ADAPTER = ROOT / "twin-agent-worker.py"


class WorkerAdapterTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.fake_bin = self.root / "bin"
        self.fake_bin.mkdir()
        self.command_log = self.root / "commands.jsonl"
        self.config = self.root / "workers.json"
        self.config.write_text(
            json.dumps(
                {
                    "version": 1,
                    "workers": [
                        {
                            "id": "twin-control",
                            "transport": "ssh",
                            "host": "control-host",
                            "home": "/Users/control",
                            "tmux": "/opt/homebrew/bin/tmux",
                        },
                        {"id": "twin-dev", "transport": "local", "home": "/Users/dev"},
                        {
                            "id": "mac-mini",
                            "transport": "ssh",
                            "host": "mini-host",
                            "home": "/Users/mini",
                            "tmux": "/opt/homebrew/bin/tmux",
                        },
                    ],
                }
            ),
            encoding="utf-8",
        )
        self.env = os.environ.copy()
        self.env.update(
            {
                "PATH": f"{self.fake_bin}:{self.env['PATH']}",
                "TWIN_AGENT_WORKERS_FILE": str(self.config),
                "TWIN_AGENT_WORKER_POLL_SECONDS": "0",
                "FAKE_COMMAND_LOG": str(self.command_log),
            }
        )

    def tearDown(self):
        self.temp_dir.cleanup()

    def run_adapter(self, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["python3", str(ADAPTER), *args],
            check=check,
            capture_output=True,
            text=True,
            env=self.env,
            timeout=10,
        )

    def events(self) -> list[dict[str, object]]:
        if not self.command_log.exists():
            return []
        return [json.loads(line) for line in self.command_log.read_text(encoding="utf-8").splitlines()]

    def install_command_logger(self, name: str, body: str = "raise SystemExit(0)") -> Path:
        command = self.fake_bin / name
        command.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, pathlib, sys\n"
            "with pathlib.Path(os.environ['FAKE_COMMAND_LOG']).open('a', encoding='utf-8') as handle:\n"
            f"    handle.write(json.dumps({{'command': {name!r}, 'args': sys.argv[1:]}}) + '\\n')\n"
            f"{body}\n",
            encoding="utf-8",
        )
        command.chmod(0o700)
        return command

    def test_config_requires_exact_production_worker_ids_and_rejects_unknown(self):
        valid = self.run_adapter("validate", "mac-mini")
        self.assertIn("worker_id=mac-mini", valid.stdout)
        self.assertIn("transport=ssh", valid.stdout)
        self.assertIn("host=mini-host", valid.stdout)
        self.assertIn("tmux=/opt/homebrew/bin/tmux", valid.stdout)

        unknown = self.run_adapter("validate", "unknown-worker", check=False)
        self.assertNotEqual(0, unknown.returncode)
        self.assertIn("unknown worker", unknown.stderr)

        value = json.loads(self.config.read_text(encoding="utf-8"))
        value["workers"] = value["workers"][:-1]
        self.config.write_text(json.dumps(value), encoding="utf-8")
        incomplete = self.run_adapter("validate", "twin-dev", check=False)
        self.assertNotEqual(0, incomplete.returncode)
        self.assertIn("required worker ids", incomplete.stderr)

    def test_local_worker_executes_the_existing_job_runner(self):
        job = self.root / "queue" / "jobs" / "20260922020000-aaaaaa"
        job.mkdir(parents=True)
        runner = self.install_command_logger("job-runner")
        self.env["TWIN_AGENT_JOB_RUNNER_BIN"] = str(runner)

        result = self.run_adapter(
            "launch",
            str(job),
            "twin-dev",
            "codex",
            "read_only",
            "remote_workspace",
            "/tmp/work",
            "/tmp/work",
        )

        self.assertEqual(0, result.returncode)
        event = self.events()[-1]
        self.assertEqual("job-runner", event["command"])
        self.assertEqual(str(job.resolve()), event["args"][0])
        self.assertEqual("twin-dev", (job / "execution_worker_id").read_text(encoding="utf-8").strip())
        self.assertEqual("local", (job / "worker_transport").read_text(encoding="utf-8").strip())

    def test_ssh_worker_uses_isolated_remote_job_and_syncs_results_back(self):
        job_id = "20260922020100-bbbbbb"
        job = self.root / "queue" / "jobs" / job_id
        workspace = job / "workspace"
        workspace.mkdir(parents=True)
        (job / "prompt.txt").write_text("inspect\n", encoding="utf-8")
        (workspace / "tracked.txt").write_text("source\n", encoding="utf-8")

        self.install_command_logger(
            "ssh",
            "if 'has-session' in sys.argv:\n"
            "    raise SystemExit(1)\n"
            "raise SystemExit(0)",
        )
        self.install_command_logger(
            "rsync",
            "source, destination = sys.argv[-2:]\n"
            "if ':' in source:\n"
            "    target = pathlib.Path(destination)\n"
            "    target.mkdir(parents=True, exist_ok=True)\n"
            "    (target / 'finished_at').write_text('2026-09-22T00:00:00Z\\n', encoding='utf-8')\n"
            "    (target / 'exit_code').write_text('0\\n', encoding='utf-8')\n"
            "    (target / 'changes.patch').write_text('patch\\n', encoding='utf-8')\n"
            "raise SystemExit(0)",
        )

        result = self.run_adapter(
            "launch",
            str(job),
            "mac-mini",
            "codex",
            "read_only",
            "local_snapshot",
            str(workspace),
            str(workspace),
        )

        self.assertEqual(0, result.returncode)
        self.assertEqual("0", (job / "exit_code").read_text(encoding="utf-8").strip())
        self.assertEqual("patch", (job / "changes.patch").read_text(encoding="utf-8").strip())
        self.assertEqual("mac-mini", (job / "execution_worker_id").read_text(encoding="utf-8").strip())
        self.assertEqual("ssh", (job / "worker_transport").read_text(encoding="utf-8").strip())
        ssh_args = [event["args"] for event in self.events() if event["command"] == "ssh"]
        self.assertTrue(
            any(
                "mini-host" in args
                and "/opt/homebrew/bin/tmux" in args
                and "new-session" in args
                for args in ssh_args
            )
        )
        self.assertTrue(any(f"twin-worker-{job_id}" in args for args in ssh_args))
        rsync_args = [event["args"] for event in self.events() if event["command"] == "rsync"]
        self.assertEqual(2, len(rsync_args))
        self.assertIn("mini-host:/Users/mini/.twin-agent-worker/jobs/", " ".join(rsync_args[0]))
        self.assertIn("mini-host:/Users/mini/.twin-agent-worker/jobs/", " ".join(rsync_args[1]))

    def test_cancel_kills_only_the_selected_remote_worker_session(self):
        job_id = "20260922020200-cccccc"
        job = self.root / "queue" / "jobs" / job_id
        job.mkdir(parents=True)
        self.install_command_logger("ssh")
        self.install_command_logger(
            "rsync",
            "source, destination = sys.argv[-2:]\n"
            "if ':' in source:\n"
            "    target = pathlib.Path(destination)\n"
            "    target.mkdir(parents=True, exist_ok=True)\n"
            "    (target / 'changes.patch').write_text('partial patch\\n', encoding='utf-8')\n"
            "raise SystemExit(0)",
        )

        result = self.run_adapter("cancel", str(job), "twin-control")

        self.assertEqual(0, result.returncode)
        ssh_events = [event for event in self.events() if event["command"] == "ssh"]
        self.assertTrue(
            any(
                "control-host" in event["args"]
                and "/opt/homebrew/bin/tmux" in event["args"]
                and "kill-session" in event["args"]
                and f"twin-worker-{job_id}" in event["args"]
                for event in ssh_events
            )
        )
        self.assertEqual("partial patch", (job / "changes.patch").read_text(encoding="utf-8").strip())

    def test_cancel_fails_when_the_remote_worker_cannot_be_reached(self):
        job_id = "20260922020300-dddddd"
        job = self.root / "queue" / "jobs" / job_id
        job.mkdir(parents=True)
        self.install_command_logger(
            "ssh",
            "if 'kill-session' in sys.argv:\n"
            "    raise SystemExit(255)\n"
            "raise SystemExit(0)",
        )
        self.install_command_logger("rsync")

        result = self.run_adapter("cancel", str(job), "mac-mini", check=False)

        self.assertNotEqual(0, result.returncode)
        self.assertFalse((job / "changes.patch").exists())

    def test_health_checks_the_configured_tmux_and_worker_runtime(self):
        self.install_command_logger(
            "ssh",
            "if 'control-host' in sys.argv and '/opt/homebrew/bin/tmux' in sys.argv:\n"
            "    raise SystemExit(1)\n"
            "raise SystemExit(0)",
        )

        result = self.run_adapter("health")

        self.assertEqual(0, result.returncode)
        self.assertIn("worker_id=twin-control transport=ssh host=control-host state=unavailable", result.stdout)
        self.assertIn("worker_id=mac-mini transport=ssh host=mini-host state=ready", result.stdout)
        ssh_args = [event["args"] for event in self.events() if event["command"] == "ssh"]
        self.assertTrue(
            any(
                "mini-host" in args
                and "test" in args
                and "/opt/homebrew/bin/tmux" in args
                and "/Users/mini/.lan-dev-machine/bin/twin-agent-job-runner" in args
                for args in ssh_args
            )
        )


if __name__ == "__main__":
    unittest.main()
