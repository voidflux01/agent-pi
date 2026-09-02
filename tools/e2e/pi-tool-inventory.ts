// ABOUTME: Provider-free inventory probe for the real Pi extension surface.
// ABOUTME: Runs during startup, records pi.getAllTools(), then exits before any model request.

import { writeFileSync } from "node:fs";

const output = process.env.PI_TOOL_INVENTORY_OUTPUT;
if (!output) throw new Error("PI_TOOL_INVENTORY_OUTPUT is required");

export default function (pi: any) {
	pi.on("session_start", () => {
		const tools = pi.getAllTools().map((tool: any) => ({
			name: tool.name,
			description: tool.description || "",
		})).sort((a: any, b: any) => a.name.localeCompare(b.name));
		writeFileSync(output, JSON.stringify({ status: "PASS", count: tools.length, tools }, null, 2) + "\n");
		setTimeout(() => process.exit(0), 25);
	});
}
