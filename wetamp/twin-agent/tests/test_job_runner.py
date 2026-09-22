#!/usr/bin/env python3

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
JOB_RUNNER = ROOT / "twin-agent-job-runner"
RUNNER = ROOT / "twin-agent-runner.py"
OUTPUT = ROOT / "twin-agent-output.py"


class JobRunnerTest(unittest.TestCase):
    def make_executable(self, path: Path, content: str) -> None:
        path.write_text(content, encoding="utf-8")
        path.chmod(0o700)

    def make_job(self, root: Path) -> tuple[Path, Path, dict[str, str]]:
        job = root / "job"
        work = root / "work"
        fake_bin = root / "bin"
        home = root / "home"
        job.mkdir()
        work.mkdir()
        fake_bin.mkdir()
        home.mkdir()
        (job / "prompt.txt").write_text("执行最小检查\n", encoding="utf-8")
        (job / "model").write_text("sonnet\n", encoding="utf-8")
        (job / "timeout_seconds").write_text("10\n", encoding="utf-8")
        (job / "primary_timeout_seconds").write_text("2\n", encoding="utf-8")
        (job / "idle_timeout_seconds").write_text("2\n", encoding="utf-8")
        (job / "fallback_agent").write_text("codex\n", encoding="utf-8")
        (job / "max_attempts").write_text("2\n", encoding="utf-8")

        self.make_executable(
            fake_bin / "claude",
            "#!/bin/bash\ncat >/dev/null\nprintf '%s\\n' '{\"type\":\"result\",\"subtype\":\"error\",\"is_error\":true,\"total_cost_usd\":0.02,\"usage\":{\"input_tokens\":3}}'\nexit 1\n",
        )
        self.make_executable(
            fake_bin / "codex",
            "#!/bin/bash\nout=''\nwhile [[ $# -gt 0 ]]; do\n  if [[ \"$1\" == '--output-last-message' ]]; then out=\"$2\"; shift 2; else shift; fi\ndone\ncat >/dev/null\nprintf 'Codex fallback recovered\\n' > \"$out\"\nprintf 'codex trace\\n'\n",
        )
        remote = root / "remote-helper"
        self.make_executable(remote, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$REMOTE_HELPER_LOG\"\nexit 0\n")
        env = os.environ.copy()
        env.update(
            {
                "HOME": str(home),
                "AI_NODE_BIN": str(fake_bin),
                "TWIN_AGENT_RUNNER_BIN": str(RUNNER),
                "TWIN_AGENT_OUTPUT_BIN": str(OUTPUT),
                "TWIN_AGENT_REMOTE_HELPER": str(remote),
                "TWIN_AGENT_STATS_BIN": str(root / "missing-stats"),
                "REMOTE_HELPER_LOG": str(root / "remote-helper.log"),
            }
        )
        return job, work, env

    def run_job(self, job: Path, work: Path, env: dict[str, str], mode: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [str(JOB_RUNNER), str(job), "claude", mode, "remote_workspace", str(work), str(work)],
            check=False,
            capture_output=True,
            text=True,
            env=env,
            timeout=20,
        )

    def test_read_only_claude_failure_falls_back_to_codex(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            job, work, env = self.make_job(Path(temp_dir))
            result = self.run_job(job, work, env, "read_only")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((job / "attempt_count").read_text().strip(), "2")
            self.assertEqual((job / "fallback_used").read_text().strip(), "1")
            self.assertEqual((job / "effective_agent").read_text().strip(), "codex")
            self.assertEqual((job / "final.txt").read_text().strip(), "Codex fallback recovered")
            attempts = [json.loads(line) for line in (job / "attempts.jsonl").read_text().splitlines()]
            self.assertEqual([attempt["agent"] for attempt in attempts], ["claude", "codex"])
            self.assertEqual(attempts[0]["provider_metrics"]["total_cost_usd"], 0.02)

    def test_write_mode_never_falls_back(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            job, work, env = self.make_job(Path(temp_dir))
            result = self.run_job(job, work, env, "write")
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((job / "attempt_count").read_text().strip(), "1")
            self.assertEqual((job / "fallback_used").read_text().strip(), "0")
            attempts = (job / "attempts.jsonl").read_text().splitlines()
            self.assertEqual(len(attempts), 1)

    def test_remote_worker_does_not_start_a_second_scheduler(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            job, work, env = self.make_job(Path(temp_dir))
            env["TWIN_AGENT_NOTIFY_SCHEDULER"] = "0"

            result = self.run_job(job, work, env, "read_only")

            self.assertEqual(result.returncode, 0, result.stderr)
            calls = Path(env["REMOTE_HELPER_LOG"]).read_text(encoding="utf-8").splitlines()
            self.assertIn("compact-one job", calls)
            self.assertNotIn("start-scheduler", calls)

            local_root = Path(temp_dir) / "local"
            local_root.mkdir()
            second_job, second_work, local_env = self.make_job(local_root)
            local_result = self.run_job(second_job, second_work, local_env, "read_only")
            self.assertEqual(local_result.returncode, 0, local_result.stderr)
            local_calls = Path(local_env["REMOTE_HELPER_LOG"]).read_text(encoding="utf-8").splitlines()
            self.assertIn("start-scheduler", local_calls)


if __name__ == "__main__":
    unittest.main()
