// ABOUTME: Opt-in bridge for maintained third-party Pi extensions.
// ABOUTME: Disabled by default so existing installations remain stable; enable per session with PI_OPTIONAL_ADAPTERS=1.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default async function (pi: ExtensionAPI) {
  if (process.env.PI_OPTIONAL_ADAPTERS !== "1") return;
  try {
    const lsp = await import("pi-lsp-client/src/index.ts");
    if (typeof lsp.default === "function") lsp.default(pi as any);
  } catch (error) {
    console.warn(`[optional-adapters] LSP unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const mcp = await import("pi-mcp-adapter/index.ts");
    if (typeof mcp.default === "function") mcp.default(pi as any);
  } catch (error) {
    console.warn(`[optional-adapters] MCP adapter unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}
