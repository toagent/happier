#!/usr/bin/env python3
"""Extract a compact final answer and provider metrics from AI CLI streams."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.replace(path)


def text_blocks(message: object) -> list[str]:
    if not isinstance(message, dict):
        return []
    content = message.get("content")
    if not isinstance(content, list):
        return []
    return [
        str(block.get("text"))
        for block in content
        if isinstance(block, dict) and block.get("type") == "text" and block.get("text")
    ]


def parse_claude(stream: Path) -> tuple[str, dict, list[str]]:
    final = ""
    last_assistant = ""
    result_record: dict = {}
    api_retries = 0
    rate_limit_retries = 0
    compact: list[str] = []

    try:
        lines = stream.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        lines = []

    for raw in lines:
        try:
            event = json.loads(raw)
        except json.JSONDecodeError:
            if raw.strip():
                compact.append(f"raw: {raw.strip()[:1000]}")
            continue
        if not isinstance(event, dict):
            continue

        event_type = event.get("type")
        subtype = event.get("subtype")
        if event_type == "system" and subtype == "init":
            compact.append(
                "init: "
                f"model={event.get('model', '-')} tools={len(event.get('tools') or [])} "
                f"plugins={len(event.get('plugins') or [])} mcp={len(event.get('mcp_servers') or [])}"
            )
        elif event_type == "system" and subtype == "api_retry":
            api_retries += 1
            if event.get("error") == "rate_limit" or event.get("error_status") == 429:
                rate_limit_retries += 1
            compact.append(
                "api_retry: "
                f"attempt={event.get('attempt', '-')} status={event.get('error_status', '-')} "
                f"error={event.get('error', '-')} delay_ms={event.get('retry_delay_ms', '-')}"
            )
        elif event_type == "system" and subtype == "status":
            compact.append(f"status: {event.get('status', '-')}")
        elif event_type == "assistant":
            blocks = text_blocks(event.get("message"))
            if blocks:
                last_assistant = "\n".join(blocks).strip()
        elif event_type == "stream_event":
            inner = event.get("event")
            if isinstance(inner, dict) and inner.get("type") == "content_block_start":
                block = inner.get("content_block")
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    compact.append(f"tool: {block.get('name', '-')}")
        elif event_type == "result":
            result_record = event
            if event.get("result"):
                final = str(event["result"]).strip()

    if not final:
        final = last_assistant
    if final:
        compact.append(f"final: {final}")

    usage = result_record.get("usage") if isinstance(result_record.get("usage"), dict) else {}
    metrics = {
        "provider": "claude",
        "model": result_record.get("modelUsage") or {},
        "duration_ms": result_record.get("duration_ms"),
        "duration_api_ms": result_record.get("duration_api_ms"),
        "ttft_ms": result_record.get("ttft_ms"),
        "ttft_stream_ms": result_record.get("ttft_stream_ms"),
        "total_cost_usd": result_record.get("total_cost_usd"),
        "input_tokens": usage.get("input_tokens"),
        "cache_creation_input_tokens": usage.get("cache_creation_input_tokens"),
        "cache_read_input_tokens": usage.get("cache_read_input_tokens"),
        "output_tokens": usage.get("output_tokens"),
        "api_retries": api_retries,
        "rate_limit_retries": rate_limit_retries,
        "permission_denials": len(result_record.get("permission_denials") or []),
        "terminal_reason": result_record.get("terminal_reason"),
        "subtype": result_record.get("subtype"),
        "is_error": result_record.get("is_error"),
    }
    return final, metrics, compact


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("provider", choices=["claude"])
    parser.add_argument("stream")
    parser.add_argument("final")
    parser.add_argument("metrics")
    parser.add_argument("compact")
    args = parser.parse_args()

    final, metrics, compact = parse_claude(Path(args.stream))
    atomic_write(Path(args.final), final + ("\n" if final else ""))
    atomic_write(Path(args.metrics), json.dumps(metrics, ensure_ascii=False, separators=(",", ":")) + "\n")
    atomic_write(Path(args.compact), "\n".join(compact) + ("\n" if compact else ""))

    if metrics.get("is_error") is True or metrics.get("subtype") not in {None, "success"}:
        return 2
    return 0 if final else 3


if __name__ == "__main__":
    raise SystemExit(main())
