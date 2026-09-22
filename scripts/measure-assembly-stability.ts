/**
 * 装配稳定性测量（2.3「系统提示分桶」的先量后改工具）。
 *
 * 为什么需要它：`scripts/measure-fixed-overhead.ts` 量的是**首个请求的固定开销**（token 数），
 * 而 2.3 要修的问题是**跨轮缓存前缀稳定性**——`src/context/cache/CachePlan.ts` 白纸黑字写着
 * 「逐调用可变的注入（workspace-state 账本块、steer 消息、repeatToolReminder 提醒）必须位于
 * 最近 N 条断点之后」，但账本块实际经 `appendSystemPrompt` 进了 **system prompt**
 * （`src/agent/loop/modelRequest.ts` 的 `appendSystemPrompt` 组装），而 Anthropic 的
 * `cache_control` 打在整个 system 块上 → 逐轮可变的内容落在缓存前缀**之内**。
 *
 * 口径：
 *   同一会话连续多轮 `submitTurn`（假模型，不落真实流量），逐轮抓取 `CanonicalModelRequest`，
 *   比较 system prompt 的 token 数与内容摘要，并记录缓存断点落在哪些消息上。
 *   每个场景用独立的临时工作区 + 临时 pilotHome（`SATI_KNOWLEDGE_DIR` 指向不存在目录，
 *   避免把本机知识库算进来）。
 *
 * 能测什么 / 测不到什么（诚实边界）：
 *   能测：默认配置下 system prompt 是否逐轮稳定；可变段（SATI.md 项目指令）被外部改动时
 *         system prompt 是否整块变化；system / 工具 schema / 消息三段 token 分布；断点位置。
 *   测不到：需要真实写入才会出现的可变段（账本块要经 `workspace_note` 写入才有内容——
 *         空账本不产生块，见 `readWorkspaceLedgerBlock` 的 `empty` 分支）；记忆附件段
 *         （需要配置记忆 provider）；provider 侧的 `cache_control` 落点（本脚本在
 *         `__testModelFactory` 处截获请求，早于 provider adapter，故只报 canonical 断点）。
 *
 * 读法：**同一次运行内**比较各轮 system digest（逐字节一致才算「稳定」）；跨次运行的绝对 token
 * 数可能相差 ±1（会话时间锚点随启动时刻变），别拿它当回归判据。
 *
 * 用法：
 *   node --import tsx scripts/measure-assembly-stability.ts          # 人类可读
 *   node --import tsx scripts/measure-assembly-stability.ts --json   # 机器可读（改动前后对比用）
 */

import { createHash } from "node:crypto";
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
  "      protocol: anthropic",
  "      url: https://example.test/v1",
  "      apiKey: test-key",
  "      models:",
  "        model: {}",
  "telemetry:",
  "  enabled: false",
  "",
].join("\n");

const WINDOW_TOKENS = 131072;

/**
 * 用 anthropic 协议：显式缓存布局（`cachePlan`，system 块 + 最近 3 条消息）只对
 * anthropic 协议规划（`resolveRequestCachePlan` 的 `enabled` 条件），也是 issue 里
 * 说的「每轮打穿 system 缓存」的实际形态。token 口径与协议无关，故只跑一种协议。
 */

/** 只回一句话的假模型：只为抓取请求，不落真实流量。 */
function fakeModelRuntime(requests: CanonicalModelRequest[]): ModelRuntime {
  return {
    stream: async function* (request) {
      requests.push(request);
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "ok" };
      yield { type: "message_end", finishReason: "stop" };
    },
    complete: async () => ({ role: "assistant", content: [{ type: "text", text: "ok" }], finishReason: "stop" }),
    getCapabilities: () => DEFAULT_MODEL_CAPABILITIES,
    getMultimodal: () => ({ input: ["text"] }),
    getProviderProtocol: () => "anthropic",
    getProviderBaseUrl: () => undefined,
  };
}

type TurnMeasurement = {
  turn: number;
  /** 该轮**之前**发生的外部改动（人类可读；无改动为 undefined）。 */
  externalChange?: string;
  systemTokens: number;
  /** system prompt 内容摘要（前 12 位）；逐轮比较它是否相同。 */
  systemDigest: string;
  /** 与上一轮的 system prompt 是否逐字节一致。 */
  sameSystemAsPreviousTurn: boolean;
  toolSchemaTokens: number;
  messageTokens: number;
  messageCount: number;
  /** 断点相对「末尾消息」的偏移（0 = 最后一条消息）。 */
  breakpointOffsets: number[];
  /** Anthropic 专有的 per-request 缓存布局（非 anthropic 协议为 undefined）。 */
  cachePlan?: { system: boolean; messageOffsets: number[]; fingerprint: string };
  /** system prompt 前 600 字符（定位「多出来的是什么」）。 */
  systemPromptPreview: string;
};

type ScenarioMeasurement = {
  scenario: string;
  note: string;
  turns: TurnMeasurement[];
  /** system prompt 是否在所有轮次之间保持不变（2.3 的目标是「是」）。 */
  stableAcrossTurns: boolean;
};

type ScenarioSpec = {
  name: string;
  note: string;
  /** 工作区根目录里的 SATI.md 内容（undefined = 不写项目指令文件）。 */
  initialProjectInstructions?: string;
  /** 账本开关（SATI_WORKSPACE_LEDGER_ENABLED）。 */
  ledgerEnabled?: boolean;
  /** 每轮提交前的钩子：返回本次外部改动的说明（undefined = 无改动）。 */
  beforeTurn?: (turn: number, root: string) => string | undefined;
  turnCount: number;
};

function digestOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function breakpointOffsets(request: CanonicalModelRequest): number[] {
  const last = (request.messages?.length ?? 0) - 1;
  return (request.cacheBreakpoints ?? []).map(index => last - index).sort((a, b) => a - b);
}

async function measureScenario(spec: ScenarioSpec): Promise<ScenarioMeasurement> {
  const root = mkdtempSync(join(tmpdir(), "sati-assembly-"));
  const pilotHome = join(root, "pilot-home");
  mkdirSync(pilotHome, { recursive: true });
  writeFileSync(join(pilotHome, "sati.yaml"), BASE_CONFIG, "utf8");
  if (spec.initialProjectInstructions !== undefined) {
    writeFileSync(join(root, "SATI.md"), spec.initialProjectInstructions, "utf8");
  }

  const requests: CanonicalModelRequest[] = [];
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome,
    env: {
      SATI_KNOWLEDGE_DIR: join(root, "knowledge-absent"),
      ...(spec.ledgerEnabled ? { SATI_WORKSPACE_LEDGER_ENABLED: "1" } : {}),
    },
    __testModelFactory: () => fakeModelRuntime(requests),
  });

  const turns: TurnMeasurement[] = [];
  try {
    for (let turn = 1; turn <= spec.turnCount; turn += 1) {
      const externalChange = spec.beforeTurn?.(turn, root);
      const before = requests.length;
      for await (const _event of local.gateway.submitTurn({
        projectKey: root,
        sessionKey: "cli:assembly-stability",
        channelKey: "cli",
        message: `turn ${turn}`,
      })) {
        // 只需请求本身
      }
      const request = requests[before];
      if (!request) throw new Error(`第 ${turn} 轮没有捕获到模型请求`);
      const systemPrompt = request.systemPrompt ?? "";
      const previous = turns.at(-1);
      const lastMessageIndex = (request.messages?.length ?? 0) - 1;
      turns.push({
        turn,
        ...(externalChange === undefined ? {} : { externalChange }),
        systemTokens: countTokens(systemPrompt),
        systemDigest: digestOf(systemPrompt),
        sameSystemAsPreviousTurn: previous === undefined || previous.systemDigest === digestOf(systemPrompt),
        toolSchemaTokens: countTokens(JSON.stringify(request.tools ?? [])),
        messageTokens: countTokens(JSON.stringify(request.messages ?? [])),
        messageCount: request.messages?.length ?? 0,
        breakpointOffsets: breakpointOffsets(request),
        ...(request.cachePlan
          ? {
              cachePlan: {
                system: request.cachePlan.system,
                messageOffsets: request.cachePlan.messages.map(index => lastMessageIndex - index).sort((a, b) => a - b),
                fingerprint: request.cachePlan.fingerprint.slice(0, 12),
              },
            }
          : {}),
        systemPromptPreview: systemPrompt.slice(0, 600),
      });
    }
  } finally {
    local.dispose();
    rmSync(root, { recursive: true, force: true });
  }

  const digests = new Set(turns.map(turn => turn.systemDigest));
  return {
    scenario: spec.name,
    note: spec.note,
    turns,
    stableAcrossTurns: digests.size === 1,
  };
}

const SCENARIOS: ScenarioSpec[] = [
  {
    name: "default",
    note: "全新安装的下界：无 SATI.md、账本关（默认）",
    turnCount: 2,
  },
  {
    name: "project-instructions",
    note: "工作区含 SATI.md；第 3 轮前从外部编辑该文件（模拟用户/协作者改文档）",
    initialProjectInstructions: "# 项目指令\n\n- 交付物用简体中文。\n",
    turnCount: 3,
    beforeTurn: (turn, root) => {
      if (turn !== 3) return undefined;
      writeFileSync(join(root, "SATI.md"), "# 项目指令\n\n- 交付物用简体中文。\n- 引用一律给出段落号。\n", "utf8");
      return "在 SATI.md 追加一行（- 引用一律给出段落号。）";
    },
  },
  {
    name: "ledger-empty",
    note: "账本开关打开但账本从未写入（空账本不产生块）",
    ledgerEnabled: true,
    turnCount: 2,
  },
];

const results: ScenarioMeasurement[] = [];
for (const spec of SCENARIOS) {
  results.push(await measureScenario(spec));
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const result of results) {
    console.log(`\n=== ${result.scenario} ===  ${result.note}`);
    console.log(
      "turn  system  digest        tools   messages  (msg数)  cachePlan(system + 末尾消息偏移, 指纹)  跨轮一致",
    );
    for (const turn of result.turns) {
      if (turn.externalChange !== undefined) {
        console.log(`      ↳ 本轮前外部改动：${turn.externalChange}`);
      }
      const plan = turn.cachePlan
        ? `${turn.cachePlan.system ? "system" : "-"}+${JSON.stringify(turn.cachePlan.messageOffsets)} fp=${turn.cachePlan.fingerprint}`
        : "（非 anthropic 协议：无 per-request 缓存布局）";
      console.log(
        `${String(turn.turn).padEnd(5)} ${String(turn.systemTokens).padStart(6)}  ${turn.systemDigest}  ` +
          `${String(turn.toolSchemaTokens).padStart(5)}   ${String(turn.messageTokens).padStart(8)}  ` +
          `(${String(turn.messageCount).padStart(3)})   ${plan.padEnd(38)}  ` +
          `${turn.sameSystemAsPreviousTurn ? "是" : "否"}`,
      );
      if (turn.breakpointOffsets.length > 0) {
        console.log(
          `      ↳ 另有微压缩显式断点（cacheBreakpoints，自末尾）：${JSON.stringify(turn.breakpointOffsets)}`,
        );
      }
    }
    const first = result.turns[0];
    const last = result.turns.at(-1);
    if (first && last) {
      const delta = last.systemTokens - first.systemTokens;
      const pct = ((last.systemTokens / WINDOW_TOKENS) * 100).toFixed(2);
      console.log(
        `system prompt 跨轮稳定: ${result.stableAcrossTurns ? "是" : "否"}` +
          `（首轮 ${first.systemTokens} → 末轮 ${last.systemTokens}，Δ${delta >= 0 ? "+" : ""}${delta}；` +
          `占 128k 窗口 ${pct}%）`,
      );
    }
  }
}
