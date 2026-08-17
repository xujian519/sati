/**
 * `sati patent-search` — patent_search.sh 的 TS 迁移版（TASK-P3-05）。
 *
 * 功能与 Shell 版 100% 对齐：12 个查询分支（关键词/索引关键词/申请人/发明人/IPC/
 * 年份/日期范围/全文/详情/统计/热门申请人/热门IPC/年度趋势）+ 白名单校验（P0-01）
 * + statement_timeout 5s（P2-01）。SQL 一律参数化（pg $N 占位符，等价 psql :'var'）。
 *
 * 与 Shell 版的差异：
 * - `--json` 输出真正的 JSON（rows 数组）；Shell 版的 json 实际退化为 psql 文本行
 *   （jq 失败回退），属缺陷修正；
 * - 输出渲染尽量贴近 psql aligned/csv 样式（数据行逐行一致）。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pg from "pg";

// date 列（OID 1082）保留服务端原字符串（YYYY-MM-DD）：pg 默认解析为 JS Date
// 对象，String() 输出含时区、与 psql 文本输出不一致，破坏对齐
pg.types.setTypeParser(1082, (value: string) => value);

export type PatentSearchArgs = {
  keyword?: string;
  keywordIndexed?: string;
  applicant?: string;
  inventor?: string;
  ipc?: string;
  year?: number;
  dateStart?: string;
  dateEnd?: string;
  fulltext?: string;
  detail?: string;
  /** 布尔开关（缺省视为 false，对齐 Shell 空串语义）。 */
  stats?: boolean;
  topApplicants?: boolean;
  topIpc?: boolean;
  yearlyTrend?: boolean;
  limit: number;
  outputFormat: "table" | "json" | "csv";
};

const DEFAULT_LIMIT = 20;
const DEFAULT_PORT = 5433;
const DEFAULT_USER = "xujian";
const DB_NAME = "patent_db";

/** 解析命令行参数（对齐 Shell 版 while/case 语义；未知选项抛错）。 */
export function parsePatentSearchArgs(argv: string[]): PatentSearchArgs {
  const args: PatentSearchArgs = {
    stats: false,
    topApplicants: false,
    topIpc: false,
    yearlyTrend: false,
    limit: DEFAULT_LIMIT,
    outputFormat: "table",
  };
  const readValue = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`错误: ${flag} 缺少参数值`);
    return value;
  };
  /** 与 Shell 一致：仅接受纯十进制数字字符串（拒绝 1e3/0x10 等 Number() 隐式转换形式）。 */
  const parsePositiveInt = (raw: string, name: string): number => {
    if (!/^[0-9]+$/.test(raw)) {
      throw new Error(`错误: ${name} 必须为正整数（收到: ${raw}）`);
    }
    return Number(raw);
  };
  for (let i = 0; i < argv.length; ) {
    const flag = argv[i];
    switch (flag) {
      case "--keyword":
        args.keyword = readValue(flag, i);
        i += 2;
        break;
      case "--keyword-indexed":
        args.keywordIndexed = readValue(flag, i);
        i += 2;
        break;
      case "--applicant":
        args.applicant = readValue(flag, i);
        i += 2;
        break;
      case "--inventor":
        args.inventor = readValue(flag, i);
        i += 2;
        break;
      case "--ipc":
        args.ipc = readValue(flag, i).toUpperCase();
        i += 2;
        break;
      case "--year":
        args.year = parsePositiveInt(readValue(flag, i), "--year");
        i += 2;
        break;
      case "--date-range":
        args.dateStart = readValue(flag, i);
        args.dateEnd = readValue(`${flag} 结束`, i + 1);
        i += 3;
        break;
      case "--fulltext":
        args.fulltext = readValue(flag, i);
        i += 2;
        break;
      case "--detail":
        args.detail = readValue(flag, i);
        i += 2;
        break;
      case "--stats":
        args.stats = true;
        i += 1;
        break;
      case "--top-applicants":
        args.topApplicants = true;
        i += 1;
        break;
      case "--top-ipc":
        args.topIpc = true;
        i += 1;
        break;
      case "--yearly-trend":
        args.yearlyTrend = true;
        i += 1;
        break;
      case "--limit":
        args.limit = parsePositiveInt(readValue(flag, i), "--limit");
        i += 2;
        break;
      case "--json":
        args.outputFormat = "json";
        i += 1;
        break;
      case "--csv":
        args.outputFormat = "csv";
        i += 1;
        break;
      default:
        throw new Error(`未知选项: ${flag}`);
    }
  }
  return args;
}

/** P0-01 白名单校验（与 Shell 版规则一致；非法输入抛错）。 */
export function validatePositiveInt(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`错误: ${name} 必须为正整数（收到: ${value}）`);
  return value;
}

export function validateDate(value: string, name: string): string {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) {
    throw new Error(`错误: ${name} 日期格式必须为 YYYY-MM-DD（收到: ${value}）`);
  }
  return value;
}

export function validateIpc(value: string): string {
  // IPC 主分类形如 G06F1/16；支持完整分类号（含 /NN 小类后缀），与 Shell 版一致。
  if (!/^[A-H][0-9]{2}[A-Z]?[0-9]*(\/[0-9]+)?$/.test(value)) {
    throw new Error(`错误: --ipc 格式不合法（应为如 G06F1 或 G06F1/16，收到: ${value}）`);
  }
  return value;
}

/** 执行入口级校验：limit 恒校验，其余按传入条件（对齐 Shell 的 if 校验序列）。 */
export function validateArgs(args: PatentSearchArgs): void {
  validatePositiveInt(args.limit, "--limit");
  if (args.year !== undefined) validatePositiveInt(args.year, "--year");
  if (args.dateStart !== undefined) validateDate(args.dateStart, "--date-range 开始");
  if (args.dateEnd !== undefined) validateDate(args.dateEnd, "--date-range 结束");
  if (args.ipc !== undefined) validateIpc(args.ipc);
}

export type QuerySpec = {
  /** 输出时的标题行（Shell 的 emoji 前缀 + 条件说明）。 */
  title: string;
  /** 参数化 SQL（$N 占位符）。 */
  text: string;
  values: (string | number)[];
  /** SELECT 列名（psql 别名）。空结果时 psql 仍输出表头，渲染需列名。 */
  columns: string[];
};

/** 构建激活的查询序列（对齐 Shell 顺序 if 语义：多个条件依次执行）。
 * 占位符序号与 values 严格对齐（$N 的下标即 values[N-1]）；数字/日期参数
 * 显式 ::int / ::date——pg 参数化按 text 编码，LIMIT/比较需显式类型。 */
export function buildQueries(args: PatentSearchArgs): QuerySpec[] {
  const queries: QuerySpec[] = [];
  const baseColumns = ["专利名称", "申请号", "申请人", "ipc主分类", "申请日期"];
  const baseSelect = `patent_name AS 专利名称,
        application_number AS 申请号,
        applicant AS 申请人,
        ipc_main_class AS IPC主分类,
        application_date AS 申请日期`;
  if (args.keyword !== undefined) {
    queries.push({
      title: `🔍 关键词检索: ${args.keyword}`,
      text: `SELECT ${baseSelect}
    FROM patents
    WHERE patent_name ILIKE '%' || $1 || '%'
       OR abstract ILIKE '%' || $1 || '%'
    ORDER BY application_date DESC
    LIMIT $2::int`,
      values: [args.keyword, args.limit],
      columns: baseColumns,
    });
  }
  if (args.keywordIndexed !== undefined) {
    queries.push({
      title: `🔍 关键词检索（索引）: ${args.keywordIndexed}`,
      text: `SELECT ${baseSelect}
    FROM patents
    WHERE search_vector @@ plainto_tsquery('chinese', $1)
    ORDER BY application_date DESC
    LIMIT $2::int`,
      values: [args.keywordIndexed, args.limit],
      columns: baseColumns,
    });
  }
  if (args.applicant !== undefined) {
    queries.push({
      title: `🏢 申请人检索: ${args.applicant}`,
      text: `SELECT ${baseSelect}
    FROM patents
    WHERE applicant ILIKE '%' || $1 || '%'
    ORDER BY application_date DESC
    LIMIT $2::int`,
      values: [args.applicant, args.limit],
      columns: baseColumns,
    });
  }
  if (args.inventor !== undefined) {
    // 与 Shell 版一致：发明人检索列序为 发明人/申请人（无 IPC 主分类）
    queries.push({
      title: `👤 发明人检索: ${args.inventor}`,
      text: `SELECT
        patent_name AS 专利名称,
        application_number AS 申请号,
        inventor AS 发明人,
        applicant AS 申请人,
        application_date AS 申请日期
    FROM patents
    WHERE inventor ILIKE '%' || $1 || '%'
    ORDER BY application_date DESC
    LIMIT $2::int`,
      values: [args.inventor, args.limit],
      columns: ["专利名称", "申请号", "发明人", "申请人", "申请日期"],
    });
  }
  if (args.ipc !== undefined) {
    queries.push({
      title: `📊 IPC分类检索: ${args.ipc}`,
      text: `SELECT patent_name AS 专利名称,
        application_number AS 申请号,
        ipc_code AS IPC分类,
        applicant AS 申请人,
        application_date AS 申请日期
    FROM patents
    WHERE ipc_code ILIKE $1 || '%'
       OR ipc_main_class ILIKE $1 || '%'
    ORDER BY application_date DESC
    LIMIT $2::int`,
      values: [args.ipc, args.limit],
      columns: ["专利名称", "申请号", "ipc分类", "申请人", "申请日期"],
    });
  }
  if (args.year !== undefined) {
    queries.push({
      title: `📅 年份检索: ${args.year}`,
      text: `SELECT ${baseSelect}
    FROM patents
    WHERE source_year = $1::int
    ORDER BY application_date DESC
    LIMIT $2::int`,
      values: [args.year, args.limit],
      columns: baseColumns,
    });
  }
  if (args.dateStart !== undefined && args.dateEnd !== undefined) {
    queries.push({
      title: `📅 日期范围检索: ${args.dateStart} 至 ${args.dateEnd}`,
      text: `SELECT ${baseSelect}
    FROM patents
    WHERE application_date BETWEEN $1::date AND $2::date
    ORDER BY application_date DESC
    LIMIT $3::int`,
      values: [args.dateStart, args.dateEnd, args.limit],
      columns: baseColumns,
    });
  }
  if (args.fulltext !== undefined) {
    queries.push({
      title: `📚 全文检索: ${args.fulltext}`,
      text: `SELECT ${baseSelect}
    FROM patents
    WHERE search_vector @@ to_tsquery('chinese', $1)
    ORDER BY application_date DESC
    LIMIT $2::int`,
      values: [args.fulltext, args.limit],
      columns: baseColumns,
    });
  }
  if (args.detail !== undefined) {
    queries.push({
      title: `📄 专利详情: ${args.detail}`,
      text: `SELECT
        patent_name AS 专利名称,
        application_number AS 申请号,
        publication_number AS 公开号,
        authorization_number AS 授权号,
        application_date AS 申请日期,
        publication_date AS 公开日期,
        authorization_date AS 授权日期,
        applicant AS 申请人,
        applicant_address AS 申请人地址,
        current_assignee AS 当前权利人,
        inventor AS 发明人,
        ipc_code AS IPC分类号,
        ipc_main_class AS IPC主分类,
        abstract AS 摘要,
        citation_count AS 引用次数,
        cited_count AS 被引次数
    FROM patents
    WHERE publication_number = $1
       OR application_number = $1
       OR authorization_number = $1
    LIMIT 1`,
      values: [args.detail],
      columns: [
        "专利名称",
        "申请号",
        "公开号",
        "授权号",
        "申请日期",
        "公开日期",
        "授权日期",
        "申请人",
        "申请人地址",
        "当前权利人",
        "发明人",
        "ipc分类号",
        "ipc主分类",
        "摘要",
        "引用次数",
        "被引次数",
      ],
    });
  }
  if (args.stats) {
    queries.push({
      title: "📊 数据库统计",
      text: `SELECT
        (SELECT COUNT(*) FROM patents) AS 总专利数,
        (SELECT COUNT(DISTINCT applicant) FROM patents) AS 申请人数,
        (SELECT COUNT(DISTINCT ipc_main_class) FROM patents) AS IPC分类数,
        (SELECT MIN(application_date) FROM patents) AS 最早申请日期,
        (SELECT MAX(application_date) FROM patents) AS 最新申请日期,
        (SELECT COUNT(*) FROM patents WHERE embedding_combined IS NOT NULL) AS 向量化专利数`,
      values: [],
      columns: ["总专利数", "申请人数", "ipc分类数", "最早申请日期", "最新申请日期", "向量化专利数"],
    });
  }
  if (args.topApplicants) {
    queries.push({
      title: `🏢 热门申请人 TOP ${args.limit}`,
      text: `SELECT
        applicant AS 申请人,
        COUNT(*) AS 专利数量
    FROM patents
    GROUP BY applicant
    ORDER BY COUNT(*) DESC
    LIMIT $1::int`,
      values: [args.limit],
      columns: ["申请人", "专利数量"],
    });
  }
  if (args.topIpc) {
    queries.push({
      title: `📊 热门IPC分类 TOP ${args.limit}`,
      text: `SELECT
        ipc_main_class AS IPC主分类,
        COUNT(*) AS 专利数量
    FROM patents
    WHERE ipc_main_class IS NOT NULL
    GROUP BY ipc_main_class
    ORDER BY COUNT(*) DESC
    LIMIT $1::int`,
      values: [args.limit],
      columns: ["ipc主分类", "专利数量"],
    });
  }
  if (args.yearlyTrend) {
    queries.push({
      title: "📈 年度申请趋势",
      text: `SELECT
        source_year AS 年份,
        COUNT(*) AS 申请数量
    FROM patents
    WHERE source_year IS NOT NULL
    GROUP BY source_year
    ORDER BY source_year`,
      values: [],
      columns: ["年份", "申请数量"],
    });
  }
  return queries;
}

/** 读取 ~/.infra/infra.env 的 key=value 配置（对齐 Shell `source` 语义的键子集）。 */
export function loadInfraEnv(home = homedir()): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const content = readFileSync(join(home, ".infra", "infra.env"), "utf8");
    for (const line of content.split("\n")) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      env[match[1]] = value;
    }
  } catch {
    // infra.env 缺失时静默回退默认值（对齐 Shell source 失败不中断）
  }
  return env;
}

/** 连接配置（对齐 Shell：PGHOST/PG_ATHENA_PORT→PGPORT→5433/PGUSER→xujian；patent_db 固定）。 */
export function resolveDbConfig(env: Record<string, string> = loadInfraEnv()): {
  host: string;
  port: number;
  user: string;
} {
  return {
    host: env.PGHOST ?? "localhost",
    // `||` 与 Shell 的 `${VAR:-default}` 对齐：空串（PG_ATHENA_PORT=）同样兜底，
    // 避免 Number("") === 0 连到 localhost:0。
    port: Number(env.PG_ATHENA_PORT || env.PGPORT || DEFAULT_PORT),
    user: env.PGUSER ?? DEFAULT_USER,
  };
}

/** 显示宽度：CJK 全角按 2，其余 1（对齐 psql 对齐表格的宽度计算）。 */
export function displayWidth(value: string): number {
  let width = 0;
  for (const ch of value) {
    width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  }
  return width;
}

/** 渲染 psql aligned 风格表格（与 psql 输出逐行一致）。
 * 规则（实测 psql 17）：列宽 = max(表头, 数据) + 2；表头居中于整列（含两侧边框）；
 * 数据行每列独立判定——数字列右对齐、文本列左对齐；中间列两侧各有 1 边框空格，
 * 最后一列无右侧填充；空结果仍输出表头 + 分隔线 + "(0 rows)"（列宽按表头算）。
 * 数字列判定含纯数字字符串：pg 将 COUNT(*)（int8）解析为字符串。 */
export function renderTable(rows: Record<string, unknown>[], columns?: string[]): string {
  const cols = columns ?? (rows.length > 0 ? Object.keys(rows[0]) : []);
  if (cols.length === 0) return "(0 rows)\n";
  const widthOf = (value: unknown) => (value == null ? 0 : displayWidth(String(value)));
  const widths = cols.map(col => Math.max(widthOf(col), ...rows.map(row => widthOf(row[col]))) + 2);
  const header = cols
    .map((col, i) => {
      const gap = widths[i] - widthOf(col);
      const left = Math.floor(gap / 2);
      return " ".repeat(left) + col + " ".repeat(gap - left);
    })
    .join("|");
  const sep = widths.map(w => "-".repeat(w)).join("+");
  if (rows.length === 0) return [header, sep, "(0 rows)", ""].join("\n");
  // 每列独立类型判定：全列（除 null/undefined）为 number 或纯数字字符串 → 数字列右对齐
  const numeric = cols.map(
    col =>
      rows.some(row => row[col] != null) &&
      rows.every(row => row[col] == null || typeof row[col] === "number" || /^\d+$/.test(String(row[col]))),
  );
  const body = rows.map(row =>
    cols
      .map((col, i) => {
        const content = String(row[col] ?? "");
        const last = i === cols.length - 1;
        if (numeric[i]) {
          // 右对齐：左侧补到（列宽-1），最后一列无右侧边框空格
          const pad = widths[i] - 1 - widthOf(content);
          return " ".repeat(pad > 0 ? pad : 0) + content + (last ? "" : " ");
        }
        // 左对齐：左边框 1 空格 + 内容 + 右填充；最后一列不填充
        return " " + content + (last ? "" : " ".repeat(Math.max(0, widths[i] - 1 - widthOf(content))));
      })
      .join("|"),
  );
  const countLabel = rows.length === 1 ? "(1 row)" : `(${rows.length} rows)`;
  return [header, sep, ...body, countLabel, ""].join("\n");
}

/** 渲染 CSV（对齐 psql -t -A -F','：无表头、无转义、null → 空串）。 */
export function renderCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const columns = Object.keys(rows[0]);
  return rows.map(row => columns.map(col => String(row[col] ?? "")).join(",")).join("\n");
}

/** 渲染 JSON（Shell 版缺陷修正：输出真正的 JSON rows 数组）。 */
export function renderJson(rows: Record<string, unknown>[]): string {
  return JSON.stringify(rows, null, 2);
}

export type PatentSearchDbOptions = {
  /** 测试缝：替换 pg Client（默认连本地 patent_db）。 */
  client?: pg.Client;
};

/** 执行全部激活查询并逐块输出（标题行 + 数据块）。 */
export async function runPatentSearch(args: PatentSearchArgs, options: PatentSearchDbOptions = {}): Promise<string> {
  const queries = buildQueries(args);
  const dbConfig = resolveDbConfig();
  const ownsClient = options.client === undefined;
  const client =
    options.client ??
    new pg.Client({
      host: dbConfig.host,
      port: dbConfig.port,
      user: dbConfig.user,
      database: DB_NAME,
    });
  if (ownsClient) await client.connect();
  try {
    const blocks: string[] = [];
    for (const query of queries) {
      blocks.push(query.title);
      // P2-01：与 Shell 版一致，每条查询限定 5s 超时。
      // SET 单独执行：pg 带参数查询走 extended protocol，不支持多语句拼接
      await client.query("SET statement_timeout = '5s'");
      const result = await client.query(query.text, query.values);
      const rows = (result.rows ?? []) as Record<string, unknown>[];
      if (args.outputFormat === "json") blocks.push(renderJson(rows));
      else if (args.outputFormat === "csv") blocks.push(renderCsv(rows));
      else blocks.push(renderTable(rows, query.columns));
    }
    return blocks.join("\n");
  } finally {
    if (ownsClient) await client.end().catch(() => {});
  }
}

/** 帮助文本（--help / -h 时输出）。 */
function showHelp(): string {
  return `专利检索工具 - 从 patent_db 检索专利数据

用法: sati patent-search [选项]

检索选项:
  --keyword <关键词>      关键词检索（专利名称、摘要，ILIKE 模糊匹配）
  --keyword-indexed <关键词>  关键词检索（走 search_vector 全文索引，性能更好；
                              语义为全部词 AND 匹配，适合精确词汇）
  --applicant <申请人>    按申请人检索
  --inventor <发明人>     按发明人检索
  --ipc <IPC分类>         按IPC分类检索
  --year <年份>           按年份筛选
  --date-range <开始> <结束>  按日期范围筛选
  --fulltext <关键词>     全文检索（标题+摘要+权利要求）
  --detail <公开号>       查看专利详情

统计选项:
  --stats                 数据库统计
  --top-applicants        热门申请人
  --top-ipc               热门IPC分类
  --yearly-trend          年度趋势

输出选项:
  --limit <数量>          限制返回数量 (默认: 20)
  --json                  JSON格式输出
  --csv                   CSV格式输出

示例:
  sati patent-search --keyword '人工智能' --limit 10
  sati patent-search --applicant '华为' --year 2024
  sati patent-search --ipc 'G06' --limit 30
  sati patent-search --detail 'CN202310000001'
  sati patent-search --stats`;
}

/** CLI 入口（sati patent-search）。 */
export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(showHelp());
    return 0;
  }
  try {
    const args = parsePatentSearchArgs(argv);
    validateArgs(args);
    console.log(await runPatentSearch(args));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
