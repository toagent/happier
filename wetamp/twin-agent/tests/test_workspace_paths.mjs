import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalRealPath } from "../workspace-paths.mjs";

test("canonicalRealPath restores on-disk casing on case-insensitive filesystems", (t) => {
  const temp = mkdtempSync(path.join(tmpdir(), "twin-agent-path-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));

  const canonical = path.join(temp, "CanonicalRepo");
  const caseVariant = path.join(temp, "canonicalrepo");
  mkdirSync(canonical);

  if (!existsSync(caseVariant)) {
    t.skip("filesystem is case-sensitive");
    return;
  }

  const canonicalOnDisk = canonicalRealPath(canonical);
  assert.equal(canonicalRealPath(caseVariant), canonicalOnDisk);
  assert.equal(path.relative(canonicalOnDisk, canonicalRealPath(caseVariant)), "");
});
