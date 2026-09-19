/**
 * `tools` 段的工具面配置：域裁剪（`visibleDomains` / `hiddenDomains`）与
 * 内置工具组开关（`documentStyle` / `kanban` / `team`）。
 *
 * 走真实网关接线（`createLocalGateway` + 注入的假模型），因为要证明的正是接线本身：
 * 配置最终落在会话可见的模型工具清单上。
 *
 * `#450` 起「默认面」取决于**工作区专利判据**（`src/pilot/workspace/patentSignals.ts`）：
 * 非专利工作区默认隐藏 patent 域，专利工作区（这里用 `.sati/rules.yaml` 引用专利规则包
 * 造信号）默认面与翻转前逐字一致。llm-replay fixture 不受影响——它的工具表由
 * `createBuiltinRegistry` 直接构造，不经网关（见 `docs/tri-issue-remediation-plan.md` §1.4）。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import type { CanonicalModelRequest, ModelRuntime } from "../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";

const BASE = [
  "schemaVersion: 1",
  "agent:",
  "  model: test/model",
  "  maxContextTokens: 65536",
  "  maxOutputTokens: 8192",
  "model:",
  "  providers:",
  "    test:",
  "      protocol: openai",
  "      url: https://example.test/v1",
  "      apiKey: test-key",
  "      models:",
  "        model: {}",
  "telemetry:",
  "  enabled: false",
  "",
].join("\n");

function fakeModelRuntime(requests: CanonicalModelRequest[]): ModelRuntime {
  return {
    stream: async function* (request) {
      requests.push(request);
      yield { type: "text_delta", text: "ok" };
    },
    complete: async () => ({ role: "assistant", content: [{ type: "text", text: "ok" }], finishReason: "stop" }),
    getCapabilities: () => DEFAULT_MODEL_CAPABILITIES,
    getMultimodal: () => ({ input: ["text"] }),
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: () => undefined,
  };
}

type SurfaceOptions = {
  /** 造一个专利工作区信号：项目规则包清单引用专利规则。 */
  patentProject?: boolean;
};

/** 用给定 `tools` 段跑一个真实回合，返回模型可见的工具名。 */
async function toolNamesFor(toolsSection: string, options: SurfaceOptions = {}): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), "sati-tool-surface-"));
  await writeFile(join(root, "sati.yaml"), BASE + toolsSection, "utf8");
  if (options.patentProject) {
    await mkdir(join(root, ".sati"), { recursive: true });
    await writeFile(join(root, ".sati", "rules.yaml"), "packs:\n  - patent/nuo-core\n", "utf8");
  }
  const requests: CanonicalModelRequest[] = [];
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    env: { SATI_KNOWLEDGE_DIR: join(root, "knowledge-absent") },
    __testModelFactory: () => fakeModelRuntime(requests),
  });
  try {
    for await (const _event of local.gateway.submitTurn({
      projectKey: root,
      sessionKey: "web:tool-surface",
      channelKey: "web",
      message: "hello",
    })) {
      // 只需捕获首个请求的工具清单
    }
    const request = requests[0];
    assert.ok(request, "应捕获到模型请求");
    return (request.tools ?? []).map(tool => tool.name);
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

test("非专利工作区默认隐藏 patent 域，空 tools 段与默认一致", async () => {
  const baseline = await toolNamesFor("");
  const emptySection = await toolNamesFor("tools: {}\n");

  assert.deepEqual(emptySection, baseline);
  // 非专利工作区：三组内置能力与通用工具照常，专利域（含文书工具）不出现。
  for (const name of ["kanban_get", "team_status", "read_file", "todo_write"]) {
    assert.ok(baseline.includes(name), `默认工具面应包含 ${name}`);
  }
  for (const hidden of ["patent_search", "draft_claims", "render_patent_document", "document_style_panel"]) {
    assert.ok(!baseline.includes(hidden), `${hidden} 属于 patent 域，非专利工作区默认应隐藏`);
  }
});

test("专利工作区默认面不变（patent 域与文书工具照常）", async () => {
  const names = await toolNamesFor("", { patentProject: true });
  for (const name of ["patent_search", "draft_claims", "render_patent_document", "document_style_panel"]) {
    assert.ok(names.includes(name), `专利工作区默认面应包含 ${name}`);
  }
  assert.deepEqual(names, await toolNamesFor("tools: {}\n", { patentProject: true }));
});

test("tools.patentDomain 显式声明优先于工作区判据（两个方向）", async () => {
  const opened = await toolNamesFor("tools:\n  patentDomain: true\n");
  assert.ok(opened.includes("patent_search"), "非专利工作区显式打开后应含 patent 域");

  const closed = await toolNamesFor("tools:\n  patentDomain: false\n", { patentProject: true });
  assert.ok(!closed.includes("patent_search"), "专利工作区显式关闭后不应含 patent 域");
  assert.ok(closed.includes("kanban_get"), "显式关闭只影响 patent 域");
});

test("hiddenDomains 移除该域工具，其他域与未标域工具不受影响", async () => {
  // 在专利工作区里跑：这样 patent 域的缺席只能来自用户写的 hiddenDomains，判据不参与。
  const names = await toolNamesFor("tools:\n  hiddenDomains:\n    - patent\n", { patentProject: true });

  for (const removed of ["patent_search", "draft_claims", "render_patent_document", "document_style_panel"]) {
    assert.ok(!names.includes(removed), `${removed} 属于 patent 域，应被裁剪`);
  }
  // 保留项只选**无 checkAvailability** 的工具：带可用性检查的工具（如 `law_search` 依赖
  // 本机法律知识库）在 CI 上会被剔除，拿它断言会让用例变成环境相关的假红。
  for (const kept of ["read_file", "todo_write", "structured_output", "kanban_get", "team_status"]) {
    assert.ok(names.includes(kept), `${kept} 不属于 patent 域，应保留`);
  }
});

test("内置工具组显式关闭后不再注册，其余工具不受影响", async () => {
  const names = await toolNamesFor(
    [
      "tools:",
      "  documentStyle:",
      "    enabled: false",
      "  kanban:",
      "    enabled: false",
      "  team:",
      "    enabled: false",
      "",
    ].join("\n"),
    { patentProject: true },
  );

  for (const removed of [
    "document_style_panel",
    "document_style_preset",
    "kanban_get",
    "kanban_update_card",
    "team_status",
    "team_share_read",
  ]) {
    assert.ok(!names.includes(removed), `${removed} 所在工具组已关闭，应缺席`);
  }
  for (const kept of ["patent_search", "read_file", "todo_write", "structured_output"]) {
    assert.ok(names.includes(kept), `${kept} 不受工具组开关影响`);
  }
});

test("visibleDomains 只保留白名单域，未标域工具不受约束", async () => {
  const names = await toolNamesFor("tools:\n  visibleDomains:\n    - filesystem\n    - shell\n");

  for (const kept of ["read_file", "edit_file", "glob", "grep", "bash"]) {
    assert.ok(names.includes(kept), `${kept} 属于白名单域，应保留`);
  }
  for (const removed of ["agent", "patent_search", "law_search", "get_current_time"]) {
    assert.ok(!names.includes(removed), `${removed} 不在白名单域内，应被裁剪`);
  }
  // 未标注 domain 的工具（看板等通用能力）不受白名单约束，关闭它们要用 tools.kanban.enabled。
  assert.ok(names.includes("kanban_get"), "未标注 domain 的工具不受域白名单约束");
});

test("配置了未命中的域不误伤工具面", async () => {
  const baseline = await toolNamesFor("");
  const names = await toolNamesFor("tools:\n  hiddenDomains:\n    - no_such_domain\n");

  assert.deepEqual(names, baseline);
});
