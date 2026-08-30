// ABOUTME: Explicit, workspace-scoped memory records for durable decisions and fixes.
// ABOUTME: Separate from compaction memory; bounded, user-invoked, and never auto-saves arbitrary context.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface MemoryRecord { id: string; text: string; tags: string[]; createdAt: string; }
const Params = Type.Object({ action: Type.Union([Type.Literal("save"), Type.Literal("search"), Type.Literal("list")]), text: Type.Optional(Type.String()), tags: Type.Optional(Type.Array(Type.String())) });
function path(cwd: string) { return join(cwd, ".pi", "workspace-memory.jsonl"); }
function read(cwd: string): MemoryRecord[] { const p=path(cwd); if(!existsSync(p)) return []; try{return readFileSync(p,"utf8").split("\n").filter(Boolean).flatMap(l=>{try{return [JSON.parse(l) as MemoryRecord]}catch{return []}})}catch{return []} }
function safeText(text: string) { return text.trim().slice(0, 4000); }
export default function(pi: ExtensionAPI) { pi.registerTool({ name:"workspace_memory", label:"Workspace Memory", description:"Explicitly save, search, or list bounded workspace decisions and fixes. Memory is never saved automatically.", parameters:Params, async execute(_id, params, _signal, _update, ctx) { const p=params as {action:"save"|"search"|"list";text?:string;tags?:string[]}; const cwd=ctx.cwd||process.cwd(); if(p.action==="save"){const text=safeText(p.text||"");if(!text)return{content:[{type:"text",text:"Memory text is required."}],details:{error:true}};const rec={id:`m-${Date.now().toString(36)}`,text,tags:(p.tags||[]).slice(0,10).map(t=>t.slice(0,40)),createdAt:new Date().toISOString()};mkdirSync(join(cwd,".pi"),{recursive:true});appendFileSync(path(cwd),JSON.stringify(rec)+"\n");return{content:[{type:"text",text:`Saved workspace memory ${rec.id}.`}],details:rec};}const all=read(cwd);const q=(p.text||"").toLowerCase();const result=(p.action==="search"?all.filter(m=>`${m.text} ${m.tags.join(" ")}`.toLowerCase().includes(q)):all).slice(-100);return{content:[{type:"text",text:JSON.stringify(result)}],details:{count:result.length}}; }}); }
