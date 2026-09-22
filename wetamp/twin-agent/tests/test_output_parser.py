#!/usr/bin/env python3

import json
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PARSER = ROOT / "twin-agent-output.py"


class OutputParserTest(unittest.TestCase):
    def test_claude_stream_extracts_final_and_metrics_without_thinking_noise(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            stream = temp / "stream.jsonl"
            final = temp / "final.txt"
            metrics = temp / "metrics.json"
            compact = temp / "compact.log"
            events = [
                {"type": "system", "subtype": "init", "model": "sonnet", "tools": [], "plugins": [], "mcp_servers": []},
                {"type": "system", "subtype": "api_retry", "attempt": 1, "error_status": 429, "error": "rate_limit", "retry_delay_ms": 100},
                {"type": "assistant", "message": {"content": [{"type": "thinking", "thinking": "private"}, {"type": "text", "text": "最终结论"}]}},
                {"type": "result", "subtype": "success", "result": "最终结论", "total_cost_usd": 0.01, "ttft_ms": 123, "usage": {"input_tokens": 10, "cache_creation_input_tokens": 20, "output_tokens": 5}, "permission_denials": []},
            ]
            stream.write_text("".join(json.dumps(event) + "\n" for event in events), encoding="utf-8")
            result = subprocess.run(
                [str(PARSER), "claude", str(stream), str(final), str(metrics), str(compact)],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0)
            self.assertEqual(final.read_text(encoding="utf-8").strip(), "最终结论")
            values = json.loads(metrics.read_text(encoding="utf-8"))
            self.assertEqual(values["ttft_ms"], 123)
            self.assertEqual(values["rate_limit_retries"], 1)
            self.assertEqual(values["cache_creation_input_tokens"], 20)
            self.assertNotIn("private", compact.read_text(encoding="utf-8"))

    def test_claude_error_result_is_not_success(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            stream = temp / "stream.jsonl"
            stream.write_text(json.dumps({"type": "result", "subtype": "error", "is_error": True}) + "\n", encoding="utf-8")
            result = subprocess.run(
                [str(PARSER), "claude", str(stream), str(temp / "final"), str(temp / "metrics"), str(temp / "compact")],
                check=False,
            )
            self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()
