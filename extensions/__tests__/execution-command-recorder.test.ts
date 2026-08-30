import { describe, expect, it } from "vitest";
import { redact } from "../execution-command-recorder.ts";

describe("execution command recorder", () => {
  it("redacts common credentials before persistence", () => {
    const value = redact("TOKEN=abc123 Bearer abc.def sk-abcdefghijklmnop");
    expect(value).not.toContain("abc123");
    expect(value).not.toContain("abc.def");
    expect(value).not.toContain("sk-abcdefghijklmnop");
    expect(value).toContain("[REDACTED]");
  });
});
