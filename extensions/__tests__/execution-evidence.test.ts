import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { listEvidence, listRunEvents, recordEvidence, recordRunEvent, MAX_EVIDENCE_VALUE_CHARS, MAX_EVENT_PAYLOAD_BYTES } from "../lib/evidence-store.ts";

describe("execution evidence", () => {
  it("keeps worker claims separate from runtime evidence", () => {
    const dir = mkdtempSync(join("/tmp", "pi-evidence-"));
    recordEvidence(dir, { id: "claim-1", type: "test", source: "worker_claim", value: "claimed pass", timestamp: new Date().toISOString() });
    recordEvidence(dir, { id: "runtime-1", type: "test", source: "runtime", value: "actual pass", timestamp: new Date().toISOString() });
    expect(listEvidence(dir).map(e => e.source)).toEqual(["worker_claim", "runtime"]);
  });

  it("bounds oversized evidence values while retaining a truncation marker", () => {
    const dir = mkdtempSync(join("/tmp", "pi-evidence-"));
    const value = "x".repeat(MAX_EVIDENCE_VALUE_CHARS + 100);
    recordEvidence(dir, { id: "large", type: "command", source: "runtime", value, timestamp: new Date().toISOString() });
    const stored = listEvidence(dir)[0];
    expect(stored.value.length).toBeLessThan(value.length);
    expect(stored.value.endsWith("[… evidence value truncated …]")).toBe(true);
  });

  it("bounds oversized event payloads and tolerates circular payloads", () => {
    const dir = mkdtempSync(join("/tmp", "pi-evidence-"));
    recordRunEvent(dir, { id: "large", type: "tool", actor: "worker", timestamp: new Date().toISOString(), payload: "x".repeat(MAX_EVENT_PAYLOAD_BYTES + 100) });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    recordRunEvent(dir, { id: "circular", type: "tool", actor: "worker", timestamp: new Date().toISOString(), payload: circular });
    expect(listRunEvents(dir).map(event => event.payload)).toEqual([
      expect.objectContaining({ truncated: true }),
      expect.objectContaining({ truncated: true, serializationError: true }),
    ]);
  });
});
