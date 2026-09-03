import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { runAssertion, runDeterministicVerification, verificationEnvironment } from "../lib/deterministic-verifier.ts";
import { parseAssertion } from "../lib/execution-contract.ts";

let cwd = "";
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "dv-")); });
afterEach(() => { try { rmSync(cwd, { recursive: true, force: true }); } catch {} });

const root: () => string = () => cwd;

describe("[cmd] assertions", () => {
	it("adds common user toolchain directories to a minimal PATH", () => {
		const env = verificationEnvironment({ HOME: "/tmp/example-home", PATH: "/usr/bin" });
		expect(env.PATH?.split(delimiter)).toContain("/tmp/example-home/.cargo/bin");
	});

	it("passes when the command exits 0", async () => {
		const result = await runAssertion(parseAssertion(`[cmd] ${process.execPath} -e "process.exit(0)"`) as never, root());
		expect(result.status).toBe("pass");
		expect(result.exitCode).toBe(0);
	});

	it("preserves quoted arguments containing spaces", async () => {
		const result = await runAssertion(parseAssertion(`[cmd] ${process.execPath} -e "process.exit(process.argv[1] === 'hello world' ? 0 : 1)" -- "hello world"`) as never, root());
		expect(result.status).toBe("pass");
	});

	it("fails when the command exits non-zero", async () => {
		const result = await runAssertion(parseAssertion(`[cmd] ${process.execPath} -e "process.exit(1)"`) as never, root());
		expect(result.status).toBe("fail");
		expect(result.exitCode).toBe(1);
	});

	it("blocks when the command does not exist (ENOENT)", async () => {
		const result = await runAssertion(parseAssertion("[cmd] definitely-not-a-command-xyz --flag") as never, root());
		expect(result.status).toBe("blocked");
		expect(result.exitCode).toBe(127);
	});

	it("blocks on timeout and never lets a hung command pass", async () => {
		const result = await runAssertion(parseAssertion(`[cmd] ${process.execPath} -e "setTimeout(()=>{},5000)"`) as never, root(), { commandTimeoutMs: 80 });
		expect(result.status).toBe("blocked");
	});

	it("rejects a PASS claim when the mandatory command fails (LLM cannot override)", async () => {
		const contract = {
			mandatory: [parseAssertion(`[cmd] ${process.execPath} -e "process.exit(1)"`) as never],
		};
		const verification = await runDeterministicVerification(contract as never, root());
		expect(verification.status).toBe("FAIL");
	});
});

describe("runDeterministicVerification", () => {
	it("PASSes when every command assertion passes", async () => {
		const contract = { mandatory: [parseAssertion(`[cmd] ${process.execPath} -e "process.exit(0)"`) as never] };
		expect((await runDeterministicVerification(contract as never, root())).status).toBe("PASS");
	});

	it("FAILs when one assertion fails", async () => {
		const contract = { mandatory: [parseAssertion(`[cmd] ${process.execPath} -e "process.exit(2)"`) as never] };
		expect((await runDeterministicVerification(contract as never, root())).status).toBe("FAIL");
	});

	it("BLOCKs when an assertion is blocked", async () => {
		const contract = { mandatory: [parseAssertion("[cmd] no-such-binary-xyz") as never] };
		expect((await runDeterministicVerification(contract as never, root())).status).toBe("BLOCKED");
	});
});
