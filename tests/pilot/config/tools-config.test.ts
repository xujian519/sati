import test from "node:test";
import assert from "node:assert/strict";
import { parseToolsConfig } from "../../../src/pilot/config/parseToolsConfig.js";
import type { PilotConfigDiagnostic } from "../../../src/pilot/config/types.js";

test("parses webSearch provider selection", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];

  const tools = parseToolsConfig({
    webSearch: {
      provider: "glm",
      apiKey: "  glm-key  ",
      endpoint: "  https://api.z.ai/api/paas/v4/web_search  ",
    },
  }, diagnostics);

  assert.deepEqual(tools, {
    webSearch: {
      provider: "glm",
      apiKey: "glm-key",
      endpoint: "https://api.z.ai/api/paas/v4/web_search",
    },
  });
  assert.deepEqual(diagnostics, []);
});

test("rejects unknown webSearch provider", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];

  const tools = parseToolsConfig({
    webSearch: {
      provider: "serpapi",
      apiKey: "key",
    },
  }, diagnostics);

  assert.deepEqual(tools, { webSearch: { apiKey: "key" } });
  assert.equal(diagnostics[0]?.code, "TOOLS_WEB_SEARCH_PROVIDER_INVALID");
});

test("parses custom webSearch provider settings", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];

  const tools = parseToolsConfig({
    webSearch: {
      provider: "custom",
      apiKey: "custom-key",
      endpoint: "https://custom.example/search",
      customProvider: {
        name: "My Search",
        auth: "queryApiKey",
        method: "GET",
        queryParam: "q",
        apiKeyParam: "token",
        resultsPath: "data.items",
        titleField: "headline",
        urlField: "url",
      },
    },
  }, diagnostics);

  assert.deepEqual(tools?.webSearch, {
    provider: "custom",
    apiKey: "custom-key",
    endpoint: "https://custom.example/search",
    customProvider: {
      name: "My Search",
      auth: "queryApiKey",
      method: "GET",
      queryParam: "q",
      apiKeyParam: "token",
      resultsPath: "data.items",
      titleField: "headline",
      urlField: "url",
    },
  });
  assert.deepEqual(diagnostics, []);
});

