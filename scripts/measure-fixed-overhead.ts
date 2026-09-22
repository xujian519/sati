/**
 * 新会话首个请求的**固定开销**测量（#450 §3.6）。
 *
 * 为什么需要它：issue #450 的目标是"128k 窗口下固定开销 ≤ 20k（≤15%）"。这个数字此前
 * 只存在于人工测量里，无法回归——任何一次默认面/提示词改动都可能把它推高，而没有任何
 * 一条门禁会响。本脚本把口径固化下来。
 *
 * 口径（与 issue 结论、`docs/tri-issue-remediation-plan.md` §1.1 一致）：
 *   createLocalGateway({ __testModelFactory }) + **空 pilotHome、空工作区**
 *   （模拟全新安装：无 MCP 指令、无知识库）+ 一次 submitTurn + 分段 countTokens。
 * 机器相关量（MCP `<mcp-instructions>`、记忆段）在空 pilotHome 下为 0，因此本脚本给出的是
 * **下界**；开发机口径（含本机 MCP 配置）会高出数千 tokens。
 *
 * ⚠️ 2026-09-21 修正：上面的「无知识库」此前并不成立——网关构造路径解析知识库时没透传调用方
 * env（`resolveKnowledgeDbPaths()` 少了 `deps.env`），`SATI_KNOWLEDGE_DIR` 覆盖被忽略、回落到
 * 宿主 `process.env`，于是本机知识卡片（法规/商标卡片，数千 token）会混进数字并随命中内容漂移。
 * 缺口已修（`docs/notes/implemented/2026-09-21-knowledge-paths-env-threading.md`）；本机实测
 * 非专利工作区 system prompt 由 6061 → 5099。跨版本对比前先确认这一点。
 *
 * 用法：
 *   node --import tsx scripts/measure-fixed-overhead.ts            # 非专利工作区 + 专利工作区
 *   node --import tsx scripts/measure-fixed-overhead.ts --json     # 机器可读
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalGateway } from "../src/cli/createLocalGateway.js";
import { countTokens } from "../src/context/budget/tokenizer.js";
import type { CanonicalModelRequest, ModelRuntime } from "../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../src/model/protocol/capabilities.js";

const BASE_CONFIG = [
  "schemaVersion: 1",
  "agent:",
  "  model: test/model",
  "  maxContextTokens: 131072",
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

/** 一个只回一句话的假模型：只为拿首个请求，不落任何真实流量。 */
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

type Measurement = {
  workspace: string;
  tools: number;
  systemTokens: number;
  toolSchemaTokens: number;
  fixedOverheadTokens: number;
  /** schema 体积最大的几个工具（定位是哪一片在吃预算）。 */
  topTools: Array<{ name: string; tokens: number }>;
};

async function measure(workspace: "non-patent" | "patent"): Promise<Measurement> {
  const root = mkdtempSync(join(tmpdir(), "sati-overhead-"));
  const pilotHome = join(root, "pilot-home");
  mkdirSync(pilotHome, { recursive: true });
  writeFileSync(join(pilotHome, "sati.yaml"), BASE_CONFIG, "utf8");
  if (workspace === "patent") {
    mkdirSync(join(root, ".sati"), { recursive: true });
    writeFileSync(join(root, ".sati", "rules.yaml"), "packs:\n  - patent/nuo-core\n", "utf8");
  }

  const requests: CanonicalModelRequest[] = [];
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome,
    env: { SATI_KNOWLEDGE_DIR: join(root, "knowledge-absent") },
    __testModelFactory: () => fakeModelRuntime(requests),
  });
  try {
    for await (const _event of local.gateway.submitTurn({
      projectKey: root,
      sessionKey: "cli:fixed-overhead",
      channelKey: "cli",
      message: "hello",
    })) {
      // 只需首个请求
    }
    const request = requests[0];
    if (!request) throw new Error("没有捕获到模型请求");

    const systemTokens = countTokens(request.systemPrompt ?? "");
    const tools = request.tools ?? [];
    const toolSchemaTokens = countTokens(JSON.stringify(tools));
    const topTools = tools
      .map(tool => ({ name: tool.name, tokens: countTokens(JSON.stringify(tool)) }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 10);
    return {
      workspace,
      tools: tools.length,
      systemTokens,
      toolSchemaTokens,
      fixedOverheadTokens: systemTokens + toolSchemaTokens,
      topTools,
    };
  } finally {
    local.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}

const results = [await measure("non-patent"), await measure("patent")];

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const result of results) {
    console.log(`\n=== ${result.workspace} workspace ===`);
    console.log(`tools:           ${result.tools}`);
    console.log(`system:          ${result.systemTokens}`);
    console.log(`tool schemas:    ${result.toolSchemaTokens}`);
    console.log(
      `fixed overhead:  ${result.fixedOverheadTokens}  (128k window: ${((result.fixedOverheadTokens / 131072) * 100).toFixed(1)}%)`,
    );
    console.log("top tool schemas:");
    for (const tool of result.topTools) {
      console.log(`  ${tool.name.padEnd(28)} ${String(tool.tokens).padStart(5)} tokens`);
    }
  }
  const [off, on] = results;
  if (off && on) {
    console.log("\n=== A/B delta（判据开启 vs 关闭） ===");
    console.log(`tools:   ${on.tools - off.tools}`);
    console.log(`schemas: ${on.toolSchemaTokens - off.toolSchemaTokens}`);
    console.log(`system:  ${on.systemTokens - off.systemTokens}  (技能/角色清单)`);
    console.log(`total:   ${on.fixedOverheadTokens - off.fixedOverheadTokens}`);
  }
}
