import { execFileSync } from "node:child_process";
const [wsId, cwd] = process.argv.slice(2);
const raw = execFileSync("herdr", ["tab", "create", "--workspace", wsId!, "--cwd", cwd!, "--label", "api-e2e", "--no-focus", "--env", "ZSH_DISABLE_COMPFIX=true"], { encoding: "utf8" });
const result = JSON.parse(raw).result;
console.log(JSON.stringify({ paneId: result?.root_pane?.pane_id, tabId: result?.tab?.tab_id }));
