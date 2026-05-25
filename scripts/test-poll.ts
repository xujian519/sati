import { ILinkClient } from "weixin-ilink";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const creds = JSON.parse(readFileSync(homedir() + "/.pilotdeck/weixin-credentials.json", "utf-8"));
const client = new ILinkClient({ baseUrl: creds.baseUrl, token: creds.botToken });

console.log("Polling with token:", creds.botToken.slice(0, 20) + "...");

async function main() {
  try {
    const resp = await client.poll();
    console.log("Poll response:", JSON.stringify(resp, null, 2));
  } catch (e) {
    console.error("Poll error:", e);
  }
}
main();
