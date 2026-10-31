import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import type { MemoryRetrieveInput } from "../../src/context/memory/MemoryResolver.js";
import type { RerankClient } from "../../src/model/embedding/rerank.js";
import { LegalMemoryProvider } from "../../src/knowledge/legal/legal-memory-provider.js";
import { LegalSearchEngine } from "../../src/knowledge/legal/legal-search.js";
import { PatentMemoryProvider } from "../../src/knowledge/patent/patent-memory-provider.js";
import type { PatentKgAdapter } from "../../src/knowledge/patent/patent-kg-adapter.js";
import type { WikiCardLoader } from "../../src/knowledge/patent/wiki-card-loader.js";

function makeInput(query: string): MemoryRetrieveInput {
  return { query, sessionId: "s1", projectRoot: "/tmp", recentMessages: [] };
}

describe("patent-memory-provider", () => {
  it("化学类 query 注入 IPC 标准上下文", async () => {
    const provider = new PatentMemoryProvider();
    const result = await provider.retrieve(makeInput("一种高分子化合物的合成方法，涉及催化剂"));
    assert.ok(result.systemContext);
    assert.ok(result.systemContext.includes("<ipc-standards"));
  });

  it("大类命中充足时精注入大类卡片（替代部级全量注入）", async () => {
    const provider = new PatentMemoryProvider();
    const result = await provider.retrieve(makeInput("一种手性化合物的合成方法，涉及有机化学中间体"));
    assert.ok(result.systemContext);
    assert.ok(result.systemContext.includes('<ipc-standards section="C"'));
    // 精注入 C07 三张卡（格式为 [CC07]，部+大类拼接），不含 C 部其他大类（C02/C04…）的卡片
    assert.ok(result.systemContext.includes("[CC07]"));
    assert.ok(!result.systemContext.includes("[CC02]"));
  });

  it("大类命中不足时回退部级注入", async () => {
    const provider = new PatentMemoryProvider();
    const result = await provider.retrieve(makeInput("一种通信电路"));
    assert.ok(result.systemContext);
    assert.ok(result.systemContext.includes('<ipc-standards section="H"'));
    // 回退注入 H 部卡片（格式 [HHxx]）；H04 大类仅命中 1 词（低于精注入门槛）
    assert.ok(/\[HH\d{2}\]/.test(result.systemContext));
  });

  it("standardsLimit 截断部级回退注入的卡片数", async () => {
    const provider = new PatentMemoryProvider({ standardsLimit: 2 });
    const result = await provider.retrieve(makeInput("一种通信电路"));
    assert.ok(result.systemContext);
    // 回退 H 部注入（18 张卡）被截断为前 2 张
    const hCardCount = (result.systemContext.match(/\[HH\d{2}\]/g) ?? []).length;
    assert.equal(hCardCount, 2);
  });

  it("多重分类：跨部高置信 query 并行注入两部", async () => {
    const provider = new PatentMemoryProvider();
    const result = await provider.retrieve(makeInput("医药药物和化学组合物"));
    assert.ok(result.systemContext);
    // A 部（医药/药物 2 词，精注入 A61）与 C 部（化学/组合物 2 词，回退部级）并行注入
    assert.ok(result.systemContext.includes('<ipc-standards section="A"'));
    assert.ok(result.systemContext.includes('<ipc-standards section="C"'));
    assert.ok(result.systemContext.includes("[AA61]"));
  });

  it("部级单命中但大类多命中时仍精注入（门槛放宽）", async () => {
    const provider = new PatentMemoryProvider();
    // "汽车座椅"仅命中 B 部级 1 词（汽车），但 B60 大类命中 3 词（车辆/汽车/座椅）→ 精注入
    const result = await provider.retrieve(makeInput("一种汽车座椅的安全带装置"));
    assert.ok(result.systemContext);
    assert.ok(result.systemContext.includes('<ipc-standards section="B"'));
    assert.ok(result.systemContext.includes("[BB60]"));
  });

  it("多重分类受 multiSectionLimit 约束", async () => {
    const provider = new PatentMemoryProvider({ multiSectionLimit: 1 });
    const result = await provider.retrieve(makeInput("医药药物和化学组合物"));
    assert.ok(result.systemContext);
    // 并列 top（A/C 同置信度，A 在前）只注入 A 部
    assert.ok(result.systemContext.includes('<ipc-standards section="A"'));
    assert.ok(!result.systemContext.includes('<ipc-standards section="C"'));
  });

  it("多重分类 + standardsLimit 控制总注入卡片数", async () => {
    const provider = new PatentMemoryProvider({ standardsLimit: 2 });
    const result = await provider.retrieve(makeInput("医药药物和化学组合物"));
    assert.ok(result.systemContext);
    // A 精注入 A61 截 2 张 + C 回退截 2 张 = 4 张卡片
    const cardCount = (result.systemContext.match(/^- \[/gm) ?? []).length;
    assert.equal(cardCount, 4);
  });

  it("无图谱时仍可用 IPC 标准（不抛错）", async () => {
    const provider = new PatentMemoryProvider({ kgAdapter: undefined, enableGraph: true });
    const result = await provider.retrieve(makeInput("一种通信电路"));
    assert.ok(result.systemContext);
  });

  it("纯闲聊 query 返回空上下文", async () => {
    const provider = new PatentMemoryProvider();
    const result = await provider.retrieve(makeInput("你好，帮我写一首诗"));
    assert.equal(result.systemContext, undefined);
  });

  it("taskIntent=oa 时 wiki 卡片注入上限提升（默认 2 → ≥4）", async () => {
    // mock wikiLoader：关键词搜索恒返回 10 张卡；关闭 IPC/图谱聚焦卡片路径
    const loader = {
      search: () => Array.from({ length: 10 }, (_, i) => ({ id: `card-${i}`, title: `卡片${i}` })),
      getById: () => undefined,
      formatAsContext: (id: string) => `卡片正文 ${id}`,
    };
    const general = new PatentMemoryProvider({
      wikiLoader: loader as unknown as WikiCardLoader,
      enableStandards: false,
      enableGraph: false,
      cardLimit: 2,
    });
    const oa = new PatentMemoryProvider({
      wikiLoader: loader as unknown as WikiCardLoader,
      enableStandards: false,
      enableGraph: false,
      cardLimit: 2,
    });
    const query = "答复审查意见中权利要求清楚性分析";
    const generalResult = await general.retrieve(makeInput(query));
    const oaResult = await oa.retrieve({ ...makeInput(query), taskIntent: "oa" });
    const generalCount = (generalResult.systemContext?.match(/<wiki-card>/g) ?? []).length;
    const oaCount = (oaResult.systemContext?.match(/<wiki-card>/g) ?? []).length;
    assert.ok(generalCount <= 2, `general 意图应保持默认上限（实际 ${generalCount}）`);
    assert.ok(oaCount >= 3, `oa 意图应提升卡片注入（实际 ${oaCount}）`);
  });

  it("taskIntent=general 时保持默认上限", async () => {
    const loader = {
      search: () => Array.from({ length: 10 }, (_, i) => ({ id: `card-${i}`, title: `卡片${i}` })),
      getById: () => undefined,
      formatAsContext: (id: string) => `卡片正文 ${id}`,
    };
    const provider = new PatentMemoryProvider({
      wikiLoader: loader as unknown as WikiCardLoader,
      enableStandards: false,
      enableGraph: false,
      cardLimit: 2,
    });
    const result = await provider.retrieve({ ...makeInput("答复审查意见"), taskIntent: "general" });
    const count = (result.systemContext?.match(/<wiki-card>/g) ?? []).length;
    assert.ok(count <= 2, `general 意图应保持默认上限（实际 ${count}）`);
  });

  it("knowledgeProfile.ipcSections：弱命中 query 强制注入声明部审查标准", async () => {
    // "车辆连接器"对 B 部可能仅弱命中（置信度低于默认门槛）；
    // 声明 ipcSections:["B"] 后，只要 classification 存在 B 部候选即强制注入。
    const query = "一种车辆连接器";
    const profileResult = await new PatentMemoryProvider({ multiSectionLimit: 1 }).retrieve({
      ...makeInput(query),
      knowledgeProfile: { ipcSections: ["B"] },
    });
    assert.ok(profileResult.systemContext?.includes('<ipc-standards section="B"'), "profile 应强制注入 B 部标准");
  });

  it("knowledgeProfile.ipcSections 未命中 query 不强制注入", async () => {
    const provider = new PatentMemoryProvider({ multiSectionLimit: 1 });
    // query 不含 B 部任何候选词：profile 声明 B 也不应凭空注入（保守：仅对 classification 存在候选的部强制）
    const result = await provider.retrieve({
      ...makeInput("一种抗肿瘤化合物"),
      knowledgeProfile: { ipcSections: ["B"] },
    });
    assert.ok(!result.systemContext?.includes('<ipc-standards section="B"'), "未命中候选不应强制注入 B 部");
  });

  it("captureTurn 为空操作", async () => {
    const provider = new PatentMemoryProvider();
    await provider.captureTurn({ sessionId: "s1", projectRoot: "/tmp", messages: [], errored: false });
  });

  it("rerankTopN 透传到图谱路径的 rerank 调用", async () => {
    const topNs: Array<number | undefined> = [];
    const stubKg = {
      searchRelevant: () => [
        { node: { id: "n1", nodeType: "Concept", name: "创造性", title: "" }, via: "keyword" },
        { node: { id: "n2", nodeType: "Concept", name: "三步法", title: "" }, via: "keyword" },
      ],
      getNode: () => undefined,
    } as unknown as PatentKgAdapter;
    const stubRerank: RerankClient = {
      async rerank(
        _query: string,
        documents: string[],
        topN?: number,
      ): Promise<Array<{ index: number; score: number }>> {
        topNs.push(topN);
        return documents.map((_, index) => ({ index, score: 1 - index * 0.1 }));
      },
      async healthCheck(): Promise<boolean> {
        return true;
      },
    };
    const provider = new PatentMemoryProvider({ kgAdapter: stubKg, rerank: stubRerank, rerankTopN: 2 });
    const result = await provider.retrieve(makeInput("创造性的判断标准是什么"));
    assert.ok(result.systemContext?.includes("<knowledge-graph>"));
    assert.equal(topNs.length, 1);
    assert.equal(topNs[0], 2);
  });
});

/**
 * 夹具法律库：**内存/临时 sqlite**，schema 与生产 laws-full-local.db 一致
 * （law + category 两表，application_id="LAWS"、user_version=1），含真实法条文本。
 * 这层不依赖开发者本机 knowledge.db，CI 上也真正执行（不再按本机库存在性 skip）。
 */
function createLawsFixture(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE category (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL,
        isSubFolder INTEGER NOT NULL DEFAULT 0, "group" TEXT, "order" INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE law (
        id TEXT PRIMARY KEY, level TEXT NOT NULL, name TEXT NOT NULL, filename TEXT,
        publish TEXT, expired INTEGER NOT NULL DEFAULT 0, category_id INTEGER NOT NULL,
        subtitle TEXT, valid_from TEXT, content TEXT, "order" INTEGER NOT NULL DEFAULT 0
      );
      PRAGMA user_version = 1;
      PRAGMA application_id = 0x4c415753;
    `);
    db.prepare('INSERT INTO category (id, name, folder, isSubFolder, "group", "order") VALUES (?, ?, ?, ?, ?, ?)').run(
      1,
      "民法商法",
      "民法商法",
      0,
      "民法商法",
      0,
    );
    // 正文超过 4000 字，用于验证 provider 按 contentMaxChars 截断（真实行为，不 mock）。
    const longContractText = [
      "第六十条 用人单位与劳动者协商一致，可以解除劳动合同。",
      "第八十七条 用人单位违反本法规定解除或者终止劳动合同的，应当依照本法第八十七条规定的二倍支付赔偿金。",
      "为了完善劳动合同制度，明确劳动合同双方当事人的权利和义务，保护劳动者的合法权益，构建和发展和谐稳定的劳动关系，制定本法。".repeat(
        80,
      ),
    ].join("\n");
    const laws = [
      {
        id: "中华人民共和国专利法_2020-10-17",
        level: "法律",
        name: "中华人民共和国专利法",
        publish: "2020-10-17",
        validFrom: "2021-06-01",
        content:
          "第六十五条 侵犯专利权的赔偿数额按照权利人因被侵权所受到的实际损失确定；实际损失难以确定的，可以按照侵权人因侵权所获得的利益确定。权利人的损失或者侵权人获得的利益难以确定的，参照该专利许可使用费的倍数合理确定。",
      },
      {
        id: "中华人民共和国劳动合同法_2012-12-28",
        level: "法律",
        name: "中华人民共和国劳动合同法",
        publish: "2012-12-28",
        validFrom: "2013-07-01",
        content: longContractText,
      },
    ];
    for (const law of laws) {
      db.prepare(
        'INSERT INTO law (id, level, name, filename, publish, expired, category_id, subtitle, valid_from, content, "order") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(law.id, law.level, law.name, null, law.publish, 0, 1, null, law.validFrom, law.content, 0);
    }
    // 不建 law_fts：引擎按「表不存在」走 LIKE，检索路径与生产降级一致且确定。
  } finally {
    db.close();
  }
}

describe("legal-memory-provider（集成，夹具法律库）", () => {
  let dir: string;
  let engine: LegalSearchEngine;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "sati-legal-memory-"));
    createLawsFixture(join(dir, "laws-full-local.db"));
    engine = new LegalSearchEngine(join(dir, "laws-full-local.db"));
  });

  after(() => {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("法律 query 注入 law-database 上下文", async () => {
    const provider = new LegalMemoryProvider(engine);
    const result = await provider.retrieve(makeInput("赔偿"));
    assert.ok(result.systemContext, "命中法条时应注入上下文");
    assert.ok(result.systemContext.includes("<law-database>"));
    assert.ok(result.systemContext.includes("中华人民共和国专利法"));
  });

  it("法条正文过长时截断", async () => {
    const provider = new LegalMemoryProvider(engine);
    const result = await provider.retrieve(makeInput("解除劳动合同"));
    assert.ok(result.systemContext);
    assert.ok(result.systemContext.length < 4000, `上下文应被截断（实际 ${result.systemContext.length}）`);
    assert.ok(result.systemContext.includes("（截断）"), "截断标记应可见");
  });

  it("captureTurn 为空操作", async () => {
    const provider = new LegalMemoryProvider(engine);
    await provider.captureTurn({ sessionId: "s1", projectRoot: "/tmp", messages: [], errored: false });
  });
});
