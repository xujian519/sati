import { installGlobalProxy } from "../src/cli/proxy.js";
import { ILinkClient } from "weixin-ilink";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const proxyResult = installGlobalProxy();
console.log("proxy installed:", proxyResult ?? "(none)");

const creds = JSON.parse(readFileSync(homedir() + "/.pilotdeck/weixin-credentials.json", "utf-8"));
const client = new ILinkClient({ baseUrl: creds.baseUrl, token: creds.botToken });

console.log("Polling...");
try {
  const resp = await client.poll();
  console.log("OK, msgs:", resp.msgs?.length ?? 0);
  if (resp.msgs?.length) {
    for (const msg of resp.msgs) {
      const text = msg.item_list?.[0]?.text_item?.text;
      console.log(`  from=${msg.from_user_id} text="${text}" ctx=${msg.context_token?.slice(0, 20)}`);
    }
  }
} catch (e) {
  console.error("Poll error:", (e as Error).message);
}
