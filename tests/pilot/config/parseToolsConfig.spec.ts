import assert from "node:assert/strict";
import test from "node:test";
import { parseToolsConfig } from "../../../src/pilot/config/parseToolsConfig.js";
import type { PilotConfigDiagnostic } from "../../../src/pilot/config/types.js";

test("web search can be explicitly disabled without discarding provider config", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];

  const config = parseToolsConfig(
    {
      webSearch: {
        enabled: false,
        provider: "tavily",
        apiKey: "test-key",
        endpoint: "https://example.test/search",
      },
    },
    diagnostics,
  );

  assert.deepEqual(config, {
    webSearch: {
      enabled: false,
      provider: "tavily",
      apiKey: "test-key",
      endpoint: "https://example.test/search",
    },
  });
  assert.deepEqual(diagnostics, []);
});

test("web search enabled remains optional for backwards compatibility", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];

  const config = parseToolsConfig(
    {
      webSearch: { provider: "glm" },
    },
    diagnostics,
  );

  assert.deepEqual(config, { webSearch: { provider: "glm" } });
  assert.deepEqual(diagnostics, []);
});

test("web search enabled must be a boolean", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];

  parseToolsConfig(
    {
      webSearch: { enabled: "false" },
    },
    diagnostics,
  );

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.code, "TOOLS_WEB_SEARCH_ENABLED_INVALID");
  assert.equal(diagnostics[0]?.severity, "fatal");
});

// 空块 ≠ 无段（上游 #588）：遗留配置用空块表达 opt-in（凭证来自环境变量），
// 解析层把它丢掉等于运行期静默关掉该工具；而 §tools 段本身缺失才是"未配置"。
test("missing search configuration stays distinct from a present empty or legacy block", () => {
  for (const tools of [undefined, {}]) {
    const diagnostics: PilotConfigDiagnostic[] = [];
    assert.equal(parseToolsConfig(tools, diagnostics), undefined);
    assert.deepEqual(diagnostics, []);
  }

  for (const [webSearch, warnings] of [
    [{}, []],
    [{ region: "cn" }, ["TOOLS_WEB_SEARCH_REGION_DEPRECATED"]],
    [{ unknownLegacyField: true }, ["TOOLS_WEB_SEARCH_UNKNOWN_FIELD"]],
  ] as const) {
    const diagnostics: PilotConfigDiagnostic[] = [];
    assert.deepEqual(parseToolsConfig({ webSearch }, diagnostics), { webSearch: {} });
    assert.deepEqual(
      diagnostics.map(item => item.code),
      warnings,
    );
    assert.ok(diagnostics.every(item => item.severity === "warning"));
  }
});

test("paper search 空块同样保留（与 webSearch 同语义）", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];

  // 全字段被丢弃（未知字段 + 非布尔开关）后仍是空对象，而不是 undefined
  assert.deepEqual(parseToolsConfig({ paperSearch: {} }, diagnostics), { paperSearch: {} });
  assert.deepEqual(parseToolsConfig({ paperSearch: { unknownLegacyField: true } }, diagnostics), { paperSearch: {} });
  assert.deepEqual(
    diagnostics.map(item => item.code),
    ["TOOLS_PAPER_SEARCH_UNKNOWN_FIELD"],
  );
});

test("webSearch 与 paperSearch 的在场状态互不影响", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];

  assert.deepEqual(parseToolsConfig({ webSearch: {} }, diagnostics), { webSearch: {} });
  assert.deepEqual(parseToolsConfig({ paperSearch: {} }, diagnostics), { paperSearch: {} });
  assert.deepEqual(parseToolsConfig({ webSearch: {}, paperSearch: {} }, diagnostics), {
    webSearch: {},
    paperSearch: {},
  });
  assert.deepEqual(diagnostics, []);
});
