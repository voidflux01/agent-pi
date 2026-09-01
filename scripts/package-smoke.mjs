#!/usr/bin/env node
// ABOUTME: Installs the packed Pi package in a disposable directory and checks runtime contents.
// ABOUTME: This catches missing files and undeclared production dependencies before release.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const sandbox = mkdtempSync(join(tmpdir(), "agent-pi-package-"));

function run(command, args, cwd = root) {
	return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

try {
	const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", sandbox]));
	if (!Array.isArray(packed) || !packed[0]?.filename) throw new Error("npm pack returned no tarball");
	const tarball = join(sandbox, packed[0].filename);

	const installDir = join(sandbox, "install");
	mkdirSync(installDir);
	run("npm", ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", tarball], installDir);
	const packageDir = join(installDir, "node_modules", manifest.name);

	const registeredPaths = Object.values(manifest.pi || {})
		.flatMap((paths) => Array.isArray(paths) ? paths : [])
		.map((path) => String(path).replace(/^\.\//, ""));
	const requiredPaths = [
		"package.json",
		...registeredPaths,
		// Shared runtime modules are easy to omit accidentally when package
		// inclusion rules change; verify the release contains the dispatch core.
		"extensions/lib/agent-task-journal.ts",
		"extensions/lib/dispatch-runtime.ts",
		"extensions/lib/run-state.ts",
		"scripts/doctor.mjs",
	];
	for (const path of requiredPaths) {
		if (!existsSync(join(packageDir, path))) throw new Error(`Packed package is missing ${path}`);
	}
	for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
		const dependencyManifest = join(installDir, "node_modules", dependency, "package.json");
		if (existsSync(dependencyManifest)) continue;
		if (manifest.optionalDependencies?.[dependency]) continue;
		throw new Error(`Production dependency is missing from the clean install: ${dependency}`);
	}

	console.log(`Package smoke test passed: ${packed[0].filename}`);
	console.log(`Installed ${Object.keys(manifest.dependencies || {}).length} production dependencies from a clean package tarball.`);
} finally {
	rmSync(sandbox, { recursive: true, force: true });
}
