import assert from "node:assert/strict";
import test from "node:test";

import {
  SNAPSHOT_PREPARATION_TIMEOUT_MS,
  remoteStartTimeoutMs,
} from "../operation-timeouts.mjs";

test("local snapshots use one preparation budget for transfer and remote baseline creation", () => {
  assert.equal(SNAPSHOT_PREPARATION_TIMEOUT_MS, 300_000);
  assert.equal(remoteStartTimeoutMs("local_snapshot"), SNAPSHOT_PREPARATION_TIMEOUT_MS);
});

test("remote workspaces keep the ordinary remote helper timeout", () => {
  assert.equal(remoteStartTimeoutMs("remote_workspace"), 30_000);
});
