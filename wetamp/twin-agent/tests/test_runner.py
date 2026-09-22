#!/usr/bin/env python3

import subprocess
import sys
import tempfile
import unittest
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "twin-agent-runner.py"


class RunnerTest(unittest.TestCase):
    def run_command(
        self,
        temp: Path,
        timeout: int,
        code: str,
        *,
        idle_timeout: int = 0,
        startup_grace: int = 120,
    ) -> subprocess.CompletedProcess:
        stdin = temp / "stdin.txt"
        stdout = temp / "stdout.txt"
        stderr = temp / "stderr.txt"
        marker = temp / "timed_out"
        reason = temp / "timeout_reason"
        progress = temp / "progress.json"
        stdin.write_text("input\n", encoding="utf-8")
        return subprocess.run(
            [
                str(RUNNER),
                "--timeout",
                str(timeout),
                "--cwd",
                str(temp),
                "--stdin",
                str(stdin),
                "--stdout",
                str(stdout),
                "--stderr",
                str(stderr),
                "--timeout-marker",
                str(marker),
                "--idle-timeout",
                str(idle_timeout),
                "--startup-grace",
                str(startup_grace),
                "--timeout-reason",
                str(reason),
                "--progress",
                str(progress),
                "--",
                sys.executable,
                "-c",
                code,
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=15,
        )

    def test_captures_output_and_exit_code(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            result = self.run_command(
                temp,
                5,
                "import sys; print(sys.stdin.read().strip()); print('err', file=sys.stderr)",
            )
            self.assertEqual(result.returncode, 0)
            self.assertEqual((temp / "stdout.txt").read_text(encoding="utf-8").strip(), "input")
            self.assertEqual((temp / "stderr.txt").read_text(encoding="utf-8").strip(), "err")
            self.assertFalse((temp / "timed_out").exists())

    def test_timeout_terminates_process_group(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            result = self.run_command(
                temp,
                1,
                "import time; print('started', flush=True); time.sleep(5)",
            )
            self.assertEqual(result.returncode, 124)
            self.assertTrue((temp / "timed_out").exists())
            self.assertEqual((temp / "timeout_reason").read_text(encoding="utf-8").strip(), "hard_timeout")
            self.assertEqual((temp / "stdout.txt").read_text(encoding="utf-8").strip(), "started")

    def test_idle_timeout_after_output(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            result = self.run_command(
                temp,
                5,
                "import time; print('started', flush=True); time.sleep(5)",
                idle_timeout=1,
                startup_grace=3,
            )
            self.assertEqual(result.returncode, 125)
            self.assertEqual((temp / "timeout_reason").read_text(encoding="utf-8").strip(), "idle_timeout")
            progress = json.loads((temp / "progress.json").read_text(encoding="utf-8"))
            self.assertEqual(progress["terminal_reason"], "idle_timeout")

    def test_startup_timeout_without_output(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            result = self.run_command(
                temp,
                5,
                "import time; time.sleep(5)",
                idle_timeout=2,
                startup_grace=1,
            )
            self.assertEqual(result.returncode, 125)
            self.assertEqual((temp / "timeout_reason").read_text(encoding="utf-8").strip(), "startup_timeout")

    def test_progress_updates_preserve_job_context(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            (temp / "progress.json").write_text(
                json.dumps({"phase": "starting", "attempt": 1, "agent": "codex"}),
                encoding="utf-8",
            )
            result = self.run_command(temp, 5, "print('ok')")
            self.assertEqual(result.returncode, 0)
            progress = json.loads((temp / "progress.json").read_text(encoding="utf-8"))
            self.assertEqual(progress["phase"], "starting")
            self.assertEqual(progress["attempt"], 1)
            self.assertEqual(progress["agent"], "codex")
            self.assertEqual(progress["state"], "finished")


if __name__ == "__main__":
    unittest.main()
