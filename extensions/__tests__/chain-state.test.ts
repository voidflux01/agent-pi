import { describe, expect, it } from "vitest";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readChainSnapshot, writeChainSnapshot } from "../lib/chain-state.ts";

function tempDir() { return mkdtempSync(join(tmpdir(), "pi-chain-state-")); }

const step = { agent: "researcher", status: "running" as const, elapsed: 12, lastWork: "reading", toolCount: 2 };

describe("chain state", () => {
	it("round-trips bounded durable progress", () => {
		const dir = tempDir();
		writeChainSnapshot(dir, {
			chain: "plan-build", originalTask: "task", currentStepIndex: 1,
			stepOutputs: ["first output"], steps: [step, { ...step, status: "pending", lastWork: "" }],
		});
		expect(readChainSnapshot(dir)).toMatchObject({ chain: "plan-build", currentStepIndex: 1, stepOutputs: ["first output"] });
	});

	it("rejects malformed or symlinked snapshots", () => {
		const dir = tempDir();
		writeFileSync(join(dir, "chain-state.json"), JSON.stringify({ version: 1, chain: "x" }));
		expect(readChainSnapshot(dir)).toBeUndefined();
		const target = join(dir, "target");
		writeFileSync(target, "{}");
		const linkDir = tempDir();
		symlinkSync(target, join(linkDir, "chain-state.json"));
		expect(readChainSnapshot(linkDir)).toBeUndefined();
	});
});
