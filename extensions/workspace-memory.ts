// ABOUTME: Explicit, workspace-scoped memory records for durable decisions and fixes.
// ABOUTME: Separate from compaction memory; bounded, user-invoked, and never auto-saves arbitrary context.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface MemoryRecord { id: string; text: string; tags: string[]; createdAt: string; }
const MAX_TEXT = 4_000;
const MAX_RECORDS = 500;
const Params = Type.Object({
  action: Type.Union([Type.Literal("save"), Type.Literal("search"), Type.Literal("list")]),
  text: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String())),
});

export function memoryPath(cwd: string): string { return join(cwd, ".pi", "workspace-memory.jsonl"); }
export function readMemories(cwd: string): MemoryRecord[] {
  try {
    return readFileSync(memoryPath(cwd), "utf8").split("\n").filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line) as MemoryRecord]; } catch { return []; }
    });
  } catch { return []; }
}
function saveMemories(cwd: string, records: MemoryRecord[]): void {
  const path = memoryPath(cwd); mkdirSync(join(cwd, ".pi"), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, records.slice(-MAX_RECORDS).map(r => JSON.stringify(r)).join("\n") + "\n", "utf8");
  renameSync(tmp, path);
}
export function appendMemory(cwd: string, text: string, tags: string[] = []): MemoryRecord {
  const record = { id: `m-${Date.now().toString(36)}`, text: text.trim().slice(0, MAX_TEXT), tags: tags.slice(0, 10).map(t => t.trim().slice(0, 40)).filter(Boolean), createdAt: new Date().toISOString() };
  saveMemories(cwd, [...readMemories(cwd), record]);
  return record;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("memory", {
    description: "Workspace memory: /memory save <text> | /memory search <query> | /memory list",
    handler: async (args, ctx) => {
      const [action = "list", ...rest] = args.trim().split(/\s+/);
      const cwd = ctx.cwd || process.cwd();
      if (action === "save") {
        if (!rest.join(" ").trim()) { ctx.ui.notify("Usage: /memory save <text>", "warning"); return; }
        const record = appendMemory(cwd, rest.join(" "));
        ctx.ui.notify(`Saved workspace memory ${record.id}`, "info");
        return;
      }
      const records = readMemories(cwd);
      const query = rest.join(" ").toLowerCase();
      const result = action === "search" ? records.filter(r => `${r.text} ${r.tags.join(" ")}`.toLowerCase().includes(query)) : records;
      ctx.ui.notify(result.slice(-20).map(r => `${r.id}: ${r.text}`).join("\n") || "No workspace memories", "info");
    },
  });
  pi.registerTool({
    name: "workspace_memory",
    label: "Workspace Memory",
    description: "Explicitly save, search, or list bounded workspace decisions and fixes. Memory is never saved automatically.",
    parameters: Params,
    async execute(_id, params, _signal, _update, ctx) {
      const input = params as { action: "save" | "search" | "list"; text?: string; tags?: string[] };
      const cwd = ctx.cwd || process.cwd();
      if (input.action === "save") {
        const text = input.text?.trim() || "";
        if (!text) return { content: [{ type: "text", text: "Memory text is required." }], details: { error: true } };
        const record = appendMemory(cwd, text, input.tags);
        return { content: [{ type: "text", text: `Saved workspace memory ${record.id}.` }], details: record };
      }
      const query = (input.text || "").toLowerCase();
      const records = readMemories(cwd);
      const result = (input.action === "search" ? records.filter(r => `${r.text} ${r.tags.join(" ")}`.toLowerCase().includes(query)) : records).slice(-100);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: { count: result.length } };
    },
  });
}
