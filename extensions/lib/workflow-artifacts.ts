// ABOUTME: Bounded workspace-local artifacts with immutable writes and redacted presentation.
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isWithinDirectory } from "./path-safety.ts";
import { redactSensitive } from "./sensitive-data.ts";

export const ARTIFACT_LIMIT = 256 * 1024;
export function safeWorkspacePath(cwd: string, path: string): string {
	const root = realpathSync(cwd);
	const target = resolve(root, path);
	if (!isWithinDirectory(root, target) || target === root) throw new Error("Path must be a workspace file");
	let cursor = root;
	for (const part of relative(root, target).split(sep)) {
		cursor = join(cursor, part);
		try { if (lstatSync(cursor).isSymbolicLink()) throw new Error("Symlink paths are not supported"); }
		catch (error: any) { if (error.code !== "ENOENT") throw error; }
	}
	return target;
}

export function readBounded(cwd: string, path: string, maxBytes = ARTIFACT_LIMIT, tail = false): string {
	const target = safeWorkspacePath(cwd, path);
	const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw new Error("Only regular files can be read");
		if (!tail && stat.size > maxBytes) throw new Error("File exceeds size limit");
		const buffer = Buffer.alloc(Math.min(maxBytes, stat.size));
		const count = readSync(fd, buffer, 0, buffer.length, tail ? Math.max(0, stat.size - maxBytes) : 0);
		const text = buffer.subarray(0, count).toString("utf8");
		return tail && stat.size > maxBytes ? text.slice(text.indexOf("\n") + 1) : text;
	} finally { closeSync(fd); }
}

export function redactEvidence(text: string): string {
	return redactSensitive(text)
		.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
		.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED EMAIL]")
		.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[REDACTED IP]")
		.replace(/(["']?(?:token|secret|password|api[_-]?key|authorization|cookie)["']?\s*[:=]\s*)["'][^"'\n]*["']/gi, "$1\"[REDACTED]\"")
		.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export function saveArtifact(cwd: string, category: string, value: unknown, key: string = randomUUID()): string {
	if (!/^[a-z-]+$/.test(category) || !/^[a-zA-Z0-9-]{1,80}$/.test(key)) throw new Error("Invalid artifact identity");
	const path = safeWorkspacePath(cwd, `.pi/workflow/${category}/${key}.json`);
	const text = redactEvidence(JSON.stringify(value, null, 2)) + "\n";
	if (Buffer.byteLength(text) > ARTIFACT_LIMIT) throw new Error("Artifact exceeds size limit");
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	safeWorkspacePath(cwd, path);
	writeFileSync(path, text, { flag: "wx", mode: 0o600 });
	return path;
}
