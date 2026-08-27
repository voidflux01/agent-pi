// ABOUTME: Pure detector for model-driven nested pi launches ("shadow fleets").
// ABOUTME: A parent model that shells out `pi -p ...` / `pi --mode json ...`
// ABOUTME bypasses dispatch_agent entirely: no task journal row, no herdr tab,
// ABOUTME no RESULT contract, no full-transcript archive. This probe flags
// ABOUTME such commands so the delegation-guard extension can block them and
// ABOUTME route the model back to the team tools.

/**
 * True when the shell command launches a headless (non-interactive) pi.
 * Interactive `pi` panes are allowed — the risk is silent automation, not
 * a visible pane a human can watch.
 */
export function probeNestedPiLaunch(command: string): boolean {
	if (!command) return false;
	const tokens = command.split(/\s+/);
	for (let i = 0; i < tokens.length; i++) {
		const raw = tokens[i];
		// strip surrounding quotes/backticks before path check
		const tok = raw.replace(/^["'`]+|["'`]+$/g, "");
		const base = tok.slice(tok.lastIndexOf("/") + 1);
		if (base !== "pi" && base !== "pi.exe") continue;
		// look at the rest of this command for headless-mode markers
		for (let j = i + 1; j < tokens.length; j++) {
			const t = tokens[j].replace(/^["'`]+|["'`]+$/g, "");
			if (t === "|") break; // piped pi is a different pipeline; stay conservative
			if (t === "-p" || t === "--print" || t === "--mode") return true;
			if (t.startsWith("--mode=")) return true;
		}
	}
	return false;
}
