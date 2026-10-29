import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { createLawSearchTool, resolveLawSearchBackend } from "../../../src/knowledge/legal/law-search-tool.js";
import { LegalSnapshotEngine } from "../../../src/knowledge/legal/offline-snapshot/index.js";
import type { LawVersionMeta } from "../../../src/knowledge/legal/version-meta.js";
import { makeToolContext } from "../../tool/context-fixture.js";

/**
 * 法条离线兜底（批次 B）：
 * 在线索引优先，离线快照仅兜底；三条降级路径（db 缺失 / db schema 不匹配 /
 * 快照缺失）必须**可见**（source=offline + degradedReason 或 error reasons），
 * 不得静默。
 */

type SnapshotLawFixture = { n: string; d: string; a: Array<[number, string]> };

function writeSnapshot(dir: string, laws: SnapshotLawFixture[], manifestOverrides: Record<string, unknown> = {}): void {
  mkdirSync(dir, { recursive: true });
  const jsonl = laws.map(law => JSON.stringify(law)).join("\n") + "\n";
  const gz = gzipSync(Buffer.from(jsonl, "utf8"));
  writeFileSync(join(dir, "legal-articles.jsonl.gz"), gz);
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        snapshotAt: "2026-01-01",
        source: "test-fixture",
        license: "MIT",
        format: "gzip-jsonl",
        file: "legal-articles.jsonl.gz",
        lawCount: laws.length,
        articleCount: laws.reduce((sum, law) => sum + law.a.length, 0),
        byteSize: gz.byteLength,
        sha256: "test",
        ...manifestOverrides,
      },
      null,
      2,
    ),
  );
}

const TEST_LAWS: SnapshotLawFixture[] = [
  {
    n: "专利法",
    d: "中华人民共和国专利法",
    a: [
      [1, "为了保护专利权人的合法权益，鼓励发明创造，制定本法。"],
      [22, "授予专利权的发明和实用新型，应当具备新颖性、创造性和实用性。"],
    ],
  },
  {
    n: "劳动合同法",
    d: "中华人民共和国劳动合同法",
    a: [[1, "为了完善劳动合同制度，明确劳动合同双方当事人的权利和义务，制定本法。"]],
  },
];

/** 一个既不含 knowledge.db 也不含 laws-full.db 的临时数据目录。 */
function emptyEnv(dataDir: string): NodeJS.ProcessEnv {
  return { SATI_KNOWLEDGE_DIR: dataDir };
}

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "sati-legal-offline-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function emptyMeta(): Map<string, LawVersionMeta> {
  return new Map();
}

test("offline snapshot: 快照可检索，时点口径如实标注 unsupported", () => {
  withTempDir(dataDir => {
    const snapshotDir = join(dataDir, "snapshot");
    writeSnapshot(snapshotDir, TEST_LAWS);
    const engine = new LegalSnapshotEngine(snapshotDir);
    assert.equal(engine.count(), 2);
    assert.equal(engine.ftsAvailable, false, "快照无 FTS，不得声称可用");
    assert.equal(engine.timeFilter, "unsupported");

    const hits = engine.search("创造性", { limit: 5 });
    assert.ok(hits.length >= 1);
    assert.equal(hits[0]!.name, "中华人民共和国专利法");
    assert.equal(hits[0]!.article, "第22条");
    assert.match(hits[0]!.content ?? "", /新颖性/);

    const timed = engine.searchAt("创造性", { asOf: "2020-10-17" });
    assert.equal(timed.meta.timeFilter, "unsupported", "快照无日期字段，不得伪造近似口径");
    assert.equal(timed.meta.unknownDateCount, timed.results.length);
    assert.ok(timed.results.length >= 1, "unsupported 不等于不返回结果");
    engine.close();
  });
});

test("降级路径 1/3：db 缺失 → 使用离线快照，且来源与原因可见", async () => {
  await withTempDirAsync(async dataDir => {
    const snapshotDir = join(dataDir, "snapshot");
    writeSnapshot(snapshotDir, TEST_LAWS);
    const resolution = resolveLawSearchBackend({ env: emptyEnv(dataDir), snapshotDir });
    assert.notEqual(resolution.engine, null);
    if (resolution.engine === null) throw new Error("unreachable");
    assert.equal(resolution.source, "offline");
    assert.equal(resolution.snapshotAt, "2026-01-01");
    assert.match(resolution.degradedReason ?? "", /knowledge\.db 不存在/);
    assert.match(resolution.degradedReason ?? "", /laws-full\.db 不存在/);
    resolution.engine.close();
  });
});

test("降级路径 1/3（执行面）：工具输出 source=offline、snapshotAt、逐条来源标记", async () => {
  await withTempDirAsync(async dataDir => {
    const snapshotDir = join(dataDir, "snapshot");
    writeSnapshot(snapshotDir, TEST_LAWS);
    const tool = createLawSearchTool(() => resolveLawSearchBackend({ env: emptyEnv(dataDir), snapshotDir }), emptyMeta);
    const output = await tool.execute({ query: "专利法", level: "法律", asOf: "2020-10-17" }, makeToolContext());
    assert.ok(output.data);
    assert.equal(output.data.source, "offline");
    assert.equal(output.data.snapshotAt, "2026-01-01");
    assert.ok(output.data.results.length >= 1);
    for (const row of output.data.results) {
      assert.equal(row.source, "offline", "逐条结果必须带来源标记");
      assert.equal(row.snapshotAt, "2026-01-01");
    }
    assert.deepEqual(output.data.unsupportedFilters, ["level"], "level 过滤被快照忽略且可见");
    assert.equal(output.data.timeFilter, "unsupported");
    assert.equal(output.metadata?.source, "offline");
  });
});

test("降级路径 2/3：knowledge.db schema 不匹配 → 回退离线，并回报版本原因", async () => {
  withTempDir(dataDir => {
    // user_version=99（高于程序支持的 1）→ openKnowledgeDb fail-loud。
    const knowledgeDb = join(dataDir, "knowledge.db");
    const db = new DatabaseSync(knowledgeDb);
    db.exec("PRAGMA user_version = 99");
    db.close();

    const snapshotDir = join(dataDir, "snapshot");
    writeSnapshot(snapshotDir, TEST_LAWS);
    const resolution = resolveLawSearchBackend({ env: emptyEnv(dataDir), snapshotDir });
    assert.notEqual(resolution.engine, null);
    if (resolution.engine === null) throw new Error("unreachable");
    assert.equal(resolution.source, "offline", "schema 不符不得被当作在线库使用");
    assert.match(resolution.degradedReason ?? "", /knowledge\.db 不可用/);
    assert.match(resolution.degradedReason ?? "", /版本高于当前程序支持/);
    resolution.engine.close();
  });
});

test("降级路径 3/3：离线快照缺失 → 无后端，且错误列出每条候选失败原因", async () => {
  await withTempDirAsync(async dataDir => {
    const resolution = resolveLawSearchBackend({
      env: emptyEnv(dataDir),
      snapshotDir: join(dataDir, "no-snapshot"),
    });
    assert.equal(resolution.engine, null);
    if (resolution.engine !== null) throw new Error("unreachable");
    assert.ok(resolution.reasons.some(reason => reason.includes("knowledge.db 不存在")));
    assert.ok(resolution.reasons.some(reason => reason.includes("laws-full.db 不存在")));
    assert.ok(resolution.reasons.some(reason => reason.includes("离线法条快照")));

    const tool = createLawSearchTool(
      () => resolveLawSearchBackend({ env: emptyEnv(dataDir), snapshotDir: join(dataDir, "no-snapshot") }),
      emptyMeta,
    );
    const output = await tool.execute({ query: "专利法" }, makeToolContext());
    assert.equal(output.metadata?.error, "law_db_not_found");
    const text = output.content?.[0];
    assert.equal(text?.type, "text");
    if (text?.type === "text") assert.match(text.text, /离线法条快照/, "错误文本必须说明兜底也缺失");
  });
});

test("在线优先：knowledge.db 可用时不加载离线快照", () => {
  withTempDir(dataDir => {
    const knowledgeDb = join(dataDir, "knowledge.db");
    const db = new DatabaseSync(knowledgeDb);
    db.exec(`
      CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT, level TEXT, source TEXT, publish_date TEXT, doc_type TEXT, char_count INTEGER);
      CREATE TABLE chunks (id INTEGER PRIMARY KEY, document_id TEXT, chunk_index INTEGER, content TEXT, heading TEXT, char_count INTEGER);
      INSERT INTO documents (id, title, level, source, publish_date, doc_type, char_count)
        VALUES ('law-1', '中华人民共和国专利法', '法律', 'x', '2020-10-17', 'law_article', 10);
    `);
    db.close();

    const snapshotDir = join(dataDir, "snapshot");
    writeSnapshot(snapshotDir, TEST_LAWS);
    const resolution = resolveLawSearchBackend({ env: emptyEnv(dataDir), snapshotDir });
    assert.notEqual(resolution.engine, null);
    if (resolution.engine === null) throw new Error("unreachable");
    assert.equal(resolution.source, "online");
    assert.equal(resolution.dbPath, knowledgeDb);
    assert.equal(resolution.snapshotAt, undefined, "在线命中时不得混入快照时点");
    resolution.engine.close();
  });
});

test("离线快照 schemaVersion 不匹配 → 拒绝加载（不静默兼容）", () => {
  withTempDir(dataDir => {
    const snapshotDir = join(dataDir, "snapshot");
    writeSnapshot(snapshotDir, TEST_LAWS, { schemaVersion: 2 });
    assert.throws(() => new LegalSnapshotEngine(snapshotDir), /schemaVersion=2/);
  });
});

/** 异步临时目录（execute 为 async，仍需在断言后清理）。 */
async function withTempDirAsync(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "sati-legal-offline-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
