// ABOUTME: Opt-in bridge for maintained third-party Pi extensions.
// ABOUTME: Disabled by default so existing installations remain stable; enable per session with PI_OPTIONAL_ADAPTERS=1.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default async function (pi: ExtensionAPI) {
  if (process.env.PI_OPTIONAL_ADAPTERS !== "1") return;
  try {
    // @ts-expect-error Optional git dependency may not expose types in every Pi install.
    const lsp = await import("pi-lsp-client");
    if (typeof lsp.default === "function") lsp.default(pi as any);
  } catch (error) {
    console.warn(`[optional-adapters] LSP unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const mcp = await import("pi-mcp-adapter");
    if (typeof mcp.default === "function") mcp.default(pi as any);
  } catch (error) {
    console.warn(`[optional-adapters] MCP adapter unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}
