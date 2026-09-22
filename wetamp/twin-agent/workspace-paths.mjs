import { realpathSync } from "node:fs";

export function canonicalRealPath(candidate) {
  return realpathSync.native(candidate);
}
