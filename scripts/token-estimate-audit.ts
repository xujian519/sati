#!/usr/bin/env tsx
/**
 * Token 估算审计脚本（T1.1：验证快速通道不低估）。
 *
 * 目的：取证 —— 验证 TokenAccountingRuntime 快速通道（本地估算 ≤ 窗口 ×
 * nearLimitRatio 时跳过 provider count_tokens）所依赖的本地估算的保守性。
 *
 * 审计内容：
 *   1. 合成专利会话负载（工具 schema / 中文 claims / 法条引用 / 检索结果 /
 *      multimodal 块）：输出非 padded 与 padded（4/3 上界）估算、膨胀比、
 *      分块构成，作为人工评估基准（可对比 provider count_tokens）；
 *   2. 真实转录回放（可选 --samples-dir）：解析 ~/.sati 会话 JSONL，
 *      聚合各轮消息文本估算，输出分布与 padded 上界。
 *
 * 用法：
 *   pnpm tsx scripts/token-estimate-audit.ts
 *   pnpm tsx scripts/token-estimate-audit.ts --samples-dir ~/.sati/projects --limit 20
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { TokenBudgetManager } from "../src/context/budget/TokenBudgetManager.js";
import type { CanonicalMessage } from "../src/model/index.js";
import { readTranscript } from "../src/session/index.js";

type CliArgs = { samplesDir?: string; limit: number };

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { limit: 20 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]!;
    const value = argv[i + 1];
    if (key === "--samples-dir" && value) {
      args.samplesDir = value;
      i += 1;
    } else if (key === "--limit" && value) {
      args.limit = Number.parseInt(value, 10) || 20;
      i += 1;
    }
  }
  return args;
}

/** 典型专利会话负载（覆盖 Sati 主要内容类型）。 */
function buildSyntheticSamples(): Array<{ name: string; messages: CanonicalMessage[] }> {
  const claimsText = `1. 一种锂离子电池负极材料的制备方法，其特征在于，包括以下步骤：
将硅基前驱体与碳源混合，在惰性气氛下于 600-900℃ 热处理 2-6 小时，得到硅碳复合材料；
其中，所述硅基前驱体选自纳米硅、多孔硅或硅氧化物中的至少一种，
所述碳源选自葡萄糖、蔗糖、淀粉、聚乙烯吡咯烷酮或沥青中的至少一种。`;
  const lawText = `专利法第二十六条第三款规定，说明书应当对发明或者实用新型作出清楚、完整的说明，以所属技术领域的技术人员能够实现为准；
必要的时候，应当有附图。摘要应当简要说明发明或者实用新型的技术要点。`;
  const searchResult = `{"total": 42, "items": [{"id": "CN113000000A", "title": "一种硅碳负极材料的制备方法", "abstract": "本发明涉及锂离子电池负极材料领域，公开了一种硅碳负极材料及其制备方法，通过将纳米硅与碳前驱体复合，在惰性气氛下热处理，获得具有优异循环性能的硅碳复合材料。", "assignee": "宁德时代新能源科技股份有限公司", "publication_date": "2021-06-22"}, {"id": "CN112000000B", "title": "硅基复合材料及其制备方法", "abstract": "本发明提供一种硅基复合材料，包含硅颗粒和包覆于所述硅颗粒表面的碳层。", "assignee": "比亚迪股份有限公司", "publication_date": "2021-03-05"}]}`;

  const systemPrompt = `你是 Sati 专利智能体。请基于专利法、审查指南进行专业分析。回答须引用具体法条，结论须给出依据。`;

  const toolSchemas = [
    {
      name: "patent_search",
      description: "检索专利文献。支持按关键词、IPC 分类号、申请人与日期范围过滤。",
      inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } } },
    },
    {
      name: "patent_case_search",
      description: "检索专利无效复审决定与专利判决全文。",
      inputSchema: { type: "object", properties: { keywords: { type: "string" }, court: { type: "string" } } },
    },
  ];

  const text = (text: string) => ({ type: "text" as const, text });
  return [
    {
      name: "简短问答",
      messages: [{ role: "user" as const, content: [text("什么是单独对比原则？")] }],
    },
    {
      name: "新颖性分析（claims + 法条）",
      messages: [
        { role: "system" as const, content: [text(systemPrompt)] },
        { role: "user" as const, content: [text(claimsText)] },
        { role: "user" as const, content: [text(lawText)] },
        {
          role: "assistant" as const,
          content: [text("对比文件 1 公开了硅基前驱体与碳源复合的技术方案，其区别技术特征在于热处理温度范围。")],
        },
      ],
    },
    {
      name: "检索 + 侵权比对（tool_result 大负载）",
      messages: [
        { role: "system" as const, content: [text(systemPrompt)] },
        { role: "user" as const, content: [text(claimsText)] },
        {
          role: "assistant" as const,
          content: [
            text("我将检索现有技术。"),
            { type: "tool_call" as const, id: "t1", name: "patent_search", input: { query: "硅碳负极 制备" } },
          ],
        },
        {
          role: "user" as const,
          content: [
            { type: "tool_result" as const, tool_call_id: "t1", content: [{ type: "text", text: searchResult }] },
          ],
        },
      ],
    },
    {
      name: "multimodal（附图分析）",
      messages: [
        {
          role: "user" as const,
          content: [
            text("分析附图 1 的电路结构。"),
            { type: "image" as const, source: { type: "url", url: "data:image/png;base64,AAAA" } },
          ],
        },
      ],
    },
    {
      name: "全量工具目录（70 工具）",
      messages: [
        { role: "system" as const, content: [text(systemPrompt)] },
        { role: "user" as const, content: [text("对权利要求 1 进行创造性分析。")] },
      ],
      toolsNote: toolSchemas,
    },
  ] as Array<{ name: string; messages: CanonicalMessage[]; toolsNote?: unknown[] }>;
}

/** 从真实转录提取各轮文本 token 估算。 */
async function auditRealSamples(samplesDir: string, limit: number, budget: TokenBudgetManager): Promise<void> {
  const files: string[] = [];
  const collect = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "chats" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        await collect(full);
      } else if (entry.name.endsWith(".jsonl")) {
        files.push(full);
      }
    }
  };
  await collect(samplesDir);

  let scanned = 0;
  let messageCount = 0;
  let rawTotal = 0;
  let paddedTotal = 0;
  let maxRawMessage = 0;
  for (const file of files.slice(0, limit)) {
    const { entries } = await readTranscript(file);
    for (const entry of entries) {
      if (
        entry.type !== "assistant_message" &&
        entry.type !== "tool_result_message" &&
        entry.type !== "durable_message"
      ) {
        continue;
      }
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;
      const messages: CanonicalMessage[] = [{ role: entry.message.role, content }];
      const raw = budget.estimateMessagesTokens(messages);
      const padded = budget.estimateForMessagesWithPadding(messages);
      rawTotal += raw;
      paddedTotal += padded;
      messageCount += 1;
      maxRawMessage = Math.max(maxRawMessage, raw);
    }
    scanned += 1;
  }

  console.log(`\n=== 真实转录回放（${scanned} 个文件，${messageCount} 条消息） ===`);
  if (messageCount === 0) {
    console.log("未找到 agent_message 条目（检查 --samples-dir 指向会话目录）。");
    return;
  }
  console.log(`单条消息原始估算最大: ${maxRawMessage} tokens`);
  console.log(`原始估算合计: ${rawTotal} tokens（平均 ${Math.round(rawTotal / messageCount)}/条）`);
  console.log(`padded(4/3) 合计: ${paddedTotal} tokens（平均 ${Math.round(paddedTotal / messageCount)}/条）`);
  console.log(`整体膨胀比: ${(paddedTotal / Math.max(1, rawTotal)).toFixed(3)}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const budget = new TokenBudgetManager();
  const samples = buildSyntheticSamples();

  console.log("=== Token 估算审计（tiktoken o200k_base） ===\n");
  console.log("合成专利会话负载：");
  for (const sample of samples) {
    const raw = budget.estimateMessagesTokens(sample.messages);
    const padded = budget.estimateForMessagesWithPadding(sample.messages);
    const perBlock = sample.messages.map(message => ({
      role: message.role,
      tokens: budget.estimateForMessage(message),
    }));
    const ratio = raw > 0 ? (padded / raw).toFixed(3) : "0";
    console.log(`\n[${sample.name}] 消息数=${sample.messages.length} 原始=${raw} padded=${padded} 膨胀比=${ratio}`);
    for (const block of perBlock) {
      console.log(`  - ${block.role}: ${block.tokens} tokens`);
    }
  }

  if (args.samplesDir) {
    await auditRealSamples(args.samplesDir, args.limit, budget);
  } else {
    console.log("\n提示：传 --samples-dir <会话目录> 可回放真实转录（见脚本头注释）。");
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
