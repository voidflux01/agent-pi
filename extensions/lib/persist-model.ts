// ABOUTME: Persists an explicitly selected Pi model as the global default.
// ABOUTME: This is opt-in so temporary model changes never alter user defaults.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, resolve } from "path";

const DEFAULT_SETTINGS_PATH = resolve(homedir(), ".pi", "agent", "settings.json");

export interface ModelRef {
	provider: string;
	modelId: string;
}

function sleep(ms: number): void {
	try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

/**
 * Persist a model without changing unrelated Pi settings.
 * A small lock and same-directory rename prevent concurrent Pi processes from
 * losing settings updates or leaving a partially-written JSON file.
 */
export function persistModel(model: ModelRef, settingsPath: string = DEFAULT_SETTINGS_PATH): void {
	const lockPath = `${settingsPath}.lock`;
	const tempPath = `${settingsPath}.tmp-${process.pid}-${Date.now()}`;
	mkdirSync(dirname(settingsPath), { recursive: true });

	let lockFd: number | undefined;
	try {
		for (let attempt = 0; attempt < 25; attempt++) {
			try {
				lockFd = openSync(lockPath, "wx");
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt === 24) throw error;
				sleep(20);
			}
		}

		const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
		settings.defaultProvider = model.provider;
		settings.defaultModel = model.modelId;
		writeFileSync(tempPath, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
		renameSync(tempPath, settingsPath);
	} finally {
		try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch {}
		try { if (lockFd !== undefined) closeSync(lockFd); } catch {}
		try { if (lockFd !== undefined) unlinkSync(lockPath); } catch {}
	}
}
