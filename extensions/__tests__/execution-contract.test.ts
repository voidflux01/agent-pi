import { describe, expect, it } from "vitest";
import { bindAcceptanceContract, bindSpecContract, parseAssertion, planFingerprint } from "../lib/execution-contract.ts";

const PLAN = `# Plan: add login

## Context
Auth exists.

## Contract
- [cmd] npm test
- [file] extensions/lib/execution-contract.ts
- [match] runIsolatedVerifier :: extensions/lib/isolated-verifier.ts
- Login page renders (advisory)
`;

describe("assertion parsing", () => {
	it("parses [cmd] into command + args without shell", () => {
		const a = parseAssertion("[cmd] npm test -- auth.test.ts");
		expect(a).toMatchObject({ kind: "cmd", command: "npm", args: ["test", "--", "auth.test.ts"] });
	});

	it("parses [file] and [match]", () => {
		expect(parseAssertion("[file] extensions/lib/x.ts")).toMatchObject({ kind: "file", path: "extensions/lib/x.ts" });
		expect(parseAssertion("[match] foo::bar :: extensions/lib/x.ts")).toMatchObject({ kind: "match", pattern: "foo::bar", path: "extensions/lib/x.ts" });
	});

	it("accepts Markdown inline-code fences around match patterns and paths", () => {
		expect(parseAssertion("[match] `export function removeTodo(todos, id)` :: `todos.js`")).toMatchObject({
			kind: "match",
			pattern: "export function removeTodo\\(todos, id\\)",
			path: "todos.js",
		});
		expect(parseAssertion("[file] `src/index.ts`")).toMatchObject({ kind: "file", path: "src/index.ts" });
	});

	it("degrades natural-language items to advisory", () => {
		expect(parseAssertion("Login page renders")).toMatchObject({ kind: "advisory" });
		expect(parseAssertion("advisory: Login page renders")).toMatchObject({ kind: "advisory", text: "Login page renders" });
		expect(parseAssertion("[cmd]")).toMatchObject({ kind: "advisory" });
	});

	it("exposes mandatory separately from advisory", () => {
		const bound = bindAcceptanceContract(PLAN, "plan");
		if ("error" in bound) throw new Error("expected contract");
		expect(bound.mandatory).toHaveLength(3);
		expect(bound.assertions).toHaveLength(4);
		expect(bound.assertions[3]).toMatchObject({ kind: "advisory" });
	});

	it("requires at least one executable assertion to bind", () => {
		expect(bindAcceptanceContract("# Plan: x\n\n## Contract\n- login page renders\n", "plan")).toEqual({ error: "incomplete" });
		expect(bindAcceptanceContract("# Plan: x\n\n## Verification\n1. npm test passes\n", "plan")).toEqual({ error: "incomplete" });
		expect(bindAcceptanceContract("# Plan: x\n\nNo checklist.\n", "plan")).toEqual({ error: "incomplete" });
	});

	it("binds spec contract from Requirements with executable assertions", () => {
		const spec = `# Spec: login\n\n## Requirements\n- [cmd] npm test\n- login page (advisory)\n`;
		const bound = bindSpecContract(spec);
		if ("error" in bound) throw new Error("expected contract");
		expect(bound.source).toBe("spec");
		expect(bound.mandatory).toHaveLength(1);
	});

	it("prefers an executable Contract section over natural-language Requirements", () => {
		const spec = `# Spec: search notes

## Requirements
- Search results are case-insensitive.
- Empty queries return all notes.

## Contract
- [cmd] node --test
- [match] searchNotes :: notes.js
`;
		const bound = bindSpecContract(spec);
		if ("error" in bound) throw new Error("expected contract");
		expect(bound.source).toBe("spec");
		expect(bound.mandatory).toHaveLength(2);
		expect(bound.mandatory[0]).toMatchObject({ kind: "cmd", command: "node", args: ["--test"] });
		expect(bound.mandatory[1]).toMatchObject({ kind: "match", pattern: "searchNotes", path: "notes.js" });
	});

	it("changes fingerprint when the approved text changes", () => {
		const a = bindAcceptanceContract(PLAN, "plan");
		const b = bindAcceptanceContract(PLAN.replace("npm test", "npm run test"), "plan");
		if ("error" in a || "error" in b) throw new Error("expected contracts");
		expect(a.fingerprint).not.toBe(b.fingerprint);
		expect(planFingerprint(PLAN)).toBe(planFingerprint(PLAN));
	});
});
