#!/usr/bin/env node
// ABOUTME: Dependency, package, configuration, and local Pi registration diagnostics.
// ABOUTME: Emits human-readable output by default and machine-readable JSON with --json.

import { builtinModules } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const jsonOutput = args.has("--json");
const strict = args.has("--strict");
const results = [];

function add(id, status, message, details = {}) {
	results.push({ id, status, message, ...details });
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

function packageName(specifier) {
	if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
	return specifier.split("/")[0];
}

function importedPackages(directory) {
	const packages = new Map();
	for (const name of readdirSync(directory)) {
		if (!name.endsWith(".ts")) continue;
		const path = join(directory, name);
		const source = readFileSync(path, "utf8");
		const staticImports = source.matchAll(/^\s*import\s+(?:type\s+)?(?:[^"'\n]+?\sfrom\s+)?["']([^"']+)["']/gm);
		const dynamicImports = source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g);
		for (const match of [...staticImports, ...dynamicImports]) {
			const specifier = match[1];
			if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) continue;
			if (builtinModules.includes(specifier)) continue;
			packages.set(packageName(specifier), name);
		}
	}
	return packages;
}

const optionalImports = new Set(["@anthropic-ai/claude-agent-sdk"]);

function checkManifest() {
	const path = join(root, "package.json");
	const manifest = readJson(path);
	if (!manifest) {
		add("manifest", "fail", "package.json is missing or invalid JSON");
		return null;
	}
	add("manifest", "pass", `package.json ${manifest.name || "(unnamed)"}@${manifest.version || "unknown"}`);

	const pi = manifest.pi || {};
	for (const [kind, paths] of Object.entries(pi)) {
		if (!Array.isArray(paths)) continue;
		for (const relativePath of paths) {
			if (existsSync(join(root, relativePath))) add(`path:${kind}:${relativePath}`, "pass", `${kind} path exists: ${relativePath}`);
			else add(`path:${kind}:${relativePath}`, "fail", `${kind} path is missing: ${relativePath}`);
		}
	}

	const declared = new Set([
		...Object.keys(manifest.dependencies || {}),
		...Object.keys(manifest.optionalDependencies || {}),
		...Object.keys(manifest.devDependencies || {}),
		...Object.keys(manifest.peerDependencies || {}),
	]);
	const missing = [];
	const optional = [];
	for (const [name, file] of importedPackages(join(root, "extensions"))) {
		if (declared.has(name)) continue;
		if (optionalImports.has(name)) optional.push(`${name} (from ${file})`);
		else missing.push(`${name} (from ${file})`);
	}
	if (missing.length) add("runtime-imports", "fail", "Extensions import undeclared packages", { missing });
	else add("runtime-imports", "pass", "All extension package imports are declared");
	if (optional.length) add("optional-imports", "info", "Optional extension integrations are not installed; related features may be unavailable", { optional });

	const extensionCount = readdirSync(join(root, "extensions")).filter((name) => name.endsWith(".ts")).length;
	add("inventory", "pass", `${extensionCount} top-level TypeScript extensions detected`, { extensionCount });
	return manifest;
}

function checkRuntime() {
	const nodeMajor = Number(process.versions.node.split(".")[0]);
	if (nodeMajor >= 18) add("node", "pass", `Node.js ${process.version}`);
	else add("node", "fail", `Node.js ${process.version} is too old; Node.js 18+ is required`);
	if (process.env.BUN_BIN || commandExists("bun")) add("bun", "pass", "Bun is available for the full test suite");
	else add("bun", "warn", "Bun is missing; npm test cannot run the bun:test files");
}

function commandExists(command) {
	const path = process.env.PATH || "";
	const delimiter = process.platform === "win32" ? ";" : ":";
	return path.split(delimiter).some((directory) => existsSync(join(directory, command)) || existsSync(join(directory, `${command}.cmd`)));
}

function checkConfigs() {
	const yamlPackage = join(root, "node_modules", "yaml");
	if (!existsSync(yamlPackage)) {
		add("yaml", "warn", "yaml package is unavailable; skipping YAML validation");
		return;
	}
	import("yaml").then(({ parse }) => {
		for (const file of ["agents/teams.yaml", "agents/agent-chain.yaml", "agents/pipeline-team.yaml"]) {
			const path = join(root, file);
			try {
				const value = parse(readFileSync(path, "utf8"));
				if (!value || typeof value !== "object") throw new Error("root value is not an object");
				add(`yaml:${file}`, "pass", `${file} is valid YAML`);
			} catch (error) {
				add(`yaml:${file}`, "fail", `${file} is invalid: ${error.message}`);
			}
		}
	}).catch((error) => add("yaml", "fail", `Could not load yaml parser: ${error.message}`));
}

function checkPiRegistration() {
	const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
	if (!existsSync(settingsPath)) {
		add("pi-registration", "warn", `Pi settings not found: ${settingsPath}`);
		return;
	}
	const settings = readJson(settingsPath);
	if (!settings) {
		add("pi-registration", "fail", "Pi settings.json is invalid JSON");
		return;
	}
	const registered = Array.isArray(settings.packages) && settings.packages.includes(root);
	if (registered) add("pi-registration", "pass", "This checkout is registered in Pi settings");
	else add("pi-registration", "warn", "This checkout is not registered in Pi settings; run ./install.sh");
}

const manifest = checkManifest();
checkRuntime();
checkConfigs();
checkPiRegistration();

await new Promise((resolvePromise) => setImmediate(resolvePromise));

const counts = results.reduce((acc, item) => {
		acc[item.status] = (acc[item.status] || 0) + 1;
		return acc;
	}, {});
const exitCode = counts.fail ? 1 : strict && counts.warn ? 1 : 0;

if (jsonOutput) {
	console.log(JSON.stringify({ root, package: manifest?.name || null, counts, results }, null, 2));
} else {
	console.log(`agent-pi doctor — ${root}`);
	for (const result of results) {
		const icon = result.status === "pass" ? "✓" : result.status === "info" ? "i" : result.status === "warn" ? "⚠" : "✗";
		console.log(`  ${icon} [${result.status}] ${result.message}`);
		if (result.missing) for (const missing of result.missing) console.log(`      - ${missing}`);
		if (result.optional) for (const optional of result.optional) console.log(`      - ${optional}`);
	}
	console.log(`\nSummary: ${counts.pass || 0} passed, ${counts.warn || 0} warnings, ${counts.fail || 0} failures`);
}
process.exit(exitCode);
