import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCollaborationClosable,
  boundedMcpWaitSeconds,
  parseKeyValueOutput,
} from "../collaboration-policy.mjs";

test("parseKeyValueOutput ignores non key-value lines", () => {
  assert.deepEqual(parseKeyValueOutput("total=2\n--- jobs ---\nactive=0\nuncollected=0\n"), {
    total: "2",
    active: "0",
    uncollected: "0",
  });
});

test("MCP waits are bounded below the common 60 second client timeout", () => {
  assert.equal(boundedMcpWaitSeconds(0), 0);
  assert.equal(boundedMcpWaitSeconds(15), 15);
  assert.equal(boundedMcpWaitSeconds(300), 40);
});

test("collaboration cannot finish with active, missing or uncollected jobs", () => {
  assert.throws(
    () => assertCollaborationClosable({ total: "2", active: "1", uncollected: "0" }, 2),
    /仍有远端任务未结束/,
  );
  assert.throws(
    () => assertCollaborationClosable({ total: "1", active: "0", uncollected: "0" }, 2),
    /远端任务记录不完整/,
  );
  assert.throws(
    () => assertCollaborationClosable({ total: "2", active: "0", uncollected: "1" }, 2),
    /未回收/,
  );
  assert.doesNotThrow(() =>
    assertCollaborationClosable({ total: "2", active: "0", uncollected: "0" }, 2),
  );
});
