#!/usr/bin/env node
// ABOUTME: Run the mixed Bun/Vitest test suite with the runner each test file expects.
// ABOUTME: Bun is required for bun:test files; Vitest handles the remaining files.

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const testDir = resolve(root, "extensions", "__tests__");
const testFiles = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => resolve(testDir, name));

const bunFiles = testFiles.filter((file) => /\bfrom\s+["']bun:test["']/.test(readFileSync(file, "utf8")));
const vitestFiles = testFiles.filter((file) => !bunFiles.includes(file));

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) {
    console.error(`Failed to start ${command}: ${result.error.message}`);
    return result.status ?? 1;
  }
  return result.status ?? 1;
}

const bunStatus = run(process.env.BUN_BIN || "bun", ["test", "--isolate", ...bunFiles]);

const vitestCli = resolve(root, "node_modules", "vitest", "vitest.mjs");
const vitestStatus = run(process.execPath, [vitestCli, "run", ...vitestFiles]);

// Both phases always run: a bun-phase failure used to hide the entire vitest
// phase from `npm test`, so vitest regressions could ship unnoticed.
if (bunStatus !== 0 || vitestStatus !== 0) {
  console.error(`\nTest phases: bun ${bunStatus === 0 ? "PASS" : `FAIL(${bunStatus})`} · vitest ${vitestStatus === 0 ? "PASS" : `FAIL(${vitestStatus})`}`);
  process.exit(bunStatus !== 0 ? bunStatus : vitestStatus);
}
