import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { listEvidence, recordEvidence } from "../lib/evidence-store.ts";

describe("execution evidence", () => {
  it("keeps worker claims separate from runtime evidence", () => {
    const dir = mkdtempSync(join("/tmp", "pi-evidence-"));
    recordEvidence(dir, { id: "claim-1", type: "test", source: "worker_claim", value: "claimed pass", timestamp: new Date().toISOString() });
    recordEvidence(dir, { id: "runtime-1", type: "test", source: "runtime", value: "actual pass", timestamp: new Date().toISOString() });
    expect(listEvidence(dir).map(e => e.source)).toEqual(["worker_claim", "runtime"]);
  });
});
