import test from "node:test";
import assert from "node:assert/strict";
import { createWebSearchTool, type WebSearchOutput } from "../../../src/tool/builtin/webSearch.js";
import { createDefaultPermissionContext } from "../../../src/permission/index.js";

const RUN = process.env.PILOTDECK_RUN_REAL_WEB_SEARCH_E2E === "1";
const PROVIDER = process.env.PILOTDECK_E2E_WEB_SEARCH_PROVIDER === "tavily" ? "tavily" : "glm";
const ENDPOINT = process.env.PILOTDECK_E2E_WEB_SEARCH_ENDPOINT?.trim() || undefined;

test(
  "web_search hits the real configured provider and returns organic results",
  { timeout: 60_000 },
  async (t) => {
    if (!RUN) {
      t.skip(
        "Set PILOTDECK_RUN_REAL_WEB_SEARCH_E2E=1 with GLM_WEB_SEARCH_API_KEY/ZAI_API_KEY or TAVILY_API_KEY to run the real web_search e2e test.",
      );
      return;
    }
    const apiKey = PROVIDER === "tavily"
      ? process.env.TAVILY_API_KEY?.trim()
      : (process.env.GLM_WEB_SEARCH_API_KEY?.trim() || process.env.ZAI_API_KEY?.trim());
    if (!apiKey) {
      throw new Error(`${PROVIDER === "tavily" ? "TAVILY_API_KEY" : "GLM_WEB_SEARCH_API_KEY or ZAI_API_KEY"} env var is required for the real web_search e2e test.`);
    }

    const tool = createWebSearchTool({ provider: PROVIDER, apiKey, endpoint: ENDPOINT });
    const cwd = process.cwd();
    const result = await tool.execute(
      { query: "PilotDeck", gl: "US" },
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
    assert.equal(output.query, "PilotDeck");
    assert.ok(output.organic.length >= 1, "Expected at least one organic result.");
    const firstHit = output.organic[0];
    assert.ok(firstHit?.link?.startsWith("http"), "Expected first organic result to have a URL.");
  },
);
