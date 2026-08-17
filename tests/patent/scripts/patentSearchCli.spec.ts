/**
 * TASK-P3-05 测试：sati patent-search CLI（patentSearch.ts）。
 *
 * 纯函数单测（parse/validate/buildQueries/loadInfraEnv/渲染）+ runPatentSearch
 * 用 mock pg.Client 测试缝验证执行序（SET statement_timeout 单独执行、实际
 * SQL 参数化、三格式输出）。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type pg from "pg";
import {
  buildQueries,
  displayWidth,
  loadInfraEnv,
  main,
  parsePatentSearchArgs,
  renderCsv,
  renderJson,
  renderTable,
  resolveDbConfig,
  runPatentSearch,
  validateArgs,
  validateDate,
  validateIpc,
  validatePositiveInt,
} from "../../../src/cli/commands/patentSearch.js";

test("parsePatentSearchArgs: 空参数返回默认值", () => {
  const args = parsePatentSearchArgs([]);
  assert.equal(args.limit, 20);
  assert.equal(args.outputFormat, "table");
  assert.equal(args.stats, false);
  assert.equal(args.keyword, undefined);
});

test("parsePatentSearchArgs: 检索选项解析（含 ipc 转大写）", () => {
  const args = parsePatentSearchArgs([
    "--keyword",
    "人工智能",
    "--applicant",
    "华为",
    "--inventor",
    "张三",
    "--ipc",
    "g06f1",
    "--year",
    "2024",
    "--date-range",
    "2024-01-01",
    "2024-12-31",
    "--fulltext",
    "神经网络",
    "--detail",
    "CN123456789A",
    "--limit",
    "5",
    "--json",
  ]);
  assert.equal(args.keyword, "人工智能");
  assert.equal(args.applicant, "华为");
  assert.equal(args.inventor, "张三");
  assert.equal(args.ipc, "G06F1", "ipc 应统一转大写");
  assert.equal(args.year, 2024);
  assert.equal(args.dateStart, "2024-01-01");
  assert.equal(args.dateEnd, "2024-12-31");
  assert.equal(args.fulltext, "神经网络");
  assert.equal(args.detail, "CN123456789A");
  assert.equal(args.limit, 5);
  assert.equal(args.outputFormat, "json");
});

test("parsePatentSearchArgs: 统计/趋势选项", () => {
  const args = parsePatentSearchArgs(["--stats", "--top-applicants", "--top-ipc", "--yearly-trend", "--csv"]);
  assert.equal(args.stats, true);
  assert.equal(args.topApplicants, true);
  assert.equal(args.topIpc, true);
  assert.equal(args.yearlyTrend, true);
  assert.equal(args.outputFormat, "csv");
});

test("parsePatentSearchArgs: 未知选项与缺少值抛错", () => {
  assert.throws(() => parsePatentSearchArgs(["--unknown"]), /未知选项/);
  assert.throws(() => parsePatentSearchArgs(["--keyword"]), /缺少参数值/);
  assert.throws(() => parsePatentSearchArgs(["--date-range", "2024-01-01"]), /缺少参数值/);
});

test("validatePositiveInt: 拒绝 0/负数/小数/字符串", () => {
  assert.equal(validatePositiveInt(5, "--limit"), 5);
  assert.throws(() => validatePositiveInt(0, "--limit"), /必须为正整数/);
  assert.throws(() => validatePositiveInt(-3, "--year"), /必须为正整数/);
  assert.throws(() => validatePositiveInt(2.5, "--limit"), /必须为正整数/);
  assert.throws(() => validatePositiveInt(Number.NaN, "--limit"), /必须为正整数/);
});

test("validateDate: 仅接受 YYYY-MM-DD", () => {
  assert.equal(validateDate("2024-01-31", "--date-range 开始"), "2024-01-31");
  assert.throws(() => validateDate("2024-1-31", "--date-range 开始"), /日期格式/);
  assert.throws(() => validateDate("20240131", "--date-range 开始"), /日期格式/);
  assert.throws(() => validateDate("2024/01/31", "--date-range 开始"), /日期格式/);
});

test("validateIpc: 接受主分类与完整分类号，拒绝非法格式", () => {
  assert.equal(validateIpc("G06F1"), "G06F1");
  assert.equal(validateIpc("H04"), "H04");
  assert.equal(validateIpc("A61K31"), "A61K31");
  assert.equal(validateIpc("G06F1/16"), "G06F1/16"); // 完整分类号（含 /NN 小类后缀）
  assert.throws(() => validateIpc("X99"), /格式不合法/);
  assert.throws(() => validateIpc("G06F1/x"), /格式不合法/);
  assert.throws(() => validateIpc(""), /格式不合法/);
});

test("validateArgs: 入口级校验组合", () => {
  assert.doesNotThrow(() => validateArgs({ limit: 20, stats: true, outputFormat: "table" }));
  assert.throws(
    () => validateArgs({ limit: 20, year: 2024, dateStart: "2024-1-1", outputFormat: "table" }),
    /日期格式/,
  );
});

test("buildQueries: 无条件返回空", () => {
  const queries = buildQueries({
    limit: 20,
    stats: false,
    topApplicants: false,
    topIpc: false,
    yearlyTrend: false,
    outputFormat: "table",
  });
  assert.deepEqual(queries, []);
});

test("buildQueries: 单条件生成参数化 SQL（无 :'var' 残留）", () => {
  const [q] = buildQueries({
    limit: 20,
    keyword: "人工智能",
    stats: false,
    topApplicants: false,
    topIpc: false,
    yearlyTrend: false,
    outputFormat: "table",
  });
  assert.equal(q.title, "🔍 关键词检索: 人工智能");
  assert.match(q.text, /patent_name ILIKE '%' \|\| \$1 \|\| '%'/);
  assert.match(q.text, /LIMIT \$2::int/);
  assert.doesNotMatch(q.text, /:'\w+'/, "SQL 不应残留 psql :'var' 插值");
  assert.deepEqual(q.values, ["人工智能", 20]);
});

test("buildQueries: 多条件顺序执行（对齐 Shell 顺序 if）", () => {
  const queries = buildQueries({
    limit: 10,
    keyword: "专利",
    year: 2024,
    stats: false,
    topApplicants: false,
    topIpc: false,
    yearlyTrend: false,
    outputFormat: "table",
  });
  assert.equal(queries.length, 2);
  assert.equal(queries[0].title, "🔍 关键词检索: 专利");
  assert.equal(queries[1].title, "📅 年份检索: 2024");
  assert.match(queries[1].text, /source_year = \$1/);
});

test("buildQueries: 12 分支全覆盖（title 与关键 SQL）", () => {
  const cases: Array<[Partial<Parameters<typeof buildQueries>[0]>, string, RegExp]> = [
    [{ keywordIndexed: "ai" }, "关键词检索（索引）", /plainto_tsquery\('chinese', \$1\)/],
    [{ applicant: "华为" }, "申请人检索", /applicant ILIKE/],
    [{ inventor: "张三" }, "发明人检索", /inventor AS 发明人/],
    [{ ipc: "G06" }, "IPC分类检索", /ipc_code ILIKE \$1 \|\| '%'/],
    [{ year: 2024 }, "年份检索", /source_year = \$1/],
    [{ dateStart: "2024-01-01", dateEnd: "2024-12-31" }, "日期范围检索", /BETWEEN \$1::date AND \$2::date/],
    [{ fulltext: "网络" }, "全文检索", /to_tsquery\('chinese', \$1\)/],
    [{ detail: "CN1" }, "专利详情", /publication_number = \$1[\s\S]*LIMIT 1/],
    [{ stats: true }, "数据库统计", /COUNT\(\*\) FROM patents/],
    [{ topApplicants: true }, "热门申请人", /GROUP BY applicant/],
    [{ topIpc: true }, "热门IPC分类", /GROUP BY ipc_main_class/],
    [{ yearlyTrend: true }, "年度申请趋势", /ORDER BY source_year/],
  ];
  for (const [overrides, titlePart, sqlPattern] of cases) {
    const queries = buildQueries({
      limit: 20,
      keyword: undefined,
      keywordIndexed: undefined,
      applicant: undefined,
      inventor: undefined,
      ipc: undefined,
      year: undefined,
      dateStart: undefined,
      dateEnd: undefined,
      fulltext: undefined,
      detail: undefined,
      stats: false,
      topApplicants: false,
      topIpc: false,
      yearlyTrend: false,
      outputFormat: "table",
      ...overrides,
    });
    assert.equal(queries.length, 1, titlePart);
    assert.match(queries[0].title, new RegExp(titlePart));
    assert.match(queries[0].text, sqlPattern, titlePart);
    assert.doesNotMatch(queries[0].text, /(?<!:):\w+/, "全部参数化，无 psql 变量残留（:: 类型转换除外）");
  }
});

test("loadInfraEnv: 解析 export/引号/注释", () => {
  const dir = mkdtempSync(join(tmpdir(), "infra-env-"));
  const infraDir = join(dir, ".infra");
  mkdirSync(infraDir, { recursive: true });
  writeFileSync(
    join(infraDir, "infra.env"),
    [
      "# comment line",
      "export PGHOST=127.0.0.1",
      "PGPORT=5433",
      'PG_ATHENA_PORT="6432"',
      "PGUSER='athena'",
      "",
      "EMPTY_LINE_ABOVE=1",
    ].join("\n"),
  );
  const env = loadInfraEnv(dir);
  assert.equal(env.PGHOST, "127.0.0.1");
  assert.equal(env.PGPORT, "5433");
  assert.equal(env.PG_ATHENA_PORT, "6432", "双引号应剥离");
  assert.equal(env.PGUSER, "athena", "单引号应剥离");
  assert.equal(env["# comment"], undefined, "注释行不解析");
});

test("loadInfraEnv: 文件缺失返回空对象", () => {
  assert.deepEqual(loadInfraEnv("/nonexistent-home"), {});
});

test("resolveDbConfig: 优先级 PG_ATHENA_PORT > PGPORT > 5433，PGHOST/PGUSER 默认", () => {
  const config = resolveDbConfig({ PG_ATHENA_PORT: "6432", PGHOST: "127.0.0.1", PGUSER: "athena" });
  assert.equal(config.port, 6432);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.user, "athena");
  const defaultPort = resolveDbConfig({ PGPORT: "5555" });
  assert.equal(defaultPort.port, 5555);
  const fallback = resolveDbConfig({});
  assert.equal(fallback.port, 5433);
  assert.equal(fallback.host, "localhost");
  assert.equal(fallback.user, "xujian");
});

test("displayWidth: CJK 全角按 2 计宽", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("专利"), 4);
  assert.equal(displayWidth("a专利b"), 6);
  assert.equal(displayWidth("（全角）"), 8);
});

test("renderTable: psql aligned 风格（含 CJK 填充 + (1 row) 标签）", () => {
  const table = renderTable([{ 专利名称: "一种方法", 申请号: "CN1" }]);
  const lines = table.split("\n");
  assert.equal(lines.length, 5, "表头 + 分隔线 + 数据行 + (1 row) + 空行");
  assert.match(lines[0], /专利名称/);
  assert.match(lines[1], /^\+|-/, "分隔线");
  assert.match(lines[2], /一种方法/);
  assert.equal(lines[3], "(1 row)");
  const headerCells = lines[0].split("|");
  assert.ok(headerCells[0].includes(" 专利名称 "), "全角内容按 2 宽补齐");
  assert.equal(displayWidth(lines[2].split("|")[0]), displayWidth(lines[0].split("|")[0]));
});

test("renderTable: 数字列右对齐，最后一列无尾随空格", () => {
  const table = renderTable([{ 申请人: "华为", 专利数量: "1" }]);
  const lines = table.split("\n");
  // 专利数量（int8 COUNT → 字符串）判定为数字列：右对齐且行尾无空格。
  // psql 行为：最后一列数据行无右侧填充，宽度 = 表头宽 - 1（实测确认）
  assert.match(lines[2], / 华为\s*\| +\d+$/, "数字列右对齐、行尾无空格");
  assert.equal(displayWidth(lines[2].split("|")[1]) + 1, displayWidth(lines[0].split("|")[1]));
});

test("renderTable: 空结果输出表头 + 分隔线 + (0 rows)", () => {
  const table = renderTable([], ["专利名称", "申请号"]);
  const lines = table.split("\n");
  assert.equal(lines.length, 4, "表头 + 分隔线 + (0 rows) + 空行");
  assert.match(lines[0], / 专利名称 \| 申请号 /);
  assert.match(lines[1], /^----------\+/, "分隔线列宽按表头算");
  assert.equal(lines[2], "(0 rows)");
});

test("renderTable: 空结果且无列名时退化为 (0 rows)", () => {
  assert.equal(renderTable([]), "(0 rows)\n");
});

test("renderCsv: 无表头、逗号分隔、null 空串", () => {
  assert.equal(
    renderCsv([
      { a: 1, b: "x" },
      { a: 2, b: null },
    ]),
    "1,x\n2,",
  );
  assert.equal(renderCsv([]), "");
});

test("renderJson: 真 JSON 输出", () => {
  const json = renderJson([{ a: 1 }]);
  assert.deepEqual(JSON.parse(json), [{ a: 1 }]);
});

function makeMockClient(queryLog: Array<{ text: string; values: unknown[] }>): pg.Client {
  return {
    query: async (text: string, values: unknown[]) => {
      queryLog.push({ text, values });
      return { rows: [{ 专利名称: "样本专利", 申请号: "CN1" }] };
    },
    connect: async () => {},
    end: async () => {},
  } as unknown as pg.Client;
}

test("runPatentSearch: 执行序 = 标题 + SET 单独执行 + 参数化 SQL", async () => {
  const queryLog: Array<{ text: string; values: unknown[] }> = [];
  const output = await runPatentSearch(
    {
      limit: 5,
      keyword: "专利",
      stats: false,
      topApplicants: false,
      topIpc: false,
      yearlyTrend: false,
      outputFormat: "table",
    },
    { client: makeMockClient(queryLog) },
  );
  assert.equal(queryLog.length, 2, "SET 与查询各一次");
  assert.equal(queryLog[0].text, "SET statement_timeout = '5s'");
  assert.match(queryLog[1].text, /patent_name ILIKE/);
  assert.deepEqual(queryLog[1].values, ["专利", 5]);
  assert.match(output, /🔍 关键词检索: 专利/);
  assert.match(output, /样本专利/);
});

test("runPatentSearch: json 格式输出真 JSON 块", async () => {
  const output = await runPatentSearch(
    {
      limit: 5,
      keyword: "专利",
      stats: false,
      topApplicants: false,
      topIpc: false,
      yearlyTrend: false,
      outputFormat: "json",
    },
    { client: makeMockClient([]) },
  );
  const lines = output.split("\n");
  assert.equal(lines[0], "🔍 关键词检索: 专利");
  assert.deepEqual(JSON.parse(lines.slice(1).join("\n")), [{ 专利名称: "样本专利", 申请号: "CN1" }]);
});

test("runPatentSearch: csv 格式输出", async () => {
  const output = await runPatentSearch(
    {
      limit: 5,
      keyword: "专利",
      stats: false,
      topApplicants: false,
      topIpc: false,
      yearlyTrend: false,
      outputFormat: "csv",
    },
    { client: makeMockClient([]) },
  );
  assert.equal(output, "🔍 关键词检索: 专利\n样本专利,CN1");
});

test("main: --help 输出用法并返回 0", async () => {
  const exitCode = await main(["--help"]);
  assert.equal(exitCode, 0);
});

test("main: 未知选项返回 1", async () => {
  const exitCode = await main(["--bogus"]);
  assert.equal(exitCode, 1);
});
