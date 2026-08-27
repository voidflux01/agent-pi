// ABOUTME: Node.js audio playback for hook-triggered sounds in the terminal.
// ABOUTME: Reads cached base64 sound data, decodes to temp MP3, plays via afplay/aplay/mpv.

import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execSync } from "node:child_process";
import { SOUNDS_DIR, ensureSoundsDir } from "./sounds-config.ts";

// ── Platform Detection ───────────────────────────────────────────────

type AudioPlayer = "afplay" | "aplay" | "mpv" | null;

let cachedPlayer: AudioPlayer | undefined;

const SAFE_SOUND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function soundPath(name: string): string {
	if (!SAFE_SOUND_NAME.test(name)) throw new Error("Invalid sound name");
	return join(SOUNDS_DIR, `${name}.json`);
}

function detectAudioPlayer(): AudioPlayer {
	if (cachedPlayer !== undefined) return cachedPlayer;

	const candidates: AudioPlayer[] = ["afplay", "aplay", "mpv"];
	for (const cmd of candidates) {
		try {
			execSync(`which ${cmd}`, { stdio: "ignore" });
			cachedPlayer = cmd;
			return cmd;
		} catch {
			continue;
		}
	}
	cachedPlayer = null;
	return null;
}

// ── Active Playback Tracking ─────────────────────────────────────────

let activeProcess: ReturnType<typeof spawn> | null = null;

export function stopPlayback(): void {
	if (activeProcess) {
		try { activeProcess.kill(); } catch {}
		activeProcess = null;
	}
}

export function isPlaying(): boolean {
	return activeProcess !== null && !activeProcess.killed;
}

// ── Temp File Helpers ────────────────────────────────────────────────

function writeTempMp3(base64Data: string): string {
	const tempPath = join(tmpdir(), `pi-sound-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`);
	const buffer = Buffer.from(base64Data, "base64");
	writeFileSync(tempPath, buffer);
	return tempPath;
}

function cleanupTemp(path: string): void {
	try {
		if (existsSync(path)) unlinkSync(path);
	} catch {
		// Best-effort cleanup
	}
}

// ── Install / Uninstall ──────────────────────────────────────────────

export interface CachedSound {
	name: string;
	dataUri: string;
}

export function installSound(name: string, dataUri: string): void {
	const filePath = soundPath(name);
	if (!/^data:audio\/[^;]+;base64,[A-Za-z0-9+/=]+$/.test(dataUri) || dataUri.length > 12 * 1024 * 1024) {
		throw new Error("Invalid or oversized audio data");
	}
	ensureSoundsDir();
	const data: CachedSound = { name, dataUri };
	writeFileSync(filePath, JSON.stringify(data), "utf-8");
}

export function uninstallSound(name: string): void {
	let filePath: string;
	try { filePath = soundPath(name); } catch { return; }
	try {
		if (existsSync(filePath)) unlinkSync(filePath);
	} catch {
		// Best-effort
	}
}

export function isSafeSoundName(name: string): boolean { return SAFE_SOUND_NAME.test(name); }

export function isSoundInstalled(name: string): boolean {
	try { return existsSync(soundPath(name)); } catch { return false; }
}

export function loadCachedSound(name: string): CachedSound | null {
	let filePath: string;
	try { filePath = soundPath(name); } catch { return null; }
	try {
		if (!existsSync(filePath)) return null;
		return JSON.parse(readFileSync(filePath, "utf-8")) as CachedSound;
	} catch {
		return null;
	}
}

// ── Playback ─────────────────────────────────────────────────────────

/**
 * Play a sound that has been installed/cached to the sounds directory.
 * Decodes base64 → temp MP3 → system audio player → cleanup.
 */
export async function playInstalledSound(soundName: string, volume: number = 0.5): Promise<boolean> {
	const player = detectAudioPlayer();
	if (!player) return false;

	const cached = loadCachedSound(soundName);
	if (!cached) return false;

	// Extract base64 data from data URI
	const base64Match = cached.dataUri.match(/^data:audio\/[^;]+;base64,(.+)$/);
	if (!base64Match) return false;

	const base64Data = base64Match[1];
	if (base64Data.length > 12 * 1024 * 1024) return false;
	const tempPath = writeTempMp3(base64Data);

	// Stop any currently playing sound
	stopPlayback();

	return new Promise<boolean>((resolve) => {
		try {
			const args = buildPlayerArgs(player, tempPath, volume);
			const proc = spawn(args[0], args.slice(1), {
				stdio: "ignore",
				detached: false,
			});

			activeProcess = proc;

			proc.on("close", () => {
				if (activeProcess === proc) activeProcess = null;
				cleanupTemp(tempPath);
				resolve(true);
			});

			proc.on("error", () => {
				if (activeProcess === proc) activeProcess = null;
				cleanupTemp(tempPath);
				resolve(false);
			});
		} catch {
			cleanupTemp(tempPath);
			resolve(false);
		}
	});
}

function buildPlayerArgs(player: AudioPlayer, filePath: string, volume: number): string[] {
	switch (player) {
		case "afplay":
			// afplay volume is 0-255, but we use -v flag which is a linear multiplier
			return ["afplay", "-v", String(volume), filePath];
		case "aplay":
			// aplay doesn't support volume directly, just play
			return ["aplay", "-q", filePath];
		case "mpv":
			return ["mpv", "--no-terminal", `--volume=${Math.round(volume * 100)}`, filePath];
		default:
			return [];
	}
}

// ── Cleanup ──────────────────────────────────────────────────────────

export function cleanupAllPlayback(): void {
	stopPlayback();
}
