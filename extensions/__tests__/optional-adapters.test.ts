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
  it("stays a no-op even when the optional flag is set", async () => {
    const previous = process.env.PI_OPTIONAL_ADAPTERS;
    process.env.PI_OPTIONAL_ADAPTERS = "1";
    let registrations = 0;
    const pi = new Proxy({}, { get: () => () => { registrations++; } });
    await optionalAdapters(pi as any);
    if (previous === undefined) delete process.env.PI_OPTIONAL_ADAPTERS;
    else process.env.PI_OPTIONAL_ADAPTERS = previous;
    expect(registrations).toBe(0);
  });
});
