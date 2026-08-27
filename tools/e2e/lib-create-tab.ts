import { createHerdrTaskTab } from "/Users/jingefang/.pi/agent/git/github.com/voidflux01/agent-pi/extensions/lib/herdr-client.ts";
const [wsId, cwd] = process.argv.slice(2);
console.log(JSON.stringify(createHerdrTaskTab(wsId!, cwd!, "api-e2e")));
