import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { KnowledgeDbVersionError, openKnowledgeDb } from "../../src/knowledge/shared/db-version.js";
import { KNOWLEDGE_DB, LAWS_DB, VECTORS_DB } from "../../src/knowledge/shared/schema-versions.js";

/**
 * 知识库版本管理（真源 fail-loud、派生索引可重建）测试。
 *
 * 覆盖 openKnowledgeDb 的版本语义：
 * - 存量库（user_version=0）宽容：写路径补打戳，读路径放行；
 * - 版本匹配正常打开；
 * - 真源版本过旧抛错（拒绝打开）；
 * - 派生版本过旧返回 needsRebuild；
 * - 版本超前一律抛错；
 * - application_id 不匹配抛错（防误开他库）。
 */

function makeDbPath(dir: string, name = "test.db"): string {
  return join(dir, name);
}

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function setVersion(dbPath: string, version: number, applicationId = 0): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA user_version = ${version}`);
  if (applicationId !== 0) db.exec(`PRAGMA application_id = ${applicationId}`);
  db.close();
}

function readVersion(dbPath: string): { version: number; applicationId: number } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const ver = db.prepare("PRAGMA user_version").get() as { user_version: number };
    const app = db.prepare("PRAGMA application_id").get() as { application_id: number };
    return { version: ver.user_version, applicationId: app.application_id };
  } finally {
    db.close();
  }
}

test("新建真源库（写路径）自动打版本戳与 application_id", () => {
  const dir = makeTempDir("dbv-new-");
  try {
    const dbPath = makeDbPath(dir);
    const opened = openKnowledgeDb(dbPath, KNOWLEDGE_DB);
    assert.equal(opened.needsRebuild, false);
    assert.equal(opened.version, 0);
    opened.db.close();

    const stamp = readVersion(dbPath);
    assert.equal(stamp.version, KNOWLEDGE_DB.version);
    assert.equal(stamp.applicationId, KNOWLEDGE_DB.applicationId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("版本匹配时正常打开（source 与 derived 一致）", () => {
  const dir = makeTempDir("dbv-match-");
  try {
    const dbPath = makeDbPath(dir);
    new DatabaseSync(dbPath).close();
    setVersion(dbPath, KNOWLEDGE_DB.version, KNOWLEDGE_DB.applicationId);

    const source = openKnowledgeDb(dbPath, KNOWLEDGE_DB);
    assert.equal(source.needsRebuild, false);
    assert.equal(source.version, KNOWLEDGE_DB.version);
    source.db.close();

    const derived = openKnowledgeDb(dbPath, { ...KNOWLEDGE_DB, kind: "derived" });
    assert.equal(derived.needsRebuild, false);
    derived.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("存量库（user_version=0）读路径宽容放行、写路径补打戳", () => {
  const dir = makeTempDir("dbv-legacy-");
  try {
    const dbPath = makeDbPath(dir);
    new DatabaseSync(dbPath).close(); // 无版本戳的存量库

    const readOnly = openKnowledgeDb(dbPath, KNOWLEDGE_DB, { readOnly: true });
    assert.equal(readOnly.needsRebuild, false);
    readOnly.db.close();
    // 读路径不得改动库。
    assert.equal(readVersion(dbPath).version, 0);

    const writable = openKnowledgeDb(dbPath, KNOWLEDGE_DB);
    writable.db.close();
    assert.equal(readVersion(dbPath).version, KNOWLEDGE_DB.version);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("真源版本过旧抛 KnowledgeDbVersionError 且库未被改动", () => {
  const dir = makeTempDir("dbv-source-old-");
  try {
    const dbPath = makeDbPath(dir);
    new DatabaseSync(dbPath).close();
    // 过旧 = 0 < current < expected。用自定义版本号避免与存量库（0）语义重叠。
    const expected = 3;
    const current = 1;
    setVersion(dbPath, current, KNOWLEDGE_DB.applicationId);

    assert.throws(
      () =>
        openKnowledgeDb(dbPath, {
          version: expected,
          kind: "source",
          applicationId: KNOWLEDGE_DB.applicationId,
        }),
      (error: unknown) => error instanceof KnowledgeDbVersionError && /版本过旧/.test(error.message),
    );
    // fail-loud：库未被写入/打戳。
    assert.equal(readVersion(dbPath).version, current);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("派生版本过旧返回 needsRebuild 且不抛错", () => {
  const dir = makeTempDir("dbv-derived-old-");
  try {
    const dbPath = makeDbPath(dir);
    new DatabaseSync(dbPath).close();
    const expected = 3;
    const current = 1;
    setVersion(dbPath, current, VECTORS_DB.applicationId);

    const opened = openKnowledgeDb(dbPath, {
      version: expected,
      kind: "derived",
      applicationId: VECTORS_DB.applicationId,
    });
    assert.equal(opened.needsRebuild, true);
    if (opened.needsRebuild) {
      assert.equal(opened.version, current);
      opened.db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("treatZeroAsStale：派生库 version=0 读路径视为需重建（构建中断不静默）", () => {
  const dir = makeTempDir("dbv-zero-stale-");
  try {
    const dbPath = makeDbPath(dir);
    new DatabaseSync(dbPath).close(); // 无版本戳（version=0）

    // 默认（存量宽容）：读路径放行。
    const lenient = openKnowledgeDb(
      dbPath,
      { version: 1, kind: "derived", applicationId: VECTORS_DB.applicationId },
      { readOnly: true },
    );
    assert.equal(lenient.needsRebuild, false);
    lenient.db.close();

    // treatZeroAsStale：读路径提示重建。
    const strict = openKnowledgeDb(
      dbPath,
      { version: 1, kind: "derived", applicationId: VECTORS_DB.applicationId },
      { readOnly: true, treatZeroAsStale: true },
    );
    assert.equal(strict.needsRebuild, true);
    if (strict.needsRebuild) {
      strict.db.close();
    }

    // 真源库不受该选项影响（仍是存量宽容）。
    const sourcePath = makeDbPath(dir, "source.db");
    new DatabaseSync(sourcePath).close();
    const sourceOpened = openKnowledgeDb(
      sourcePath,
      { version: 1, kind: "source", applicationId: KNOWLEDGE_DB.applicationId },
      { readOnly: true, treatZeroAsStale: true },
    );
    assert.equal(sourceOpened.needsRebuild, false, "treatZeroAsStale 仅作用于派生库");
    sourceOpened.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("版本超前（未来版本）一律抛错（source 与 derived）", () => {
  const dir = makeTempDir("dbv-future-");
  try {
    for (const kind of ["source", "derived"] as const) {
      const dbPath = makeDbPath(dir, `${kind}.db`);
      new DatabaseSync(dbPath).close();
      setVersion(dbPath, KNOWLEDGE_DB.version + 1, KNOWLEDGE_DB.applicationId);
      assert.throws(
        () =>
          openKnowledgeDb(dbPath, {
            version: KNOWLEDGE_DB.version,
            kind,
            applicationId: KNOWLEDGE_DB.applicationId,
          }),
        (error: unknown) => error instanceof KnowledgeDbVersionError && /高于当前程序支持/.test(error.message),
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("application_id 不匹配抛错（防误开他库）", () => {
  const dir = makeTempDir("dbv-appid-");
  try {
    const dbPath = makeDbPath(dir);
    new DatabaseSync(dbPath).close();
    setVersion(dbPath, KNOWLEDGE_DB.version, LAWS_DB.applicationId); // 用错库的魔数

    assert.throws(
      () =>
        openKnowledgeDb(dbPath, {
          version: KNOWLEDGE_DB.version,
          kind: "source",
          applicationId: KNOWLEDGE_DB.applicationId,
        }),
      (error: unknown) => error instanceof KnowledgeDbVersionError && /application_id/.test(error.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("三个库 application_id 魔数互不相同", () => {
  const ids = new Set([KNOWLEDGE_DB.applicationId, LAWS_DB.applicationId, VECTORS_DB.applicationId]);
  assert.equal(ids.size, 3);
  for (const id of ids) {
    assert.ok(id > 0 && Number.isInteger(id));
  }
});
