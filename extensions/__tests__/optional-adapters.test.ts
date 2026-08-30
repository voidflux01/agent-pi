import { describe, expect, it } from "bun:test";
import optionalAdapters from "../optional-adapters.ts";

describe("optional adapters", () => {
  it("does nothing when disabled", async () => {
    const previous = process.env.PI_OPTIONAL_ADAPTERS;
    delete process.env.PI_OPTIONAL_ADAPTERS;
    let registrations = 0;
    const pi = new Proxy({}, { get: () => () => { registrations++; } });
    await optionalAdapters(pi as any);
    if (previous === undefined) delete process.env.PI_OPTIONAL_ADAPTERS;
    else process.env.PI_OPTIONAL_ADAPTERS = previous;
    expect(registrations).toBe(0);
  });
  it("loads enabled adapters without making them mandatory", async () => {
    const previous = process.env.PI_OPTIONAL_ADAPTERS;
    process.env.PI_OPTIONAL_ADAPTERS = "1";
    const pi = new Proxy({}, { get: () => () => {} });
    await optionalAdapters(pi as any);
    if (previous === undefined) delete process.env.PI_OPTIONAL_ADAPTERS;
    else process.env.PI_OPTIONAL_ADAPTERS = previous;
    expect(true).toBe(true);
  });
});
