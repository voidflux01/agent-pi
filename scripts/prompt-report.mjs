#!/usr/bin/env node
// ABOUTME: Reports rendered prompt sizes and soft budget warnings.
// ABOUTME: It is observational only and never fails the build for size.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const probe = `
import { buildNormalPrompt, PLAN_PROMPT, SPEC_PROMPT } from "./extensions/lib/mode-prompts.ts";
import { buildWorkerInitialPrompt } from "./extensions/lib/agent-result-contract.ts";
const values = {
  NORMAL: buildNormalPrompt({ activeChain: null, activePipeline: null }),
  PLAN: PLAN_PROMPT,
  SPEC: SPEC_PROMPT,
  WORKER_PREFIX: buildWorkerInitialPrompt({ role: "SCOUT", task: "<task>" }),
};
for (const [name, value] of Object.entries(values)) {
  const repeatedBlocks = [...value.split(/\\n\\s*\\n/).reduce((counts, block) => {
    const normalized = block.trim().replace(/\\s+/g, " ");
    if (normalized.length >= 100) counts.set(normalized, (counts.get(normalized) || 0) + 1);
    return counts;
  }, new Map())].filter(([, count]) => count > 1).map(([block, count]) => ({ count, preview: block.slice(0, 100) }));
  console.log(JSON.stringify({ name, chars: value.length, estimatedTokens: Math.ceil(value.length / 4), repeatedBlocks }));
}
`;

const result = spawnSync(process.env.BUN_BIN || "bun", ["-e", probe], {
	 cwd: root,
	 encoding: "utf8",
});
if (result.status !== 0) {
	process.stderr.write(result.stderr || "Unable to render prompt metrics.\n");
	process.exit(result.status ?? 1);
}

const rows = result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const baselines = { NORMAL: 13447, PLAN: 13585, SPEC: 13474, WORKER_PREFIX: 2236 };
const files = [];
for (const name of readdirSync(resolve(root, "agents"))) {
	const path = resolve(root, "agents", name);
	if (name.endsWith(".md") && statSync(path).isFile()) files.push({ name: `agents/${name}`, chars: readFileSync(path, "utf8").length });
}
console.log("Prompt size report (soft budgets; informational only)");
for (const row of rows) {
	const budget = row.name === "NORMAL" ? 1800 : row.name === "WORKER_PREFIX" ? 400 : 2600;
	const warning = row.estimatedTokens > budget ? ` WARNING target=${budget}` : "";
	const baseline = baselines[row.name];
	const delta = baseline == null ? "" : `\tbaseline=${baseline} (${row.chars - baseline >= 0 ? "+" : ""}${row.chars - baseline})`;
	console.log(`${row.name}\t${row.chars} chars\t~${row.estimatedTokens} tokens${delta}${warning}`);
}
console.log("Repeated shared blocks");
for (const row of rows) {
	if (row.repeatedBlocks.length === 0) console.log(`${row.name}\t none`);
	for (const block of row.repeatedBlocks) console.log(`${row.name}\t x${block.count}\t${block.preview}`);
}
console.log("Largest built-in agent definitions");
for (const file of files.sort((a, b) => b.chars - a.chars).slice(0, 10)) {
	console.log(`${file.name}\t${file.chars} chars\t~${Math.ceil(file.chars / 4)} tokens`);
}
