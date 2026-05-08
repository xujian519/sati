import test from "node:test";
import assert from "node:assert/strict";
import { createWebSearchTool, type WebSearchOutput } from "../../../src/tool/builtin/webSearch.js";
import { createDefaultPermissionContext } from "../../../src/permission/index.js";

const RUN = process.env.POLITDECK_RUN_REAL_WEB_SEARCH_E2E === "1";
const REGION = (process.env.POLITDECK_E2E_WEB_SEARCH_REGION ?? "cn") as "cn" | "global";

test(
  "web_search hits the real serp.hk API and returns organic results",
  { timeout: 60_000 },
  async (t) => {
    if (!RUN) {
      t.skip(
        "Set POLITDECK_RUN_REAL_WEB_SEARCH_E2E=1 (with SERP_API_KEY in env) to run the real serp.hk e2e test.",
      );
      return;
    }
    const apiKey = process.env.SERP_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("SERP_API_KEY env var is required for the real web_search e2e test.");
    }

    const tool = createWebSearchTool({ apiKey, region: REGION });
    const cwd = process.cwd();
    const result = await tool.execute(
      { query: "PolitDeck", gl: "US" },
      {
        sessionId: "session-web-search-e2e",
        turnId: "turn-web-search-e2e",
        cwd,
        permissionMode: "default",
        permissionContext: createDefaultPermissionContext({
          cwd,
          mode: "default",
          canPrompt: false,
        }),
      },
    );

    const output = result.data as WebSearchOutput;
    assert.equal(output.query, "PolitDeck");
    assert.ok(output.organic.length >= 1, "Expected at least one organic result.");
    const firstHit = output.organic[0];
    assert.ok(firstHit?.link?.startsWith("http"), "Expected first organic result to have a URL.");
  },
);
