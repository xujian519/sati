/**
 * TASK-P0-01 安全测试：patent_search.sh SQL 注入防护。
 *
 * 两层验证：
 * 1. 静态断言——脚本源码中不再存在用户输入直接字符串插值拼 SQL 的模式，
 *    且所有 8 类参数在 SQL 内以 psql 预定义变量（:'var' / :var）引用；
 * 2. 动态 mock——用假 psql（记录全部参数的 stub）替换脚本硬编码的 PSQL 路径，
 *    注入恶意载荷执行，断言载荷以 `-v var=载荷` 形式传给 psql，
 *    而非内联进 `-c` 的 SQL 文本。
 *
 * 测试通过环境变量覆盖 HOME 指向临时目录（脚本首行 source ~/.infra/infra.env，
 * 测试环境无该文件时由临时目录提供空文件，避免 set -e 提前终止）。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/** Windows 无 /bin/bash；动态 mock 用例依赖 bash 解释器，不可用时跳过。 */
const BASH_AVAILABLE = (() => {
  try {
    execFileSync("/bin/bash", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// 候选根：源码态（tests/patent/scripts/ 上溯 3 级）与 dist 态（上溯 4 级），
// 与 tests/patent/tool/patentPdfDownload-extractjs.spec.ts 同款探测（skills/ 不入 dist）
const here = dirname(fileURLToPath(import.meta.url));
const ROOTS = [join(here, "..", "..", ".."), join(here, "..", "..", "..", "..")];
const SCRIPT_PATH = ROOTS.map(root => join(root, "skills/patent-search/scripts/patent_search.sh")).find(existsSync);
if (SCRIPT_PATH === undefined) throw new Error("找不到 patent_search.sh（源码态与 dist 态候选根均不存在）");
const SCRIPT_SOURCE = readFileSync(SCRIPT_PATH, "utf8");

/** 在临时目录搭好假 psql + 假 infra.env，返回假 psql 的参数与 stdin 记录文件路径。 */
function setupMockRun(payloadArgs: string[]): { logFile: string; stdinLog: string } {
  const home = mkdtempSync(join(tmpdir(), "patent-search-test-home-"));
  const mockDir = mkdtempSync(join(tmpdir(), "patent-search-mock-"));
  const logFile = join(mockDir, "psql-args.log");
  const stdinLog = join(mockDir, "psql-stdin.log");
  const mockPsql = join(mockDir, "mock-psql");

  mkdirSync(join(home, ".infra"), { recursive: true });
  writeFileSync(join(home, ".infra", "infra.env"), "# test: no infra vars\n");

  // 假 psql：argv 以 NUL 分隔写入 log（参数含多行 SQL，换行分隔会拆散）；
  // stdin 原样落盘——P3-05 起 SQL 经 stdin 管道送入（psql -c 不做 :'var' 插值）
  writeFileSync(mockPsql, `#!/bin/bash\nprintf '%s\\0' "$@" > "${logFile}"\ncat > "${stdinLog}"\nexit 0\n`);
  chmodSync(mockPsql, 0o755);

  // 复制脚本并把硬编码 PSQL 路径替换为假 psql
  const copy = join(mockDir, "patent_search.sh");
  const patched = SCRIPT_SOURCE.replace('PSQL="/Library/PostgreSQL/17/bin/psql"', `PSQL="${mockPsql}"`);
  writeFileSync(copy, patched);
  chmodSync(copy, 0o755);

  // 用假 HOME 执行一次，确认替换生效（同时预热）
  execFileSync("/bin/bash", [copy, ...payloadArgs], { env: { ...process.env, HOME: home } });
  return { logFile, stdinLog };
}

/** 读取假 psql 记录（NUL 分隔），还原 argv。 */
function readMockArgs(logFile: string): string[] {
  return readFileSync(logFile).toString().split("\0").filter(Boolean);
}

test("静态断言：源码不存在用户输入直接插值拼 SQL 的模式", () => {
  // 8 类参数旧插值形式均不应残留
  const forbidden = [
    "LIKE '%${KEYWORD}%'",
    "LIKE '%${APPLICANT}%'",
    "LIKE '%${INVENTOR}%'",
    "LIKE '${IPC}%'",
    "= $YEAR",
    "BETWEEN '$DATE_START'",
    "'${FULLTEXT}'",
    "= '$DETAIL'",
    "LIMIT $LIMIT;",
  ];
  for (const pattern of forbidden) {
    assert.ok(!SCRIPT_SOURCE.includes(pattern), `脚本不应包含直接插值模式: ${pattern}`);
  }
});

test("静态断言：SQL 内以 psql 预定义变量引用全部参数", () => {
  const expectedRefs = [
    ":'keyword'",
    ":'applicant'",
    ":'inventor'",
    ":'ipc'",
    ":year",
    ":'date_start'",
    ":'date_end'",
    ":'fulltext'",
    ":'detail'",
    ":limit_num",
    // P2-01：全文索引模式独立变量
    ":'kw'",
  ];
  for (const ref of expectedRefs) {
    assert.ok(SCRIPT_SOURCE.includes(ref), `脚本应包含参数化引用: ${ref}`);
  }
  // 参数解析处收集 -v 变量
  assert.ok(SCRIPT_SOURCE.includes('PSQL_VARS+=(-v keyword="$2")'));
  assert.ok(SCRIPT_SOURCE.includes('PSQL_VARS+=(-v limit_num="$2")'));
  // execute_query 透传变量
  assert.ok(SCRIPT_SOURCE.includes('"${PSQL_VARS[@]}"'));
});

test("静态断言：P2-01 全文索引分支用 plainto_tsquery + 统一 statement_timeout", () => {
  assert.ok(SCRIPT_SOURCE.includes("plainto_tsquery('chinese', :'kw')"));
  // plainto 而非裸 to_tsquery（用户输入分词后 AND 连接，特殊符号不报错）。
  // 注意 plainto_tsquery 自身含 to_tsquery 子串，用负向前瞻排除 plain 前缀
  assert.ok(!/search_vector @@ (?!plain)to_tsquery\('chinese', :'kw'\)/.test(SCRIPT_SOURCE));
  // execute_query 统一加超时
  assert.ok(SCRIPT_SOURCE.includes("SET statement_timeout = '5s'"));
  // 索引模式参数也走 -v 收集
  assert.ok(SCRIPT_SOURCE.includes('PSQL_VARS+=(-v kw="$2")'));
});

test("动态 mock：注入载荷以 -v 值形式传给 psql，不内联进 SQL 文本", { skip: !BASH_AVAILABLE }, () => {
  const payload = "x'; DROP TABLE patents; --";
  const { logFile, stdinLog } = setupMockRun(["--keyword", payload]);
  const args = readMockArgs(logFile);

  // 载荷作为 -v keyword=... 的值原样传入（psql 负责引号转义）。
  // 按变量名前缀查找：P3-05 起默认 -v limit_num=20 注入在 argv 前部，
  // 第一个 -v 不一定是 keyword
  const kw = args.find(arg => arg.startsWith("keyword="));
  assert.ok(kw !== undefined, "psql 应收到 -v keyword= 变量");
  assert.equal(kw, `keyword=${payload}`, "载荷应作为 -v 变量值传递");

  // SQL 经 stdin 管道送入（P3-05 起 psql 调用无 -c），不得包含载荷
  const sql = readFileSync(stdinLog, "utf8");
  assert.ok(sql.includes(":'keyword'"), "SQL 应保留 :'keyword' 占位引用");
  assert.ok(!sql.includes("DROP TABLE"), "SQL 文本不应包含注入载荷");
});

test("动态 mock：IPC 注入载荷被白名单校验拒绝", { skip: !BASH_AVAILABLE }, () => {
  assert.throws(() => setupMockRun(["--ipc", "G06; DROP TABLE patents; --"]), /格式不合法/);
});

test("动态 mock：limit 非数字被白名单校验拒绝", { skip: !BASH_AVAILABLE }, () => {
  assert.throws(() => setupMockRun(["--limit", "20; DROP"]), /必须为正整数/);
});

test("动态 mock：日期非法格式被白名单校验拒绝", { skip: !BASH_AVAILABLE }, () => {
  assert.throws(() => setupMockRun(["--date-range", "2024-01-01", "2024/12/31"]), /日期格式必须为 YYYY-MM-DD/);
});

test("动态 mock：正常关键词以变量值传递且 SQL 结构完好", { skip: !BASH_AVAILABLE }, () => {
  const { logFile, stdinLog } = setupMockRun(["--keyword", "人工智能", "--limit", "3"]);
  const args = readMockArgs(logFile);

  assert.ok(args.includes("keyword=人工智能"), "keyword 以 -v 值传递");
  assert.ok(args.includes("limit_num=3"), "limit 以 -v 值传递");

  const sql = readFileSync(stdinLog, "utf8");
  assert.ok(sql.includes("ILIKE '%' || :'keyword' || '%'"));
  assert.ok(sql.includes("LIMIT :limit_num;"));
});

test("动态 mock：--keyword-indexed 载荷以 -v kw= 传递且走 plainto_tsquery", { skip: !BASH_AVAILABLE }, () => {
  const payload = "人工智能 芯片; DROP TABLE patents; --";
  const { logFile, stdinLog } = setupMockRun(["--keyword-indexed", payload, "--limit", "5"]);
  const args = readMockArgs(logFile);

  assert.ok(args.includes(`kw=${payload}`), "载荷应作为 -v kw 变量值传递");

  const sql = readFileSync(stdinLog, "utf8");
  // 载荷不得内联进 SQL；全文检索经 plainto_tsquery 分词（含特殊符号也不报错）
  assert.ok(sql.includes("plainto_tsquery('chinese', :'kw')"));
  assert.ok(!sql.includes("DROP TABLE"), "SQL 文本不应包含注入载荷");
  assert.ok(sql.startsWith("SET statement_timeout = '5s';"), "SQL 应以 statement_timeout 开头");
});
