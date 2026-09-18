/**
 * `tools` 段的工具面配置：域裁剪（`visibleDomains` / `hiddenDomains`）与
 * 内置工具组开关（`documentStyle` / `kanban` / `team`）。
 *
 * 走真实网关接线（`createLocalGateway` + 注入的假模型），因为要证明的正是接线本身：
 * 配置最终落在会话可见的模型工具清单上，且**默认（段缺失）行为与改动前逐字一致**
 * （默认路径一变就会破坏 llm-replay fixture 的 toolSchemaDigest）。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

/** 用给定 `tools` 段跑一个真实回合，返回模型可见的工具名。 */
async function toolNamesFor(toolsSection: string): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), "sati-tool-surface-"));
  await writeFile(join(root, "sati.yaml"), BASE + toolsSection, "utf8");
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

test("默认与空 tools 段的工具面一致（新增字段不改变默认行为）", async () => {
  const baseline = await toolNamesFor("");
  const emptySection = await toolNamesFor("tools: {}\n");

  assert.deepEqual(emptySection, baseline);
  // 默认面仍带着三组内置工具与专利域工具——默认路径必须与改动前一致。
  for (const name of ["document_style_panel", "kanban_get", "team_status", "patent_search", "read_file"]) {
    assert.ok(baseline.includes(name), `默认工具面应包含 ${name}`);
  }
});

test("hiddenDomains 移除该域工具，其他域与未标域工具不受影响", async () => {
  const names = await toolNamesFor("tools:\n  hiddenDomains:\n    - patent\n");

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
