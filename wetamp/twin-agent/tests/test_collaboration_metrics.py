#!/usr/bin/env python3

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STATS = ROOT / "twin-agent-stats"
REPORT = ROOT / "collaboration-report.py"


class CollaborationMetricsTest(unittest.TestCase):
    def make_job(
        self,
        base: Path,
        job_id: str,
        *,
        agent: str,
        exit_code: int | None,
        created_at: str,
        enqueued_at: str,
        started_at: str | None = None,
        finished_at: str | None = None,
        cancelled_at: str | None = None,
        model: str | None = None,
        task_type: str | None = None,
        complexity: str | None = None,
        timeout_seconds: int | None = None,
        transcript: str | None = None,
        cancel_reason: str | None = None,
    ) -> None:
        job = base / "jobs" / job_id
        job.mkdir(parents=True)
        metadata = {
            "job_id": job_id,
            "collaboration_id": "collab-1",
            "caller": "codex",
            "task_title": "统计测试",
            "local_work": "本机实现报表",
            "agent": agent,
            "mode": "read_only",
            "workspace_mode": "remote_workspace",
            "remote_cwd": "/Users/yong/work/_mcp_workspace/metrics-test",
            "created_at": created_at,
        }
        if model:
            metadata["model"] = model
        if task_type:
            metadata["task_type"] = task_type
        if complexity:
            metadata["complexity"] = complexity
        if timeout_seconds:
            metadata["timeout_seconds"] = timeout_seconds
        (job / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
        (job / "enqueued_at").write_text(enqueued_at + "\n", encoding="utf-8")
        if started_at:
            (job / "started_at").write_text(started_at + "\n", encoding="utf-8")
        if finished_at:
            (job / "finished_at").write_text(finished_at + "\n", encoding="utf-8")
        if cancelled_at:
            (job / "cancelled_at").write_text(cancelled_at + "\n", encoding="utf-8")
        if exit_code is not None:
            (job / "exit_code").write_text(f"{exit_code}\n", encoding="utf-8")
        if transcript is not None:
            (job / "transcript.log").write_text(transcript, encoding="utf-8")
        if cancel_reason:
            (job / "cancel_reason").write_text(cancel_reason + "\n", encoding="utf-8")

    def run_stats(self, base: Path, history: Path) -> dict:
        result = subprocess.run(
            [
                str(STATS),
                "report",
                "--base",
                str(base),
                "--history",
                str(history),
                "--date",
                "2026-09-14",
                "--timezone",
                "Asia/Taipei",
                "--include-jobs",
                "--format",
                "json",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        return json.loads(result.stdout)

    def test_remote_metrics_and_durable_archive(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            history = base / "history" / "jobs.jsonl"
            self.make_job(
                base,
                "20260914000000-aaaaaa",
                agent="codex",
                exit_code=0,
                created_at="2026-09-14T00:00:00Z",
                enqueued_at="2026-09-14T00:00:10Z",
                started_at="2026-09-14T00:00:20Z",
                finished_at="2026-09-14T00:01:20Z",
            )
            self.make_job(
                base,
                "20260914010000-bbbbbb",
                agent="claude",
                exit_code=2,
                created_at="2026-09-14T01:00:00Z",
                enqueued_at="2026-09-14T01:00:10Z",
                started_at="2026-09-14T01:00:30Z",
                finished_at="2026-09-14T01:02:30Z",
            )
            self.make_job(
                base,
                "20260914020000-cccccc",
                agent="codex",
                exit_code=None,
                created_at="2026-09-14T02:00:00Z",
                enqueued_at="2026-09-14T02:00:10Z",
                cancelled_at="2026-09-14T02:00:40Z",
            )

            report = self.run_stats(base, history)
            self.assertEqual(report["totals"]["submitted"], 3)
            self.assertEqual(report["totals"]["success"], 1)
            self.assertEqual(report["totals"]["failed"], 1)
            self.assertEqual(report["totals"]["cancelled"], 1)
            self.assertEqual(report["totals"]["execution_success_rate_pct"], 50.0)
            self.assertEqual(report["totals"]["delivery_rate_pct"], 33.33)
            self.assertEqual(report["totals"]["quality_coverage_pct"], 0.0)
            self.assertIsNone(report["totals"]["effective_success_rate_pct"])
            self.assertEqual(report["timing"]["queue_wait"]["count"], 2)
            self.assertEqual(report["timing"]["run"]["total_seconds"], 180.0)
            self.assertEqual(report["timing"]["run"]["p50_seconds"], 60.0)
            self.assertEqual(report["timing"]["run"]["p95_seconds"], 120.0)
            self.assertEqual(report["concurrency"]["busy_wall_seconds"], 180.0)
            self.assertEqual(report["concurrency"]["parallelism_factor"], 1.0)
            self.assertEqual(report["concurrency"]["peak_concurrency"], 1)
            self.assertEqual(report["by_remote_agent"]["codex"]["run"]["total_seconds"], 60.0)
            self.assertEqual(report["by_failure_class"]["process_exit_2"], 1)
            self.assertEqual(report["by_failure_class"]["cancelled:unspecified"], 1)

            subprocess.run(
                [str(STATS), "archive-all", "--base", str(base), "--history", str(history)],
                check=True,
                capture_output=True,
                text=True,
            )
            for job in (base / "jobs").iterdir():
                for child in job.iterdir():
                    child.unlink()
                job.rmdir()
            archived_report = self.run_stats(base, history)
            self.assertEqual(archived_report["totals"], report["totals"])
            self.assertEqual(len(archived_report["jobs"]), 3)

            evaluation = base / "evaluation.json"
            evaluations = base / "history" / "evaluations.jsonl"
            evaluation.write_text(
                json.dumps(
                    {
                        "job_id": "20260914000000-aaaaaa",
                        "collaboration_id": "collab-1",
                        "caller": "codex",
                        "verdict": "accepted",
                        "summary": "证据符合任务要求",
                        "evaluated_at": "2026-09-14T00:03:00Z",
                    }
                ),
                encoding="utf-8",
            )
            subprocess.run(
                [str(STATS), "archive-evaluation", str(evaluation), "--history", str(evaluations)],
                check=True,
                capture_output=True,
                text=True,
            )
            evaluated_report = self.run_stats(base, history)
            self.assertEqual(evaluated_report["totals"]["evaluated"], 1)
            self.assertEqual(evaluated_report["totals"]["quality_coverage_pct"], 100.0)
            self.assertEqual(evaluated_report["totals"]["effective_success_rate_pct"], 50.0)
            self.assertEqual(evaluated_report["totals"]["effective_delivery_rate_pct"], 33.33)

    def test_local_events_are_grouped_with_remote_jobs(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            events = root / "events.jsonl"
            remote_json = root / "remote.json"
            event_rows = [
                {
                    "timestamp": "2026-09-14T00:00:00Z",
                    "collaboration_id": "collab-1",
                    "caller": "codex",
                    "action": "start",
                    "task_title": "统计测试",
                    "summary": "本机先定位统计缺口",
                },
                {
                    "timestamp": "2026-09-14T00:01:00Z",
                    "collaboration_id": "collab-1",
                    "caller": "codex",
                    "action": "delegate_submitted",
                    "task_title": "统计测试",
                    "local_work": "本机实现报表",
                    "job_id": "20260914000000-aaaaaa",
                },
                {
                    "timestamp": "2026-09-14T00:02:00Z",
                    "collaboration_id": "collab-1",
                    "caller": "codex",
                    "action": "finish",
                    "task_title": "统计测试",
                    "summary": "本机完成实现和验证",
                    "outcome": "success",
                },
            ]
            events.write_text("".join(json.dumps(row) + "\n" for row in event_rows), encoding="utf-8")
            remote = {
                "schema_version": 1,
                "date": "2026-09-14",
                "timezone": "Asia/Taipei",
                "totals": {
                    "submitted": 1,
                    "success": 1,
                    "failed": 0,
                    "cancelled": 0,
                    "running": 0,
                    "queued": 0,
                    "execution_success_rate_pct": 100.0,
                    "delivery_rate_pct": 100.0,
                },
                "timing": {
                    "queue_wait": {"count": 1, "total_seconds": 10, "p95_seconds": 10},
                    "run": {
                        "count": 1,
                        "total_seconds": 60,
                        "average_seconds": 60,
                        "p50_seconds": 60,
                        "p95_seconds": 60,
                        "max_seconds": 60,
                    },
                },
                "by_remote_agent": {"codex": {"jobs": 1, "success": 1}},
                "jobs": [],
            }
            remote_json.write_text(json.dumps(remote), encoding="utf-8")
            result = subprocess.run(
                [
                    str(REPORT),
                    "2026-09-14",
                    "--events",
                    str(events),
                    "--remote-json",
                    str(remote_json),
                    "--format",
                    "json",
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            report = json.loads(result.stdout)
            self.assertEqual(report["local"]["collaborations"], 1)
            self.assertEqual(report["local"]["success_rate_pct"], 100.0)
            self.assertEqual(report["local"]["timing"]["total_seconds"], 120.0)
            self.assertEqual(report["local"]["items"][0]["remote_job_ids"], ["20260914000000-aaaaaa"])

    def test_model_payload_and_failure_classification(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            history = base / "history" / "jobs.jsonl"
            self.make_job(
                base,
                "20260914030000-dddddd",
                agent="claude",
                exit_code=124,
                created_at="2026-09-14T03:00:00Z",
                enqueued_at="2026-09-14T03:00:01Z",
                started_at="2026-09-14T03:00:02Z",
                finished_at="2026-09-14T03:10:02Z",
                model="sonnet",
                task_type="research",
                complexity="standard",
                timeout_seconds=600,
                transcript="request exceeded deadline",
            )
            job = base / "jobs" / "20260914030000-dddddd"
            (job / "timed_out").write_text("timeout\n", encoding="utf-8")
            (job / "prompt.txt").write_text("12345", encoding="utf-8")
            (job / "final.txt").write_text("abc", encoding="utf-8")
            (job / "attempt_count").write_text("1\n", encoding="utf-8")

            report = self.run_stats(base, history)
            record = report["jobs"][0]
            self.assertEqual(record["failure_class"], "hard_timeout")
            self.assertEqual(record["model"], "sonnet")
            self.assertEqual(record["task_type"], "research")
            self.assertEqual(record["attempt_count"], 1)
            self.assertEqual(report["by_model"]["sonnet"]["failed"], 1)
            self.assertEqual(report["by_task_type"]["research"]["failed"], 1)
            self.assertEqual(report["payload"]["prompt"]["total_bytes"], 5)

    def test_tmux_permission_error_reports_unknown_instead_of_failed(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            history = base / "history" / "jobs.jsonl"
            self.make_job(
                base,
                "20260914040000-eeeeee",
                agent="codex",
                exit_code=None,
                created_at="2026-09-14T04:00:00Z",
                enqueued_at="2026-09-14T04:00:01Z",
                started_at="2026-09-14T04:00:02Z",
            )
            fake_bin = base / "bin"
            fake_bin.mkdir()
            fake_tmux = fake_bin / "tmux"
            fake_tmux.write_text("#!/bin/sh\necho 'Operation not permitted' >&2\nexit 1\n", encoding="utf-8")
            fake_tmux.chmod(0o700)
            env = os.environ.copy()
            env["PATH"] = f"{fake_bin}:{env['PATH']}"
            result = subprocess.run(
                [
                    str(STATS),
                    "report",
                    "--base",
                    str(base),
                    "--history",
                    str(history),
                    "--date",
                    "2026-09-14",
                    "--timezone",
                    "Asia/Taipei",
                    "--include-jobs",
                    "--format",
                    "json",
                ],
                check=True,
                capture_output=True,
                text=True,
                env=env,
            )
            report = json.loads(result.stdout)
            self.assertEqual(report["totals"]["unknown"], 1)
            self.assertEqual(report["totals"]["failed"], 0)
            self.assertEqual(report["jobs"][0]["state"], "unknown")

    def test_fallback_usage_collection_delay_and_provider_cost(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            history = base / "history" / "jobs.jsonl"
            self.make_job(
                base,
                "20260914050000-ffffff",
                agent="claude",
                exit_code=0,
                created_at="2026-09-14T05:00:00Z",
                enqueued_at="2026-09-14T05:00:01Z",
                started_at="2026-09-14T05:00:02Z",
                finished_at="2026-09-14T05:01:02Z",
                model="sonnet",
                task_type="research",
            )
            job = base / "jobs" / "20260914050000-ffffff"
            (job / "attempt_count").write_text("2\n", encoding="utf-8")
            (job / "fallback_used").write_text("1\n", encoding="utf-8")
            (job / "effective_agent").write_text("codex\n", encoding="utf-8")
            (job / "effective_model").write_text("default\n", encoding="utf-8")
            (job / "result_collected_at").write_text("2026-09-14T05:01:32Z\n", encoding="utf-8")
            attempts = [
                {"attempt": 1, "agent": "claude", "model": "sonnet", "exit_code": 1, "provider_metrics": {"total_cost_usd": 0.02, "input_tokens": 3, "api_retries": 1, "rate_limit_retries": 1}},
                {"attempt": 2, "agent": "codex", "model": "default", "exit_code": 0, "provider_metrics": {}},
            ]
            (job / "attempts.jsonl").write_text(
                "".join(json.dumps(attempt) + "\n" for attempt in attempts), encoding="utf-8"
            )

            report = self.run_stats(base, history)
            self.assertEqual(report["totals"]["attempts"], 2)
            self.assertEqual(report["totals"]["fallback_attempted"], 1)
            self.assertEqual(report["totals"]["fallback_recovered"], 1)
            self.assertEqual(report["totals"]["results_uncollected"], 0)
            self.assertEqual(report["by_effective_agent"]["codex"]["success"], 1)
            self.assertEqual(report["provider_usage"]["total_cost_usd"], 0.02)
            self.assertEqual(report["provider_usage"]["rate_limit_retries"], 1)
            self.assertEqual(report["jobs"][0]["result_collection_delay_seconds"], 30.0)

    def test_quality_coverage_ignores_invalid_evaluation_on_failed_job(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            history = base / "history" / "jobs.jsonl"
            for suffix, exit_code in (("111111", 0), ("222222", 1)):
                self.make_job(
                    base,
                    f"20260914060000-{suffix}",
                    agent="codex",
                    exit_code=exit_code,
                    created_at="2026-09-14T06:00:00Z",
                    enqueued_at="2026-09-14T06:00:01Z",
                    started_at="2026-09-14T06:00:02Z",
                    finished_at="2026-09-14T06:00:03Z",
                )
                job = base / "jobs" / f"20260914060000-{suffix}"
                (job / "evaluation.json").write_text(
                    json.dumps({"verdict": "accepted", "summary": "历史异常数据", "evaluated_at": "2026-09-14T06:00:04Z", "caller": "codex"}),
                    encoding="utf-8",
                )
            report = self.run_stats(base, history)
            self.assertEqual(report["totals"]["evaluated"], 1)
            self.assertEqual(report["totals"]["quality_coverage_pct"], 100.0)
            self.assertEqual(report["totals"]["terminal_evaluated"], 1)
            self.assertEqual(report["totals"]["terminal_quality_coverage_pct"], 50.0)

            failed_job = base / "jobs" / "20260914060000-222222"
            (failed_job / "evaluation.json").write_text(
                json.dumps(
                    {
                        "verdict": "rejected",
                        "summary": "进程失败，无有效交付",
                        "evaluated_at": "2026-09-14T06:00:05Z",
                        "caller": "codex",
                    }
                ),
                encoding="utf-8",
            )
            evaluated_terminal_report = self.run_stats(base, history)
            self.assertEqual(evaluated_terminal_report["totals"]["evaluated"], 1)
            self.assertEqual(evaluated_terminal_report["totals"]["terminal_evaluated"], 2)
            self.assertEqual(evaluated_terminal_report["totals"]["terminal_rejected"], 1)
            self.assertEqual(
                evaluated_terminal_report["totals"]["terminal_quality_coverage_pct"], 100.0
            )


if __name__ == "__main__":
    unittest.main()
