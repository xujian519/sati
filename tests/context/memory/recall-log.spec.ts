/**
 * 记忆召回日志（recall log）+ 引用回填 —— WS1 / T1.1–T1.5。
 *
 * 契约（对齐 docs/plans/2026-10-14-knowledge-governance-import.md）：
 *  - 每次记忆检索（注入 / 空结果 / 超时 / 取消 / 预算 deferred）都落 memory_recall_log，
 *    skip_reason 必填其一，降级不静默（AGENTS.md 铁律 11）；
 *  - turn 收尾用「注入条目 id / 标题前缀」在 assistant 输出中判定引用，保守优先：
 *    前缀碰撞则两条都不标（宁可漏标不可瞎标）；
 *  - 日志库为 Sati 自有状态库（~/.sati/state/memory-recall-log.db，env 可覆盖），
 *    与 knowledge.db（XiaoNuo 管道产物）解耦；
 *  - 日志库打开失败 → 一次性 warn 后停用（fail-open），绝不打断 agent turn。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CanonicalMessage } from "../../../src/model/index.js";
import type {
  MemoryResolver,
  MemoryRetrieveInput,
  MemoryRetrieveResult,
} from "../../../src/context/memory/MemoryResolver.js";
import { MemoryAttachmentBuilder } from "../../../src/context/memory/MemoryAttachmentBuilder.js";
import {
  RECALL_LOG_APPLICATION_ID,
  RECALL_LOG_KEEP_ROWS,
  RECALL_LOG_SCHEMA_VERSION,
  FileRecallLogSink,
  citeRecallLog,
  appendRecallLog,
  collectAssistantText,
  matchCitedHits,
  openRecallLogDb,
  type RecallLogEntry,
  type RecallLogSink,
} from "../../../src/context/memory/recall-log.js";
import { DefaultContextRuntime } from "../../../src/context/DefaultContextRuntime.js";
import type { ContextCaptureTurnInput, ContextPrepareInput } from "../../../src/context/protocol/types.js";

function userMessage(text: string): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantMessage(text: string): CanonicalMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

class RecordingSink implements RecallLogSink {
  entries: RecallLogEntry[] = [];
  citations: Array<{ sessionId: string; citedIds: string[] }> = [];

  log(entry: RecallLogEntry): void {
    this.entries.push(entry);
  }

  cite(input: { sessionId: string; citedIds: string[] }): void {
    this.citations.push(input);
  }
}

class StaticResolver implements MemoryResolver {
  constructor(private readonly result: MemoryRetrieveResult) {}
  received: MemoryRetrieveInput[] = [];

  async retrieve(input: MemoryRetrieveInput): Promise<MemoryRetrieveResult> {
    this.received.push(input);
    return this.result;
  }

  async captureTurn(): Promise<void> {}
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "sati-recall-log-"));
}

function readRows(db: DatabaseSync): Array<Record<string, unknown>> {
  return db.prepare("SELECT * FROM memory_recall_log ORDER BY id").all() as Array<Record<string, unknown>>;
}

describe("openRecallLogDb（T1.1）", () => {
  it("新路径自动建目录 + 建表 + 打 application_id / user_version 版本戳", () => {
    const dir = makeTmpDir();
    try {
      const dbPath = join(dir, "nested", "memory-recall-log.db");
      const db = openRecallLogDb(dbPath);
      try {
        assert.equal(existsSync(dbPath), true, "父目录应被递归创建");
        const appId = (db.prepare("PRAGMA application_id").get() as { application_id: number }).application_id;
        assert.equal(appId, RECALL_LOG_APPLICATION_ID);
        const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
        assert.equal(version, RECALL_LOG_SCHEMA_VERSION);
        const table = db
          .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='memory_recall_log'")
          .get() as { c: number };
        assert.equal(table.c, 1);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("来自未来版本（user_version 更高）fail-loud 拒绝打开", () => {
    const dir = makeTmpDir();
    try {
      const dbPath = join(dir, "future.db");
      const db = new DatabaseSync(dbPath);
      db.exec(`PRAGMA user_version = ${RECALL_LOG_SCHEMA_VERSION + 1}`);
      db.close();
      assert.throws(() => openRecallLogDb(dbPath), /高于当前程序支持/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("application_id 不匹配（打开了别的库）fail-loud 拒绝打开", () => {
    const dir = makeTmpDir();
    try {
      const dbPath = join(dir, "foreign.db");
      const db = new DatabaseSync(dbPath);
      db.exec("PRAGMA application_id = 42");
      db.close();
      assert.throws(() => openRecallLogDb(dbPath), /application_id/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("appendRecallLog / citeRecallLog（T1.1 / T1.4）", () => {
  it("append 落全部字段（query / hits / injected / skipReason / diagnostics）", () => {
    const dir = makeTmpDir();
    try {
      const db = openRecallLogDb(join(dir, "log.db"));
      try {
        appendRecallLog(db, {
          sessionId: "s1",
          turnId: "t1",
          query: "创造性 三步法",
          hits: [{ id: "hit-1", title: "创造性判断标准", score: 0.9, snippet: "……" }],
          injected: true,
          diagnostics: [{ code: "memory_cache_hit", severity: "info", message: "cache" }],
        });
        const rows = readRows(db);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!["session_id"], "s1");
        assert.equal(rows[0]!["turn_id"], "t1");
        assert.equal(rows[0]!["query"], "创造性 三步法");
        assert.equal(rows[0]!["injected"], 1);
        const hits = JSON.parse(rows[0]!["hit_ids_json"] as string) as Array<{ id: string }>;
        assert.deepEqual(
          hits.map(h => h.id),
          ["hit-1"],
        );
        const diags = JSON.parse(rows[0]!["diagnostics_json"] as string) as Array<{ code: string }>;
        assert.equal(diags[0]!.code, "memory_cache_hit");
        assert.equal(rows[0]!["cited_ids_json"], null, "新行引用应为 NULL（未判定）");
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cite 只回填同会话且命中交集的行；未命中行与其他会话行保持 NULL", () => {
    const dir = makeTmpDir();
    try {
      const db = openRecallLogDb(join(dir, "log.db"));
      try {
        appendRecallLog(db, {
          sessionId: "s1",
          turnId: "t1",
          query: "q",
          hits: [{ id: "hit-a" }, { id: "hit-b" }],
          injected: true,
        });
        appendRecallLog(db, {
          sessionId: "s1",
          turnId: "t2",
          query: "q2",
          hits: [{ id: "hit-c" }],
          injected: true,
        });
        appendRecallLog(db, { sessionId: "s2", turnId: "t9", query: "q", hits: [{ id: "hit-a" }], injected: true });

        citeRecallLog(db, { sessionId: "s1", citedIds: ["hit-a", "missing"] });

        const rows = readRows(db);
        assert.deepEqual(JSON.parse(rows[0]!["cited_ids_json"] as string), ["hit-a"], "交集回填且剔除未注入的 id");
        assert.equal(rows[1]!["cited_ids_json"], null, "无交集的行不被误标");
        assert.equal(rows[2]!["cited_ids_json"], null, "其他会话的行不被误标");
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("滚动清理只保留最近 RECALL_LOG_KEEP_ROWS 行", () => {
    const dir = makeTmpDir();
    try {
      const db = openRecallLogDb(join(dir, "log.db"));
      try {
        for (let i = 0; i < RECALL_LOG_KEEP_ROWS + 5; i += 1) {
          appendRecallLog(db, {
            sessionId: "s1",
            turnId: `t${i}`,
            query: `q${i}`,
            injected: false,
            skipReason: "empty_context",
          });
        }
        const count = (db.prepare("SELECT COUNT(*) AS c FROM memory_recall_log").get() as { c: number }).c;
        assert.equal(count, RECALL_LOG_KEEP_ROWS, "超出行数应被滚动清理");
        const oldest = readRows(db)[0] as { turn_id: string };
        assert.equal(oldest.turn_id, "t5", "应清掉最老的 5 行");
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("FileRecallLogSink（T1.1 失败路径）", () => {
  it("正常路径 log + cite 落库", () => {
    const dir = makeTmpDir();
    try {
      const sink = new FileRecallLogSink(join(dir, "log.db"));
      sink.log({ sessionId: "s1", turnId: "t1", query: "q", hits: [{ id: "hit-a" }], injected: true });
      sink.cite({ sessionId: "s1", citedIds: ["hit-a"] });
      const db = openRecallLogDb(join(dir, "log.db"));
      try {
        const rows = readRows(db);
        assert.equal(rows.length, 1);
        assert.deepEqual(JSON.parse(rows[0]!["cited_ids_json"] as string), ["hit-a"]);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("打开失败（父路径是文件）→ 一次性降级、后续调用 no-op 不抛错（fail-open，可观测）", () => {
    const dir = makeTmpDir();
    try {
      const blocker = join(dir, "blocker");
      writeFileSync(blocker, "not a dir");
      const sink = new FileRecallLogSink(join(blocker, "log.db"));
      assert.doesNotThrow(() => sink.log({ sessionId: "s1", query: "q", injected: false, skipReason: "deferred" }));
      assert.doesNotThrow(() => sink.cite({ sessionId: "s1", citedIds: ["x"] }), "cite 同样不得抛错");
      sink.log({ sessionId: "s1", query: "q2", injected: false, skipReason: "deferred" });
      assert.equal(existsSync(join(blocker, "log.db")), false, "停用后不应再尝试创建库文件");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("matchCitedHits / collectAssistantText（T1.4 保守引用判定）", () => {
  it("assistant 文本出现注入条目 id → 判为引用", () => {
    const cited = matchCitedHits("根据知识库条目 abcdef123456 的结论……", [{ id: "abcdef123456" }]);
    assert.deepEqual(cited, ["abcdef123456"]);
  });

  it("id 过短（<6 字符）不参与匹配，防噪声误判", () => {
    assert.deepEqual(matchCitedHits("提到 ab1", [{ id: "ab1" }]), []);
  });

  it("标题前缀 ≥12 字符命中判为引用", () => {
    const title = "创造性判断的三步法适用要件详解";
    const cited = matchCitedHits(`参考《${title}》可知……`, [{ id: "hit-x", title }]);
    assert.deepEqual(cited, ["hit-x"]);
  });

  it("两条命中共享同一 12 字前缀（碰撞）→ 都不标，宁可漏标不可瞎标", () => {
    const shared = "创造性判断的三步法适用要";
    const cited = matchCitedHits(`参考 ${shared}件详解`, [
      { id: "hit-1", title: `${shared}件详解` },
      { id: "hit-2", title: `${shared}件注意` },
    ]);
    assert.deepEqual(cited, [], "碰撞前缀不得引用");
  });

  it("collectAssistantText 只收集 assistant 文本块", () => {
    const text = collectAssistantText([
      userMessage("问题"),
      assistantMessage("回答一"),
      { role: "assistant", content: [{ type: "text", text: "回答二" }] },
      userMessage("工具结果"),
    ]);
    assert.equal(text.includes("回答一"), true);
    assert.equal(text.includes("回答二"), true);
    assert.equal(text.includes("工具结果"), false);
  });
});

describe("MemoryAttachmentBuilder 召回日志接线（T1.3 三路径）", () => {
  it("注入路径：sink 收到 injected=true + hits + turnId", async () => {
    const sink = new RecordingSink();
    const resolver = new StaticResolver({
      systemContext: "<knowledge>…</knowledge>",
      diagnostics: [],
      hits: [{ id: "hit-1", title: "创造性判断标准", score: 0.9 }],
    });
    const builder = new MemoryAttachmentBuilder(resolver, { recallLog: sink });
    await builder.build({ query: "创造性", sessionId: "s1", projectRoot: "/tmp", recentMessages: [], turnId: "t1" });

    assert.equal(sink.entries.length, 1);
    assert.equal(sink.entries[0]!.injected, true);
    assert.equal(sink.entries[0]!.turnId, "t1");
    assert.deepEqual(
      sink.entries[0]!.hits?.map(h => h.id),
      ["hit-1"],
    );
    assert.equal(sink.entries[0]!.skipReason, undefined);
  });

  it("空结果路径：skipReason=empty_context，injected=false", async () => {
    const sink = new RecordingSink();
    const builder = new MemoryAttachmentBuilder(new StaticResolver({ diagnostics: [] }), { recallLog: sink });
    await builder.build({ query: "q", sessionId: "s1", projectRoot: "/tmp", recentMessages: [] });
    assert.equal(sink.entries.length, 1);
    assert.equal(sink.entries[0]!.injected, false);
    assert.equal(sink.entries[0]!.skipReason, "empty_context");
  });

  it("超时路径：skipReason=timeout 且带诊断（fake timers + 永不结算 resolver）", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const sink = new RecordingSink();
    const hanging: MemoryResolver = {
      async retrieve(): Promise<MemoryRetrieveResult> {
        return await new Promise<MemoryRetrieveResult>(() => {});
      },
      async captureTurn(): Promise<void> {},
    };
    const builder = new MemoryAttachmentBuilder(hanging, { recallLog: sink });
    const pending = builder.build({
      query: "q",
      sessionId: "s1",
      projectRoot: "/tmp",
      recentMessages: [],
      timeoutMs: 30_000,
    });
    t.mock.timers.tick(30_000);
    await pending;
    assert.equal(sink.entries.length, 1);
    assert.equal(sink.entries[0]!.skipReason, "timeout");
    assert.equal(sink.entries[0]!.diagnostics?.[0]?.code, "memory_provider_error");
  });

  it("回合级 abort 路径：skipReason=aborted", async () => {
    const sink = new RecordingSink();
    const controller = new AbortController();
    controller.abort();
    const builder = new MemoryAttachmentBuilder(new StaticResolver({ diagnostics: [] }), { recallLog: sink });
    await builder.build({
      query: "q",
      sessionId: "s1",
      projectRoot: "/tmp",
      recentMessages: [],
      signal: controller.signal,
    });
    assert.equal(sink.entries.length, 1);
    assert.equal(sink.entries[0]!.skipReason, "aborted");
  });

  it("sink 自身抛错不打断 build（可观测不得反噬主流程）", async () => {
    const throwingSink: RecallLogSink = {
      log(): void {
        throw new Error("sink broken");
      },
      cite(): void {},
    };
    const builder = new MemoryAttachmentBuilder(new StaticResolver({ diagnostics: [] }), { recallLog: throwingSink });
    const result = await builder.build({ query: "q", sessionId: "s1", projectRoot: "/tmp", recentMessages: [] });
    assert.equal(result.attachments.length, 0, "build 应正常完成");
  });
});

describe("DefaultContextRuntime 接线（T1.3 deferred / T1.4 引用回填）", () => {
  function makePrepareInput(messages: CanonicalMessage[]): ContextPrepareInput {
    return {
      sessionId: "s1",
      turnId: "t1",
      cwd: process.cwd(),
      provider: "anthropic",
      model: "claude-x",
      permissionMode: "default",
      additionalWorkingDirectories: [],
      messages,
      tools: [],
    };
  }

  function makeCaptureInput(messages: CanonicalMessage[]): ContextCaptureTurnInput {
    return { sessionId: "s1", turnId: "t1", messages, errored: false };
  }

  it("注入后 turn 收尾：assistant 文本命中注入条目 id → sink.cite 回填", async () => {
    const sink = new RecordingSink();
    const resolver = new StaticResolver({
      systemContext: "<knowledge>…</knowledge>",
      diagnostics: [],
      hits: [{ id: "abcdef123456", title: "创造性判断的三步法适用要件详解" }],
    });
    const runtime = new DefaultContextRuntime({ memoryResolver: resolver, recallLog: sink });

    await runtime.prepareForModel(makePrepareInput([userMessage("创造性的判断标准是什么")]));
    assert.equal(sink.entries.length, 1);
    assert.equal(sink.entries[0]!.injected, true);

    await runtime.captureTurn(makeCaptureInput([assistantMessage("根据知识库条目 abcdef123456，创造性判断应……")]));
    assert.equal(sink.citations.length, 1, "收尾应触发引用回填");
    assert.deepEqual(sink.citations[0]!.citedIds, ["abcdef123456"]);
  });

  it("assistant 未引用注入条目 → 不触发 cite（漏标不瞎标）", async () => {
    const sink = new RecordingSink();
    const resolver = new StaticResolver({
      systemContext: "<knowledge>…</knowledge>",
      diagnostics: [],
      hits: [{ id: "abcdef123456" }],
    });
    const runtime = new DefaultContextRuntime({ memoryResolver: resolver, recallLog: sink });

    await runtime.prepareForModel(makePrepareInput([userMessage("问题")]));
    await runtime.captureTurn(makeCaptureInput([assistantMessage("与知识库无关的回答")]));
    assert.equal(sink.citations.length, 0);
  });

  it("超预算 deferred：runtime 落 skipReason=deferred 日志（builder 不重复记）", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const sink = new RecordingSink();
    const hanging: MemoryResolver = {
      async retrieve(): Promise<MemoryRetrieveResult> {
        return await new Promise<MemoryRetrieveResult>(() => {});
      },
      async captureTurn(): Promise<void> {},
    };
    const runtime = new DefaultContextRuntime({
      memoryResolver: hanging,
      recallLog: sink,
      memoryInjectionBudgetMs: 2000,
    });

    const pending = runtime.prepareForModel(makePrepareInput([userMessage("这个结构的强度和重量存在矛盾")]));
    t.mock.timers.tick(2000);
    await pending;

    const deferredEntries = sink.entries.filter(e => e.skipReason === "deferred");
    assert.equal(deferredEntries.length, 1, "deferred 应有且仅有一条日志");
    assert.equal(deferredEntries[0]!.injected, false);
    assert.equal(deferredEntries[0]!.sessionId, "s1");
    assert.equal(
      sink.entries.filter(e => e.skipReason === "timeout").length,
      0,
      "deferred 场景 builder 尚未超时，不得重复记 timeout",
    );
  });
});
