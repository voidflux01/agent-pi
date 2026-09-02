import { execFileSync } from "node:child_process";

/** Close a test workspace and verify Herdr no longer reports it. */
export function closeHerdrWorkspace(workspaceId: string): void {
	if (!workspaceId) return;
	for (let attempt = 0; attempt < 10; attempt++) {
		try { execFileSync("herdr", ["workspace", "close", workspaceId], { stdio: "ignore", timeout: 30_000 }); } catch {}
		try {
			const raw = execFileSync("herdr", ["workspace", "list"], { encoding: "utf8", timeout: 30_000 });
			const workspaces = (JSON.parse(raw) as any).result?.workspaces ?? [];
			if (!workspaces.some((workspace: any) => workspace.workspace_id === workspaceId)) return true;
		} catch {}
		try { execFileSync("sleep", ["0.2"], { stdio: "ignore" }); } catch {}
	}
	throw new Error(`Herdr workspace ${workspaceId} remained after close attempts`);
}
