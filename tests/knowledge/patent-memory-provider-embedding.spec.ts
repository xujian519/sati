import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { EmbeddingClient } from "../../src/model/embedding/types.js";
import type { MemoryRetrieveInput } from "../../src/context/memory/MemoryResolver.js";
import { PatentMemoryProvider } from "../../src/knowledge/patent/patent-memory-provider.js";
import { WikiCardLoader } from "../../src/knowledge/patent/wiki-card-loader.js";

/** 概念感知的确定性 stub embedding client（创造性→d0，外观设计→d1）。 */
function makeStubEmbeddingClient(): EmbeddingClient {
  const score = (text: string, keyword: string): number => {
    const count = (text.match(new RegExp(keyword, "g")) ?? []).length;
    return count > 0 ? 1 + count * 0.1 : 0;
  };
  return {
    dimensions: 2,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(text => [
        score(text, "创造") + score(text, "三步法"),
        score(text, "外观") + score(text, "设计"),
      ]);
    },
    async healthCheck(): Promise<boolean> {
      return true;
    },
  };
}

/** 构造一个极小的 wiki 卡目录（避免索引内置 1548 张卡拖慢测试）。 */
function makeFixtureWiki(): string {
  const dir = mkdtempSync(join(tmpdir(), "sati-wiki-"));
  const cardsDir = join(dir, "patent-cards");
  mkdirSync(cardsDir, { recursive: true });
  writeFileSync(
    join(cardsDir, "creative.md"),
    [
      "- 概念: 创造性",
      "- 领域: 创造性判断",
      "",
      "创造性判断三步法：确定最接近的现有技术，确定区别技术特征与实际解决的技术问题，",
      "判断要求保护的发明相对于现有技术是否显而易见。创造性是审查中最常见的问题之一。",
      "这个技术方案是否具备创造性，需要结合三步法逐项分析。",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(cardsDir, "design.md"),
    [
      "- 概念: 外观设计",
      "- 领域: 外观设计",
      "",
      "外观设计侵权判定以整体视觉效果为准，比较设计特征与授权外观设计。",
    ].join("\n"),
    "utf8",
  );
  return dir;
}

function makeInput(query: string): MemoryRetrieveInput {
  return { query, sessionId: "s1", projectRoot: "/tmp", recentMessages: [] };
}

describe("patent-memory-provider wiki 语义召回", () => {
  it("关键词漏召回时语义路径注入 wiki 卡片（预热就绪后）", async () => {
    const wikiDir = makeFixtureWiki();
    try {
      const loader = new WikiCardLoader(wikiDir);
      const provider = new PatentMemoryProvider({
        wikiLoader: loader,
        embedding: makeStubEmbeddingClient(),
        embeddingDir: join(wikiDir, "embeddings"),
        cardLimit: 1, // 只注入语义最相关的一张，便于断言
      });
      // 语义索引就绪后再检索（运行时由组装层启动后台预热）
      await provider.warmupSemanticIndex();
      // 长句改写 query：关键词（标题/概念子串）不命中，仅语义可召回
      const result = await provider.retrieve(makeInput("这个技术方案是否具备创造性，怎么判断"));
      assert.ok(result.systemContext, "应注入 wiki 卡片上下文");
      assert.ok(result.systemContext.includes("<wiki-card>"));
      assert.ok(result.systemContext.includes("创造性判断三步法"), "应注入创造性卡正文");
      assert.ok(!result.systemContext.includes("外观设计侵权判定"), "不应注入无关卡");
    } finally {
      rmSync(wikiDir, { recursive: true, force: true });
    }
  });

  it("语义索引未就绪时检索不阻塞（embedding 挂起时快速返回，语义路降级）", async () => {
    const wikiDir = makeFixtureWiki();
    try {
      const loader = new WikiCardLoader(wikiDir);
      // embed 被 gate 挂起：模拟慢/未就绪的 embedding 端点。若检索错误地 await
      // warmup，本测试将挂起直至超时——比时间断言更可靠地捕获回归。
      let releaseEmbed: (() => void) | undefined;
      const embedGate = new Promise<void>(resolve => {
        releaseEmbed = resolve;
      });
      const gatedClient: EmbeddingClient = {
        dimensions: 8,
        async embed(texts: string[]): Promise<number[][]> {
          await embedGate;
          return texts.map(() => new Array(8).fill(0.1));
        },
        async healthCheck(): Promise<boolean> {
          return true;
        },
      };
      const provider = new PatentMemoryProvider({
        wikiLoader: loader,
        embedding: gatedClient,
        embeddingDir: join(wikiDir, "embeddings"),
      });
      // 首次检索：warmup 被 gate 挂起，检索必须立即返回而非等待
      const result = await provider.retrieve(makeInput("这个技术方案是否具备创造性，怎么判断"));
      // 未就绪 → 无语义注入；keyword 路照常工作（不抛错）
      assert.ok(!result.systemContext?.includes("<wiki-card>"));
      // 放行后台 warmup，避免测试进程悬挂
      releaseEmbed?.();
    } finally {
      rmSync(wikiDir, { recursive: true, force: true });
    }
  });

  it("未配置 embedding 时行为与现状一致（无语义注入）", async () => {
    const wikiDir = makeFixtureWiki();
    try {
      const loader = new WikiCardLoader(wikiDir);
      const provider = new PatentMemoryProvider({ wikiLoader: loader });
      const result = await provider.retrieve(makeInput("这个技术方案是否具备创造性，怎么判断"));
      // 关键词路径无法命中英文标题/非子串概念 → 无 wiki 卡注入
      assert.ok(!result.systemContext?.includes("<wiki-card>"));
    } finally {
      rmSync(wikiDir, { recursive: true, force: true });
    }
  });

  it("embedding 检索抛错时降级（不阻断，keyword 路径照常）", async () => {
    const wikiDir = makeFixtureWiki();
    try {
      const loader = new WikiCardLoader(wikiDir);
      const failingClient: EmbeddingClient = {
        dimensions: 16,
        async embed(): Promise<number[][]> {
          throw new Error("embedding service down");
        },
        async healthCheck(): Promise<boolean> {
          return false;
        },
      };
      const provider = new PatentMemoryProvider({
        wikiLoader: loader,
        embedding: failingClient,
        embeddingDir: join(wikiDir, "embeddings"),
      });
      // 不抛错即通过
      await provider.retrieve(makeInput("外观设计"));
      await provider.retrieve(makeInput("这个技术方案是否具备创造性，怎么判断"));
    } finally {
      rmSync(wikiDir, { recursive: true, force: true });
    }
  });
});
