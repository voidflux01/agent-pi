import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { appendMemory, readMemories } from "../workspace-memory.ts";

describe("workspace memory", () => {
  it("stores bounded records and searches by persisted fields", () => {
    const cwd = mkdtempSync(join("/tmp", "pi-memory-"));
    const record = appendMemory(cwd, "Use atomic writes", ["architecture"]);
    expect(readMemories(cwd)).toHaveLength(1);
    expect(record.tags).toEqual(["architecture"]);
    expect(readMemories(cwd)[0].text).toBe("Use atomic writes");
  });
  it("retains a bounded history", () => {
    const cwd = mkdtempSync(join("/tmp", "pi-memory-"));
    for (let i = 0; i < 510; i++) appendMemory(cwd, `record-${i}`);
    const records = readMemories(cwd);
    expect(records).toHaveLength(500);
    expect(records[0].text).toBe("record-10");
  });
});
