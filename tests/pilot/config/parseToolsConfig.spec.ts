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

test("域裁剪清单逐项 trim 后保留，空数组视为未配置", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];

  assert.deepEqual(parseToolsConfig({ visibleDomains: [" patent ", "legal"] }, diagnostics), {
    visibleDomains: ["patent", "legal"],
  });
  assert.deepEqual(parseToolsConfig({ hiddenDomains: ["literature"] }, diagnostics), {
    hiddenDomains: ["literature"],
  });
  assert.equal(parseToolsConfig({ hiddenDomains: [] }, diagnostics), undefined);
  assert.deepEqual(diagnostics, []);
});

test("域裁剪清单必须是字符串数组", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];

  assert.equal(parseToolsConfig({ visibleDomains: "patent" }, diagnostics), undefined);
  assert.equal(parseToolsConfig({ hiddenDomains: [""] }, diagnostics), undefined);

  assert.deepEqual(
    diagnostics.map(item => item.code),
    ["TOOLS_VISIBLE_DOMAINS_INVALID", "TOOLS_HIDDEN_DOMAINS_INVALID"],
  );
  assert.ok(diagnostics.every(item => item.severity === "fatal"));
});

test("内置工具组开关：段缺失不写字段，空块与 enabled 原样保留", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];

  // 段缺失 = 保持历史默认（注册），解析结果里不得出现该键。
  assert.equal(parseToolsConfig({}, diagnostics), undefined);

  assert.deepEqual(parseToolsConfig({ documentStyle: {} }, diagnostics), { documentStyle: {} });
  assert.deepEqual(parseToolsConfig({ kanban: { enabled: false } }, diagnostics), { kanban: { enabled: false } });
  assert.deepEqual(parseToolsConfig({ team: { enabled: true } }, diagnostics), { team: { enabled: true } });
  assert.deepEqual(diagnostics, []);
});

test("内置工具组开关的非布尔 enabled 是 fatal 诊断", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];

  parseToolsConfig({ kanban: { enabled: "false" } }, diagnostics);

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.code, "TOOLS_KANBAN_INVALID_ENABLED");
  assert.equal(diagnostics[0]?.severity, "fatal");
  // enabled 非法被丢弃后仍保留空块：段在场即默认开启，不能因单个字段非法而整段消失。
  assert.deepEqual(parseToolsConfig({ team: { enabled: 1 } }, []), { team: {} });
});

test("tools 段的未知字段告警覆盖新增字段白名单", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];

  const config = parseToolsConfig(
    {
      visibleDomains: ["patent"],
      hiddenDomains: ["legal"],
      documentStyle: { enabled: false },
      kanban: {},
      team: {},
      unknownToolField: true,
    },
    diagnostics,
  );

  assert.deepEqual(config, {
    visibleDomains: ["patent"],
    hiddenDomains: ["legal"],
    documentStyle: { enabled: false },
    kanban: {},
    team: {},
  });
  assert.deepEqual(
    diagnostics.map(item => item.code),
    ["TOOLS_UNKNOWN_FIELD"],
  );
});

test("patentDomain 三态：显式布尔保留，缺省不落键（缺省 = 交给工作区判据）", () => {
  assert.deepEqual(parseToolsConfig({ patentDomain: true }, []), { patentDomain: true });
  assert.deepEqual(parseToolsConfig({ patentDomain: false }, []), { patentDomain: false });
  assert.equal(parseToolsConfig({ webSearch: { enabled: false } }, [])?.patentDomain, undefined);
});

test("patentDomain 非布尔是 fatal 诊断且整项丢弃（不静默取真）", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];

  const config = parseToolsConfig({ patentDomain: "yes" }, diagnostics);

  assert.equal(config, undefined);
  assert.deepEqual(
    diagnostics.map(item => [item.code, item.severity, item.recoverable]),
    [["TOOLS_PATENT_DOMAIN_INVALID", "fatal", false]],
  );
});

test("patentDomain 在已知字段白名单内（不产生未知字段告警）", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];

  parseToolsConfig({ patentDomain: true, unknownToolField: 1 }, diagnostics);

  assert.deepEqual(
    diagnostics.map(item => item.code),
    ["TOOLS_UNKNOWN_FIELD"],
  );
});
