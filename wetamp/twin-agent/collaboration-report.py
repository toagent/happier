#!/usr/bin/env python3
"""Merge local collaboration events with remote twin-agent job metrics."""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from statistics import mean
from zoneinfo import ZoneInfo


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def load_events(path: Path) -> list[dict]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    events = []
    for line in lines:
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict) and event.get("collaboration_id"):
            events.append(event)
    return events


def filter_events(events: list[dict], args: argparse.Namespace) -> list[dict]:
    zone = ZoneInfo(args.timezone)
    candidates = []
    for event in events:
        if args.collaboration_id and event.get("collaboration_id") != args.collaboration_id:
            continue
        if args.caller and event.get("caller") != args.caller:
            continue
        candidates.append(event)

    if args.date == "all":
        return sorted(candidates, key=lambda item: item.get("timestamp") or "")

    grouped: dict[str, list[dict]] = defaultdict(list)
    for event in candidates:
        grouped[event["collaboration_id"]].append(event)
    selected_ids = set()
    for collaboration_id, items in grouped.items():
        timestamps = [parse_time(item.get("timestamp")) for item in items]
        timestamps = [timestamp for timestamp in timestamps if timestamp]
        if timestamps and min(timestamps).astimezone(zone).date().isoformat() == args.date:
            selected_ids.add(collaboration_id)
    return sorted(
        [event for event in candidates if event["collaboration_id"] in selected_ids],
        key=lambda item: item.get("timestamp") or "",
    )


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(fraction * len(ordered)) - 1)]


def timing_summary(values: list[float]) -> dict:
    return {
        "count": len(values),
        "total_seconds": round(sum(values), 3) if values else 0,
        "average_seconds": round(mean(values), 3) if values else None,
        "p50_seconds": round(percentile(values, 0.50), 3) if values else None,
        "p95_seconds": round(percentile(values, 0.95), 3) if values else None,
        "max_seconds": round(max(values), 3) if values else None,
    }


def local_summary(events: list[dict]) -> dict:
    grouped: dict[str, list[dict]] = defaultdict(list)
    for event in events:
        grouped[event["collaboration_id"]].append(event)

    collaborations = []
    durations = []
    outcomes = Counter()
    for collaboration_id, items in grouped.items():
        items.sort(key=lambda item: item.get("timestamp") or "")
        starts = [item for item in items if item.get("action") == "start"]
        finishes = [item for item in items if item.get("action") == "finish"]
        start_time = parse_time((starts[0] if starts else items[0]).get("timestamp"))
        finish_time = parse_time(finishes[-1].get("timestamp")) if finishes else None
        elapsed = max(0.0, (finish_time - start_time).total_seconds()) if start_time and finish_time else None
        if elapsed is not None:
            durations.append(elapsed)
        outcome = finishes[-1].get("outcome", "success") if finishes else "ongoing"
        outcomes[outcome] += 1
        job_ids = []
        summaries = []
        for item in items:
            job_id = item.get("job_id")
            if job_id and job_id not in job_ids:
                job_ids.append(job_id)
            summary = item.get("summary") or item.get("local_work")
            if summary and summary not in summaries:
                summaries.append(summary)
        collaborations.append(
            {
                "collaboration_id": collaboration_id,
                "caller": items[0].get("caller", "unknown"),
                "task_title": items[0].get("task_title", "未命名协同任务"),
                "outcome": outcome,
                "elapsed_seconds": round(elapsed, 3) if elapsed is not None else None,
                "remote_job_ids": job_ids,
                "events": len(items),
                "work": summaries,
            }
        )
    terminal = outcomes["success"] + outcomes["partial"] + outcomes["failed"] + outcomes["cancelled"]
    success_rate = 100 * outcomes["success"] / terminal if terminal else None
    return {
        "collaborations": len(grouped),
        "events": len(events),
        "outcomes": dict(sorted(outcomes.items())),
        "success_rate_pct": round(success_rate, 2) if success_rate is not None else None,
        "timing": timing_summary(durations),
        "items": sorted(collaborations, key=lambda item: item["collaboration_id"]),
    }


def fetch_remote(args: argparse.Namespace) -> dict:
    if args.remote_json:
        return json.loads(Path(args.remote_json).read_text(encoding="utf-8"))
    helper = os.environ.get(
        "TWIN_AGENT_REMOTE_HELPER", "/Users/yong/.lan-dev-machine/bin/twin-agent-remote"
    )
    host = os.environ.get("TWIN_AGENT_SSH_HOST", "twin-dev")
    command = [
        "ssh",
        "-o",
        "BatchMode=yes",
        host,
        helper,
        "stats",
        args.date,
        args.timezone,
        args.collaboration_id or "-",
        args.caller or "-",
        "1" if args.include_jobs else "0",
        "json",
    ]
    result = subprocess.run(command, check=False, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "remote stats failed")
    return json.loads(result.stdout)


def format_seconds(value: float | None) -> str:
    if value is None:
        return "-"
    seconds = int(round(value))
    hours, seconds = divmod(seconds, 3600)
    minutes, seconds = divmod(seconds, 60)
    if hours:
        return f"{hours}小时{minutes:02d}分{seconds:02d}秒"
    if minutes:
        return f"{minutes}分{seconds:02d}秒"
    return f"{seconds}秒"


def pct(value: float | None) -> str:
    return "-" if value is None else f"{value:.2f}%"


def render(report: dict) -> str:
    local = report["local"]
    remote = report["remote"]
    totals = remote["totals"]
    run = remote["timing"]["run"]
    queue = remote["timing"]["queue_wait"]
    concurrency = remote.get("concurrency", {})
    usage = remote.get("provider_usage", {})
    collection = remote.get("timing", {}).get("result_collection", {})
    lines = [
        f"协同开发统计：{report['date']}（{report['timezone']}）",
        "",
        "本机控制面",
        f"- 协同任务：{local['collaborations']} 个；记录事件：{local['events']} 条",
        f"- 已闭环成功率：{pct(local['success_rate_pct'])}",
        (
            f"- 本机协同墙钟耗时：合计 {format_seconds(local['timing']['total_seconds'])}，"
            f"平均 {format_seconds(local['timing']['average_seconds'])}，"
            f"P50 {format_seconds(local['timing']['p50_seconds'])}，"
            f"P95 {format_seconds(local['timing']['p95_seconds'])}"
        ),
        "",
        "开发机执行面",
        (
            f"- 远端任务：{totals['submitted']} 个；成功 {totals['success']}；失败 {totals['failed']}；"
            f"取消 {totals['cancelled']}；运行中 {totals['running']}；排队 {totals['queued']}；"
            f"状态未知 {totals.get('unknown', 0)}"
        ),
        (
            f"- 进程成功率：{pct(totals['execution_success_rate_pct'])}；"
            f"进程交付率（含取消）：{pct(totals['delivery_rate_pct'])}"
        ),
        (
            f"- 成功结果验收：已评审 {totals.get('evaluated', 0)}/{totals.get('success', 0)}；"
            f"覆盖率 {pct(totals.get('quality_coverage_pct'))}；有效成功率 "
            f"{pct(totals.get('effective_success_rate_pct'))}；有效交付率 "
            f"{pct(totals.get('effective_delivery_rate_pct'))}"
        ),
        (
            f"- 全部终态核对：已评审 {totals.get('terminal_evaluated', 0)}/"
            f"{totals.get('success', 0) + totals.get('failed', 0) + totals.get('cancelled', 0)}；"
            f"覆盖率 {pct(totals.get('terminal_quality_coverage_pct'))}；partial "
            f"{totals.get('terminal_partial', 0)}；rejected {totals.get('terminal_rejected', 0)}"
        ),
        (
            f"- 自动降级：触发 {totals.get('fallback_attempted', 0)} 次；恢复 "
            f"{totals.get('fallback_recovered', 0)} 次；恢复率 "
            f"{pct(totals.get('fallback_recovery_rate_pct'))}"
        ),
        (
            f"- 结果回收：已回收 {totals.get('results_collected', 0)}；未回收 "
            f"{totals.get('results_uncollected', 0)}；覆盖率 "
            f"{pct(totals.get('result_collection_coverage_pct'))}；P95 延迟 "
            f"{format_seconds(collection.get('p95_seconds'))}"
        ),
        (
            f"- 运行耗时：合计 {format_seconds(run['total_seconds'])}，平均 {format_seconds(run['average_seconds'])}，"
            f"P50 {format_seconds(run['p50_seconds'])}，P95 {format_seconds(run['p95_seconds'])}，"
            f"最长 {format_seconds(run['max_seconds'])}"
        ),
        (
            f"- 精确排队耗时样本：{queue['count']} 个；合计 {format_seconds(queue['total_seconds'])}；"
            f"P95 {format_seconds(queue['p95_seconds'])}"
        ),
        (
            f"- 并行效率：忙碌墙钟 {format_seconds(concurrency.get('busy_wall_seconds'))}；"
            f"并行系数 {concurrency.get('parallelism_factor') or '-'}；"
            f"相对串行节省 {format_seconds(concurrency.get('parallel_time_saved_seconds'))}；"
            f"峰值并发 {concurrency.get('peak_concurrency', 0)}"
        ),
        (
            f"- Provider 消耗：成本 ${usage.get('total_cost_usd', 0):.6f}；输入 "
            f"{usage.get('input_tokens', 0)} token；缓存创建 {usage.get('cache_creation_input_tokens', 0)}；"
            f"输出 {usage.get('output_tokens', 0)}；API 重试 {usage.get('api_retries', 0)}，"
            f"其中 429 为 {usage.get('rate_limit_retries', 0)}"
        ),
        "",
        "按远端 Agent",
    ]
    for agent, counts in remote["by_remote_agent"].items():
        agent_run = counts.get("run", {})
        lines.append(
            f"- {agent}: {counts.get('jobs', 0)} 个，成功 {counts.get('success', 0)}，"
            f"失败 {counts.get('failed', 0)}，取消 {counts.get('cancelled', 0)}，"
            f"运行合计 {format_seconds(agent_run.get('total_seconds'))}，"
            f"平均 {format_seconds(agent_run.get('average_seconds'))}"
        )

    lines.extend(["", "按模型与失败原因"])
    for model, counts in remote.get("by_model", {}).items():
        model_run = counts.get("run", {})
        lines.append(
            f"- {model}: {counts.get('jobs', 0)} 个，成功 {counts.get('success', 0)}，"
            f"失败 {counts.get('failed', 0)}，取消 {counts.get('cancelled', 0)}，"
            f"平均 {format_seconds(model_run.get('average_seconds'))}"
        )
    failures = remote.get("by_failure_class", {})
    cancellations = remote.get("by_cancel_reason", {})
    lines.append(f"- 失败分类：{json.dumps(failures, ensure_ascii=False, sort_keys=True) if failures else '无'}")
    lines.append(f"- 取消原因：{json.dumps(cancellations, ensure_ascii=False, sort_keys=True) if cancellations else '无'}")

    lines.extend(["", "本机工作记录"])
    if not local["items"]:
        lines.append("- 无结构化历史记录；无法可靠还原本机做了什么或本机耗时。")
    for item in local["items"]:
        work = "；".join(item["work"]) or "未记录"
        lines.append(
            f"- {item['collaboration_id']} [{item['caller']}/{item['outcome']}] "
            f"{item['task_title']}；远端 {len(item['remote_job_ids'])} 个；"
            f"耗时 {format_seconds(item['elapsed_seconds'])}；本机：{work}"
        )

    lines.extend(["", "远端任务明细"])
    jobs = remote.get("jobs", [])
    if not jobs:
        lines.append("- 未请求明细；使用 `--include-jobs` 查看。")
    for job in jobs:
        lines.append(
            f"- {job['job_id']} [{job['remote_agent']}->{job.get('effective_agent', job['remote_agent'])}/{job['outcome']}] "
            f"运行 {format_seconds(job.get('run_seconds'))}，排队 {format_seconds(job.get('queue_wait_seconds'))}，"
            f"总耗时 {format_seconds(job.get('total_seconds'))}，模型 {job.get('model') or '历史未记录'}，"
            f"尝试 {job.get('attempt_count') or 0} 次，回收延迟 "
            f"{format_seconds(job.get('result_collection_delay_seconds'))}，失败分类 "
            f"{job.get('failure_class') or '-'}，验收 {job.get('quality_verdict') or '未评审'}；"
            f"{job['task_title']}；本机：{job['local_work']}"
        )
    return "\n".join(lines)


def merge_local_job_context(remote: dict, events: list[dict]) -> None:
    by_job: dict[str, list[dict]] = defaultdict(list)
    for event in events:
        if event.get("job_id"):
            by_job[event["job_id"]].append(event)
    for job in remote.get("jobs", []):
        items = by_job.get(job.get("job_id"), [])
        if not items:
            continue
        local_work = next(
            (
                item.get("local_work") or item.get("summary")
                for item in reversed(items)
                if item.get("local_work") or item.get("summary")
            ),
            None,
        )
        if local_work and job.get("local_work") in {None, "", "历史未记录"}:
            job["local_work"] = local_work
        if job.get("caller") in {None, "", "历史未记录"}:
            job["caller"] = items[0].get("caller") or job.get("caller")
        if str(job.get("collaboration_id", "")).startswith("legacy-"):
            job["collaboration_id"] = items[0].get("collaboration_id") or job["collaboration_id"]
        if job.get("task_title") in {None, "", "历史任务", "workspace"}:
            job["task_title"] = items[0].get("task_title") or job.get("task_title")


def main() -> int:
    parser = argparse.ArgumentParser(description="查看本机与孪生开发机协同效率和成功率")
    parser.add_argument("date", nargs="?", default=None, help="YYYY-MM-DD，默认今天；可用 all")
    parser.add_argument("--timezone", default="Asia/Taipei")
    parser.add_argument("--collaboration-id")
    parser.add_argument("--caller", choices=["codex", "claude", "opencode"])
    parser.add_argument("--include-jobs", action="store_true")
    parser.add_argument("--format", choices=["text", "json"], default="text")
    parser.add_argument("--events", default=os.path.expanduser("~/.lan-dev-machine/twin-agent/activity/events.jsonl"))
    parser.add_argument("--remote-json", help=argparse.SUPPRESS)
    args = parser.parse_args()

    try:
        zone = ZoneInfo(args.timezone)
    except Exception as error:
        print(f"无效时区: {error}", file=sys.stderr)
        return 2
    args.date = args.date or datetime.now(zone).date().isoformat()
    if args.date != "all":
        try:
            datetime.strptime(args.date, "%Y-%m-%d")
        except ValueError:
            print("日期必须是 YYYY-MM-DD 或 all", file=sys.stderr)
            return 2

    try:
        remote = fetch_remote(args)
    except (OSError, RuntimeError, json.JSONDecodeError, subprocess.TimeoutExpired) as error:
        print(f"读取开发机统计失败: {error}", file=sys.stderr)
        return 1
    events = filter_events(load_events(Path(args.events).expanduser()), args)
    merge_local_job_context(remote, events)
    report = {
        "schema_version": 2,
        "date": args.date,
        "timezone": args.timezone,
        "local": local_summary(events),
        "remote": remote,
    }
    if args.format == "json":
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print(render(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
