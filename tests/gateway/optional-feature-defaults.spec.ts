/**
 * 可选功能「未配置 = 关闭」的运行时门控（上游 #588 移植）。
 *
 * 本用例走**真实网关接线**（`createLocalGateway` + 注入的假模型），因为要证明的
 * 恰恰是接线本身：`tools.webSearch` / `tools.paperSearch` 段的三种形态最终落在
 * 工具注册表上的差异。仅测 `parseToolsConfig` 或 `isOptionalFeatureEnabled`
 * 无法覆盖"解析出来的 undefined 在装配点被当成什么"。
 *
 * ⚠️ 老行为（本用例要挡住）：段缺失时两个搜索工具照样注册，凭环境变量
 * `TAVILY_API_KEY` / `GLM_WEB_SEARCH_API_KEY` 就能跑起来——用户没配过搜索，
 * 却拿到了搜索工具。因此下面每一档都刻意注入 `TAVILY_API_KEY`。
 *
 * 附带覆盖 router：`router` 段缺失时不得产生分类调用（judge 走 `complete()`，
 * 请求文本含固定标识 "model-tier classifier"）。
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

type Variant = {
  name: string;
  extra: string;
  webSearch: boolean;
  paperSearch: boolean;
  router: boolean;
};

const VARIANTS: Variant[] = [
  {
    name: "段缺失 → 两个搜索工具不注册、router 不分类",
    extra: "",
    webSearch: false,
    paperSearch: false,
    router: false,
  },
  {
    name: "显式关闭 → 不注册、不分类",
    extra: [
      "router:",
      "  enabled: false",
      "tools:",
      "  webSearch:",
      "    enabled: false",
      "  paperSearch:",
      "    enabled: false",
      "",
    ].join("\n"),
    webSearch: false,
    paperSearch: false,
    router: false,
  },
  {
    name: "显式开启 → 注册、分类",
    extra: [
      "router:",
      "  enabled: true",
      "tools:",
      "  webSearch:",
      "    enabled: true",
      "    provider: tavily",
      "  paperSearch:",
      "    enabled: true",
      "",
    ].join("\n"),
    webSearch: true,
    paperSearch: true,
    router: true,
  },
  {
    name: "遗留段无 enabled → 保留 opt-in，注册且分类",
    extra: [
      "router:",
      "  scenarios:",
      "    default: test/model",
      "tools:",
      "  webSearch:",
      "    provider: tavily",
      "  paperSearch:",
      "    arxiv: true",
      "",
    ].join("\n"),
    webSearch: true,
    paperSearch: true,
    router: true,
  },
  {
    name: "遗留空块 → 该工具仍注册（空块 = 遗留 opt-in），未配置的兄弟工具关闭",
    extra: ["tools:", "  webSearch: {}", ""].join("\n"),
    webSearch: true,
    paperSearch: false,
    router: false,
  },
];

function fakeModelRuntime(requests: CanonicalModelRequest[], completions: string[]): ModelRuntime {
  return {
    stream: async function* (request) {
      requests.push(request);
      yield { type: "text_delta", text: "ok" };
    },
    complete: async request => {
      completions.push(request.messages.map(message => JSON.stringify(message.content)).join("\n"));
      return { role: "assistant", content: [{ type: "text", text: "ok" }], finishReason: "stop" };
    },
    getCapabilities: () => DEFAULT_MODEL_CAPABILITIES,
    getMultimodal: () => ({ input: ["text"] }),
    getProviderProtocol: () => undefined,
    getProviderBaseUrl: () => undefined,
  };
}

for (const variant of VARIANTS) {
  test(`可选功能运行时门控：${variant.name}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "sati-optional-features-"));
    await writeFile(join(root, "sati.yaml"), BASE + variant.extra, "utf8");
    await mkdir(join(root, "skills"), { recursive: true });

    const requests: CanonicalModelRequest[] = [];
    const completions: string[] = [];
    const local = createLocalGateway({
      projectRoot: root,
      pilotHome: root,
      env: {
        // 知识库是外部大文件（本机 ~/.sati/knowledge 217MB+），测试指向空目录走降级路径
        SATI_KNOWLEDGE_DIR: join(root, "knowledge-absent"),
        TAVILY_API_KEY: "present-but-not-opt-in",
      },
      __testModelFactory: () => fakeModelRuntime(requests, completions),
    });

    try {
      const events = [];
      for await (const event of local.gateway.submitTurn({
        projectKey: root,
        sessionKey: "web:optional-features",
        channelKey: "web",
        message: "hello",
      })) {
        events.push(event);
      }

      assert.deepEqual(
        events.filter(event => event.type === "error"),
        [],
        "回合不应报错（诊断见日志）",
      );

      const toolNames = (requests[0]?.tools ?? []).map(tool => tool.name);
      assert.equal(toolNames.includes("web_search"), variant.webSearch, `web_search 注册状态：${toolNames.join(",")}`);
      assert.equal(
        toolNames.includes("paper_search"),
        variant.paperSearch,
        `paper_search 注册状态：${toolNames.join(",")}`,
      );
      assert.equal(
        toolNames.includes("paper_list_sources"),
        variant.paperSearch,
        `paper_list_sources 注册状态：${toolNames.join(",")}`,
      );

      // 分类调用只可能来自 tokenSaver judge；会话标题生成走同一 complete()，
      // 故按提示标识筛选，避免把标题算成分类。
      const judgeCalls = completions.filter(text => text.includes("model-tier classifier"));
      assert.equal(judgeCalls.length > 0, variant.router, "关闭的 router 不得产生隐藏分类调用");
    } finally {
      local.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
}
