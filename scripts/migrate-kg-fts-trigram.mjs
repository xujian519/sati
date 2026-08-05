#!/usr/bin/env node
/**
 * 为 patent_kg.db 的 nodes 表构建 trigram tokenizer 的 FTS5 索引。
 *
 * 背景（H1 根治）：nodes_fts 现有 unicode61 tokenizer 下，连续汉字构成单个
 * token，中文短词（2 字）/长句命中率低，导致 kg 检索频繁降级 LIKE 全表扫描
 * （116K 行 × 多词）。trigram tokenizer（SQLite ≥3.34）对 CJK 做 3-gram 切分，
 * 2-3 字中文词可直接命中，显著降低降级频率。
 *
 * 用法：
 *   node scripts/migrate-kg-fts-trigram.mjs <patent_kg.db 路径> [--replace]
 *
 * 行为：
 *   - 默认只创建 nodes_fts_trigram（trigram）并回填数据，不改动现有
 *     nodes_fts（unicode61），保证可回滚；
 *   - 传 --replace 时：先备份旧表（nodes_fts_unicode61_backup）再原子替换，
 *     kg-store 的 FTS 探测会自动优先使用 trigram 表；
 *   - 运行时 SQLite 未编译 FTS5 或版本 <3.34（如桌面端捆绑旧 Node v22.14）
 *     时明确报错退出，不破坏库。
 *
 * 注意：本脚本仅重建 FTS 索引，不动 nodes/edges 数据；数据量 116K 行约需
 * 数秒至数十秒（一次性离线操作）。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

function fail(message) {
  console.error(`[kg-fts-trigram] 错误: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const replace = args.includes("--replace");
const dbPath = args.find(a => !a.startsWith("--"));
if (!dbPath) {
  fail("用法: node scripts/migrate-kg-fts-trigram.mjs <patent_kg.db 路径> [--replace]");
}
if (!existsSync(resolve(dbPath))) {
  fail(`数据库不存在: ${dbPath}`);
}

const db = new DatabaseSync(resolve(dbPath), { readOnly: false });

try {
  // 1. 能力探测：FTS5 + trigram（SQLite ≥3.34）。
  const fts5 = db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS v").get().v === 1;
  if (!fts5) {
    fail(
      "当前运行时的 SQLite 未编译 FTS5（旧版 Node 的 node:sqlite 可能如此），无法重建 trigram 索引。请使用支持 FTS5 的 Node ≥22.14 环境执行。",
    );
  }
  const version = db.prepare("SELECT sqlite_version() AS v").get().v;
  const [major, minor] = String(version).split(".").map(Number);
  if (major < 3 || (major === 3 && minor < 34)) {
    fail(`trigram tokenizer 需要 SQLite ≥3.34，当前 ${version}`);
  }
  // 探测 trigram tokenizer 可用性（老版本 FTS5 可能未编译 trigram）。
  try {
    db.exec("CREATE VIRTUAL TABLE _kg_fts_probe USING fts5(x, tokenize='trigram')");
    db.exec("DROP TABLE _kg_fts_probe");
  } catch (error) {
    fail(`trigram tokenizer 不可用: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 2. 建 trigram 表（如已存在则跳过）。
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts_trigram
    USING fts5(id UNINDEXED, name, title, content, tokenize='trigram');
  `);

  // 3. 清空并回填（幂等重建）。
  db.exec("DELETE FROM nodes_fts_trigram;");
  const insert = db.prepare(
    "INSERT INTO nodes_fts_trigram (id, name, title, content) SELECT id, name, title, content FROM nodes",
  );
  insert.run();

  const count = db.prepare("SELECT COUNT(*) AS c FROM nodes_fts_trigram").get().c;
  const total = db.prepare("SELECT COUNT(*) AS c FROM nodes").get().c;
  console.log(`[kg-fts-trigram] 完成: ${count}/${total} 节点已索引到 nodes_fts_trigram（trigram）`);

  // 4. --replace：备份旧表并原子替换（kg-store 探测 nodes_fts_trigram 优先，
  //    替换后检索自动走 trigram，无需改代码/重启）。
  if (replace) {
    const hasLegacy =
      db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='nodes_fts'").get().c > 0;
    if (hasLegacy) {
      db.exec(`
        DROP TABLE IF EXISTS nodes_fts_unicode61_backup;
        ALTER TABLE nodes_fts RENAME TO nodes_fts_unicode61_backup;
      `);
      console.log("[kg-fts-trigram] 旧 nodes_fts 已备份为 nodes_fts_unicode61_backup（可回滚）");
    }
    db.exec("ALTER TABLE nodes_fts_trigram RENAME TO nodes_fts;");
    console.log("[kg-fts-trigram] nodes_fts_trigram 已替换为 nodes_fts，检索将使用 trigram tokenizer");
  } else {
    console.log(
      "[kg-fts-trigram] 未替换（未传 --replace）。kg-store 会自动优先使用 nodes_fts_trigram；" +
        "确认无误后可再执行一次加 --replace 完成切换。",
    );
  }
} finally {
  db.close();
}
