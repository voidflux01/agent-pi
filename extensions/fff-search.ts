// ABOUTME: Optional FFF-backed search tools with native find/grep fallback semantics.
// ABOUTME: Native FFF failures never block the coding workflow.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { FileFinder } from "@ff-labs/fff-node";
import { execFileSync } from "node:child_process";

const Params = Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })) });

function fallback(cwd: string, query: string, grep: boolean, limit: number): string {
  try {
    const args = grep ? ["grep", "-RIn", "--exclude-dir=.git", "--", query, "."] : ["find", ".", "-iname", `*${query}*`, "-not", "-path", "./.git/*"];
    return execFileSync(args[0], args.slice(1), { cwd, encoding: "utf8", maxBuffer: 256 * 1024 }).split("\n").filter(Boolean).slice(0, limit).join("\n");
  } catch { return ""; }
}

export default function (pi: ExtensionAPI) {
  const finders = new Map<string, any>();
  const getFinder = (cwd: string) => {
    const existing = finders.get(cwd); if (existing && !existing.isDestroyed) return existing;
    const created = FileFinder.create({ basePath: cwd });
    if (!created.ok) return undefined;
    created.value.waitForScan(5000); finders.set(cwd, created.value); return created.value;
  };
  const register = (name: string, grep: boolean) => pi.registerTool({ name, label: name, description: `Fast FFF ${grep ? "content" : "file"} search with safe fallback`, parameters: Params, async execute(_id, params, _signal, _update, ctx) {
    const { query, limit = 20 } = params as { query: string; limit?: number };
    const cwd = ctx.cwd || process.cwd(); const finder = getFinder(cwd);
    if (finder) {
      const result = grep ? finder.grep(query, { pageSize: limit }) : finder.fileSearch(query, { pageSize: limit });
      if (result.ok) return { content: [{ type: "text", text: JSON.stringify(result.value) }], details: { engine: "fff" } };
    }
    return { content: [{ type: "text", text: fallback(cwd, query, grep, limit) || "No results" }], details: { engine: "fallback" } };
  }});
  register("fff_find", false); register("fff_grep", true);
  pi.on("session_shutdown", () => { for (const finder of finders.values()) { try { finder.destroy(); } catch {} } finders.clear(); });
}
