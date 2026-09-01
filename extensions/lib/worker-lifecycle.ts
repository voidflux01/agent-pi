// ABOUTME: Shared lifecycle bookkeeping for orchestration workers.
// ABOUTME: Invalidates stale callbacks and releases timers/processes together.

export interface LifecycleProcess {
	kill?: (signal?: NodeJS.Signals | number) => void;
}

export interface WorkerLifecycle {
	currentEpoch(): number;
	nextEpoch(): number;
	isCurrent(epoch: number): boolean;
	trackTimer<T extends ReturnType<typeof setInterval>>(timer: T): T;
	clearTimer(timer: ReturnType<typeof setInterval> | undefined): void;
	trackProcess<T extends LifecycleProcess>(process: T): T;
	clearProcess(process: LifecycleProcess | undefined): void;
	stopAll(signal?: NodeJS.Signals | number): void;
}

/**
 * Keep lifecycle invalidation and owned resource cleanup in one place.
 * Callers may still perform graceful process shutdown separately; this helper
 * provides the synchronous final release used at session/mode boundaries.
 */
export function createWorkerLifecycle(): WorkerLifecycle {
	let epoch = 0;
	const timers = new Set<ReturnType<typeof setInterval>>();
	const processes = new Set<LifecycleProcess>();

	return {
		currentEpoch: () => epoch,
		nextEpoch: () => ++epoch,
		isCurrent: (candidate) => candidate === epoch,
		trackTimer: (timer) => {
			timers.add(timer);
			return timer;
		},
		clearTimer: (timer) => {
			if (!timer) return;
			clearInterval(timer);
			timers.delete(timer);
		},
		trackProcess: (process) => {
			processes.add(process);
			return process;
		},
		clearProcess: (process) => {
			if (process) processes.delete(process);
		},
		stopAll: (signal = "SIGTERM") => {
			epoch++;
			for (const timer of timers) clearInterval(timer);
			timers.clear();
			for (const process of processes) {
				try { process.kill?.(signal); } catch {}
			}
			processes.clear();
		},
	};
}
