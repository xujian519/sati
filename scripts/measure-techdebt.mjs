#!/usr/bin/env node
/**
 * Sati 技术债务指标度量脚本（只读、幂等）。
 *
 * 用法：
 *   node scripts/measure-techdebt.mjs --json          # 输出 JSON（默认）
 *   node scripts/measure-techdebt.mjs --update <path> # 写入/刷新 metrics.md
 *   node scripts/measure-techdebt.mjs --check [path]  # 校验基线新鲜度（不写文件；过期则非 0 退出）
 *
 * 覆盖指标：
 *   - 体积/复杂度：目录文件数/行数、Top 大文件、TS AST 单函数行数（god function）
 *   - 类型安全    ：类型位 any（TS AST 精确）+ @ts-expect-error / @ts-ignore（src + ui/src）
 *                  另立 `as unknown as T` 双重断言口径（比 any 更强的逃逸，单列不合并）
 *   - 错误&可观测 ：裸 console.*、空 catch、无参 catch（含无注释隐患类）、TODO/HACK/FIXME/XXX
 *   - 分层边界    ：ui/server→src 深层导入、src→ui 导入、ui/server 直连 edgeclaw lib 编译产物
 *   - 测试        ：各 src 模块测试文件数、零/极薄模块
 *   - i18n        ：en / zh-CN 命名空间 key 对齐
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const ROOT = new URL("..", import.meta.url).pathname;

/**
 * 按「**任意层级的目录名**」豁免的目录：**产物类**——无论出现在哪一层都不可能是本仓源码。
 *
 * 只放这一类的目录名。名字本身不表明是产物的目录（`lib` / `ui-source`）改走
 * `EXCLUDE_PATH_PREFIXES`，否则会把与编译产物同名的**源码目录**一并吞掉（#530）。
 */
const EXCLUDE_DIRS = new Set([
  "node_modules",
  "dist",
  ".pnpm-store",
  "coverage",
  ".git",
  ".reasonix",
  ".qoder",
  ".codegraph",
  "test-results",
]);

/**
 * 按「**仓库相对路径前缀**」豁免的目录（2026-09-24 · #530）。
 *
 * 为什么不能放进 `EXCLUDE_DIRS`：那里的判据是「任意层级的目录名」，于是与编译产物**同名**的
 * 源码目录会一起被吞掉——`ui/src/lib/` 是真实源码（4 个 .ts + 1 个 .js），却因撞名 `lib` 而
 * 不在任何文件级扫描里：少算 1 处无注释无参 catch、5 个文件的规模（`uiSrcFiles` / `uiSrcLines`）。
 * 这类撞名不是孤例，仓内还有 `scripts/lib`、`skills/<skill>/scripts/lib`、`apps/desktop/scripts/lib`，
 * 逐个加白名单只会让下一个人再踩一次，故改为路径限定。
 *
 * 下面两条都是 `edgeclaw-memory-core` 子包内的**非源码**内容：`lib/` 是编译产物（36 个 .js +
 * 36 个 .d.ts）、`ui-source/` 是 memory-dashboard 资产。子包整体已由 `VENDORED_SUBTREES` 单列，
 * 这里豁免它们是为了不让编译产物进入 vendored 规模统计。
 */
const EXCLUDE_PATH_PREFIXES = [
  "src/context/memory/edgeclaw-memory-core/lib",
  "src/context/memory/edgeclaw-memory-core/ui-source",
];

/**
 * 路径前缀豁免判据（精确到**路径段**，故不会误伤 `libx/`、`library/` 这类同前缀兄弟名）。
 *
 * @param {string} relPath 以 `/` 分隔的仓库相对路径
 * @returns {boolean}
 */
function isPathExcluded(relPath) {
  return EXCLUDE_PATH_PREFIXES.some(prefix => relPath === prefix || relPath.startsWith(`${prefix}/`));
}

/**
 * 内嵌 vendored 子包：**仓库相对路径前缀**口径（2026-09-16 · #341）。
 *
 * 与 `EXCLUDE_DIRS` 的区别：后者按「任意层级的目录名」豁免（`dist` 无论出现在哪一层都算），
 * 这里按路径前缀精确匹配，不会误伤同名目录。
 *
 * 为什么整体移出文件级指标：`edgeclaw-memory-core` 是从外部项目整体搬入的记忆内核，自带
 * `package.json` / `tsconfig` / 独立 `build`·`test` 脚本，本仓不参与其演进；它却占 `src` 行数的
 * 9.0%（49 个 .ts / 16,682 行），并在「Top 大文件」「God function」两张**排期表**里各占 3 席
 * （`sqlite.ts` 1711 / `llm-extraction.ts` 1624 / `file-memory.ts` 1139；`run` 524 /
 * `retrieve` 484 / `runHeartbeat` 477）。这两张表的用途是「挑下一个要拆的文件 / 函数」，
 * 混入非本仓维护的代码会直接误导排期。故按 #341 整体移出，改为在 `metrics.md` 单列一节
 * （规模 + 自身 Top 文件），既不混排期也不丢可见度。
 *
 * 注：该子包的 `lib/`（编译产物）与 `ui-source/`（memory-dashboard 资产）由
 * `EXCLUDE_PATH_PREFIXES` 按路径豁免（#530 起；此前按目录名，会误伤 `ui/src/lib/`），
 * 故这里只需要挡住 `src/` 与 `tests/` 下的 .ts。
 */
export const VENDORED_SUBTREES = ["src/context/memory/edgeclaw-memory-core"];

/**
 * 判断仓库相对路径是否落在 vendored 子包内。
 *
 * 按**路径段前缀**匹配（等于 `p` 本身，或以 `p/` 开头），故 `edgeclaw-memory-core-extra/`
 * 这类同前缀兄弟目录不会被误伤。
 *
 * @param {string} relPath 以 `/` 分隔的仓库相对路径
 * @returns {boolean}
 */
export function isVendored(relPath) {
  return VENDORED_SUBTREES.some(p => relPath === p || relPath.startsWith(`${p}/`));
}

const GOD_FN_THRESHOLD = Number(process.env.GOD_FN_THRESHOLD ?? 300);
const TOP_FILES_LIMIT = Number(process.env.TOP_FILES_LIMIT ?? 30);
/** `metrics.md` 的「vendored 子包」节列出该子包自身最大的几个文件。 */
const VENDORED_TOP_LIMIT = Number(process.env.VENDORED_TOP_LIMIT ?? 5);

/** `--check` 未显式给路径时比对的基线。 */
const DEFAULT_METRICS_PATH = "docs/technical-debt/metrics.md";

// 裸正则模式（type escape 专用模式已废弃，改走 TS AST，见 scanTypeEscapes）。
const CONSOLE_PATTERN = /console\.(log|error|warn|info|debug)/g;
const EMPTY_CATCH_PATTERN = /catch\s*(\([^)]*\))?\s*\{\s*\}/g;
const TODO_PATTERN = /\b(TODO|FIXME|HACK|XXX)\b/g;

/**
 * 各指标的作用域（2026-09-11 C42 对齐）。
 *
 * 此前所有指标一律只扫 `src/`，而 `docs/code-refinement-plan.md` §六 基线表声明的是
 * `src + ui/src` / `src + ui/server` / `src + ui + ui/server + tests`——工具与文档两套口径，
 * 导致 C40/C41 两张横切卡都得先用自建扫描重建口径才能定目标（见 C41 note「遗留口径问题」）。
 * 口径一旦变化，历史快照的同比须按同一口径重算，故在此显式声明并可被 `--json` 读出。
 */
const SCOPE_DOC = {
  console:
    "src + ui/server（.ts/.tsx/.js/.jsx/.mjs/.cjs；豁免两处 C39 收束入口 ui/server/utils/consoleLogger.js 与 ui/src/utils/logging.ts）",
  unsafe: "src + ui/src（.ts/.tsx，含同址 *.spec.*；TS AST 精确统计 AnyKeyword + @ts-* 指令）",
  asUnknownAs:
    "src + ui/src（.ts/.tsx，含同址 *.spec.*；TS AST 统计 `x as unknown as T` 双重断言）。**口径变更**：2026-09-15（issue #339）首度纳入——此前该形态完全未统计，故 0 → N 的变化来自口径变更而非新增债务",
  catch:
    "src + ui/src + ui/server 产品代码（排除 *.spec.* / *.test.*）。**口径变更**：2026-09-16（issue #341）纳入 ui/server——此前仅 src + ui/src，于是「空 catch {}」报 0 而 ui/server 实有 1 处，且同为「错误 & 可观测」类的 console/todos 早已含 ui/server，口径自相矛盾；2026-09-24（issue #530）补 ui/src 的 .js/.jsx（9 个文件）并解除 `lib` 目录名豁免对**同名源码目录** `ui/src/lib/` 的误伤——此后「无注释的无参 catch」由 12 更正为 17（少算的 5 处全部计入），属口径变更而非新增债务",
  todos: "src + ui/src + ui/server + tests（.ts/.tsx/.js/.jsx/.mjs/.cjs）",
  vendored:
    "src/context/memory/edgeclaw-memory-core（**整体移出文件级指标**，2026-09-16 issue #341）：外部搬入的记忆内核，自带 package.json / tsconfig 与独立 build·test，不随本仓演进。其 src 与 tests 下的 .ts 此前计入 src 规模与两张排期表，现单列于 metrics.md「vendored 子包」节；该子包自己的 lib/（编译产物）与 ui-source/（memory-dashboard 资产）按**路径前缀**豁免（2026-09-24 issue #530 起——此前按「任意层级目录名」豁免，会把与编译产物撞名的源码目录 `ui/src/lib/` 一并吞掉）",
};

/**
 * C39 刻意建立的日志收束入口——它们体内就是 `console.*` 转发，计入即定义性错误。
 * 真实裸调用由其消费方统计（见 C39 记录：收束后 src/ 真实裸调用 143 处，全部按设计豁免）。
 */
const SANCTIONED_CONSOLE_ENTRIES = new Set(["ui/server/utils/consoleLogger.js", "ui/src/utils/logging.ts"]);

const isTestFile = f => /\.(spec|test)\.[cm]?[jt]sx?$/.test(f);

let ts = null;

async function initTs() {
  if (ts) return ts;
  const mod = await import("typescript");
  ts = mod.default ?? mod;
  return ts;
}

/**
 * 仓库文件清单（**git 感知**，2026-09-15 修正）。
 *
 * 为什么不能用 `readdir` 遍历工作树：磁盘上可能存在**被 `.gitignore` 忽略**的文件
 * （本仓实测：`tests/**.test.ts` 有 5 个），它们在 CI 的检出树里**不存在**。
 * 于是同一份代码会在开发者机器上算出 532 个测试文件、在 CI 上算出 527 个——
 * 指标不可复现，`--check` 门禁也就必然在 CI 上假红（#340 实施时由 CI 实测抓到）。
 * 指标应描述**仓库**，而非某个人的工作树。
 *
 * 口径：`git ls-files --cached --others --exclude-standard` = 已跟踪 ∪ 未跟踪但未被忽略。
 * 含未跟踪文件是刻意的——本地刚新建、尚未 `git add` 的文件也应计入，否则「先刷新基线、
 * 再提交」的顺序会漏掉它；排除被忽略者则堵住上面那条不可复现的路径。
 *
 * @param {string} dir 绝对目录
 * @param {string[]} exts 扩展名后缀（如 `[".ts", ".tsx"]`）
 * @returns {string[]} 绝对路径（升序）
 */
export function listFiles(dir, exts) {
  const relDir = relative(ROOT, dir);
  if (relDir.startsWith("..")) return [];
  const prefix = relDir === "" || relDir === "." ? "" : `${relDir}/`;
  const listing = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", relDir || "."],
    {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  return listing
    .split("\0")
    .filter(Boolean)
    .filter(p => p.startsWith(prefix))
    .filter(p => exts.some(x => p.endsWith(x)) && !p.endsWith(".d.ts"))
    .filter(p => !p.split("/").some(seg => seg.startsWith(".") || EXCLUDE_DIRS.has(seg)))
    .filter(p => !isPathExcluded(p))
    .map(p => join(ROOT, p))
    .sort();
}

function readLines(file) {
  try {
    return readFileSync(file, "utf8").split("\n");
  } catch {
    return [];
  }
}

function countLines(files) {
  return files.reduce((acc, f) => acc + readLines(f).length, 0);
}

function topFiles(files, limit) {
  return files
    .map(f => ({ file: relative(ROOT, f), lines: readLines(f).length }))
    .sort((a, b) => b.lines - a.lines)
    .slice(0, limit);
}

/** 用 TS compiler API 找单函数超过阈值的 god function。 */
async function godFunctions(files) {
  const t = await initTs();
  const result = [];
  for (const f of files) {
    if (!f.endsWith(".ts") && !f.endsWith(".tsx")) continue;
    const src = readFileSync(f, "utf8");
    const kind = f.endsWith(".tsx") ? t.ScriptKind.TSX : t.ScriptKind.TS;
    const rel = relative(ROOT, f);
    const sf = t.createSourceFile(rel, src, t.ScriptTarget.Latest, true, kind);
    const walk = (node, varHint) => {
      if (!node) return;
      let isFn = false;
      let name = null;
      let kindName = "fn";
      if (t.isFunctionDeclaration(node)) {
        isFn = true;
        name = node.name?.text ?? "(anonymous)";
        kindName = "function";
      } else if (t.isMethodDeclaration(node)) {
        isFn = true;
        name = node.name?.getText(sf) ?? "(anonymous)";
        kindName = "method";
      } else if (t.isFunctionExpression(node)) {
        isFn = true;
        name = node.name?.text ?? varHint ?? "(anonymous)";
        kindName = "expression";
      } else if (t.isArrowFunction(node)) {
        isFn = true;
        name = varHint ?? "(anonymous)";
        kindName = "arrow";
      }
      if (isFn) {
        const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
        const len = end - start + 1;
        if (len >= GOD_FN_THRESHOLD) {
          result.push({ file: rel, name, line: start, length: len, kind: kindName });
        }
      }
      if (t.isVariableDeclaration(node)) {
        const declName = node.name?.getText(sf);
        t.forEachChild(node, c => walk(c, declName));
      } else {
        t.forEachChild(node, c => walk(c, null));
      }
    };
    walk(sf, null);
  }
  return result.sort((a, b) => b.length - a.length);
}

function moduleOf(file) {
  const parts = relative(ROOT, file).split("/");
  if (parts[0] === "src" && parts[1]) return parts[1];
  if (parts[0] === "ui" && parts[1]) return "ui/" + parts[1];
  if (parts[0] === "tests") return "tests";
  if (parts[0] === "scripts") return "scripts";
  return parts[0] ?? "?";
}

function grepCountByModule(files, pattern) {
  const perModule = {};
  let total = 0;
  for (const f of files) {
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f)) continue;
    let src;
    try {
      src = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const matches = src.match(pattern);
    const c = matches ? matches.length : 0;
    if (c === 0) continue;
    total += c;
    const mod = moduleOf(f);
    perModule[mod] = (perModule[mod] ?? 0) + c;
  }
  return { total, perModule };
}

/**
 * 类型逃逸（精确口径，2026-09-11 C42 落地；2026-09-15 补 `as unknown as` 口径）。
 *
 * 旧实现是裸正则（`: any | as any | <any> | any[]`），两个方向都不准：
 *   - **高估**：把注释/字符串里的英文单词 "any" 计入（如 `SnipEngine.ts:64` 的 "any tool_call"）；
 *   - **低估**：漏掉泛型位 `Record<string, any>`（该处文本是 `, any>`，不含 `: any`）。
 * 故改用 TS AST 统计 `AnyKeyword` 节点（只算真正的类型位），指令类
 * （`@ts-expect-error` / `@ts-ignore`）另行计数——两者合起来即 C40 采用的三口径。
 *
 * **2026-09-15（issue #339）**：上列三口径全都在「类型位 / 指令」上，而 `x as unknown as T`
 * 双重断言**两类痕迹都不留**（它既不是 `AnyKeyword` 节点，也不是 `@ts-` 指令），实测仓内
 * 329 处却一处未被计入——仪表盘因此把「类型纪律很好」（any 仅 3 处）与「329 处绕开全部
 * 类型检查」并列呈现，直接误导排期。现单立 `asUnknownAs` 口径（**不与 any 合并计数**：
 * 两者治理成本与语境不同）。详见 `docs/technical-debt/README.md` §指标口径说明。
 */
async function scanTypeEscapes(files) {
  const t = await initTs();
  const items = [];
  const asUnknownAsItems = [];
  for (const f of files) {
    if (!f.endsWith(".ts") && !f.endsWith(".tsx")) continue;
    const src = readFileSync(f, "utf8");
    const kind = f.endsWith(".tsx") ? t.ScriptKind.TSX : t.ScriptKind.TS;
    const rel = relative(ROOT, f);
    const sf = t.createSourceFile(rel, src, t.ScriptTarget.Latest, true, kind);
    const lineAt = pos => sf.getLineAndCharacterOfPosition(pos).line + 1;
    const visit = node => {
      if (node.kind === t.SyntaxKind.AnyKeyword)
        items.push({ file: rel, line: lineAt(node.getStart(sf)), kind: "any" });
      if (isDoubleAssertionThroughUnknown(node, t))
        asUnknownAsItems.push({ file: rel, line: lineAt(node.getStart(sf)), kind: "as-unknown-as" });
      t.forEachChild(node, visit);
    };
    visit(sf);
    for (const m of src.matchAll(/@ts-(?:expect-error|ignore)\b/g)) {
      items.push({ file: rel, line: src.slice(0, m.index).split("\n").length, kind: m[0] });
    }
  }
  return {
    total: items.length,
    perModule: perModuleOf(items),
    items,
    asUnknownAs: {
      total: asUnknownAsItems.length,
      perModule: perModuleOf(asUnknownAsItems),
      items: asUnknownAsItems,
    },
  };
}

/** 把逐处命中按模块聚合（`src/foo/bar.ts` → `foo`）。 */
export function perModuleOf(items) {
  const perModule = {};
  for (const it of items) {
    const mod = moduleOf(join(ROOT, it.file));
    perModule[mod] = (perModule[mod] ?? 0) + 1;
  }
  return perModule;
}

/** 剥掉语义透明的括号包装：`(x as unknown) as T` 与 `x as unknown as T` 等价。 */
function unwrapParens(node, ts) {
  let n = node;
  while (n?.kind === ts.SyntaxKind.ParenthesizedExpression) n = n.expression;
  return n;
}

/**
 * 是否为「经 unknown 的双重断言」`x as unknown as T`。
 *
 * 为什么单独成指标：`any` 至少会**传染**、也还能被 lint 规则捕获，而双重断言一次性
 * 绕开全部类型检查且不留类型位痕迹——它是**更强**的逃逸（issue #339）。
 *
 * 判定走 AST 而非正则：`AsExpression` 的 expression 仍是 `AsExpression`，且内层
 * `type` 为 `unknown`。括号是透明包装，故先剥 `ParenthesizedExpression`。
 * 两个刻意的排除：
 *   - **单次 `as unknown`**（仅把值加宽到 unknown）不越检查，**不算**；
 *   - 三元及以上的串联断言（`as unknown as unknown as T`）只在**最外一层**计数，
 *     故对递归命中的内层加一道负向守卫，避免同一个表达式被重复计入。
 *
 * @param {import("typescript").Node} node
 * @param {typeof import("typescript")} ts
 * @returns {boolean}
 */
export function isDoubleAssertionThroughUnknown(node, ts) {
  if (node?.kind !== ts.SyntaxKind.AsExpression) return false;
  const inner = unwrapParens(node.expression, ts);
  if (inner?.kind !== ts.SyntaxKind.AsExpression) return false;
  if (inner.type?.kind !== ts.SyntaxKind.UnknownKeyword) return false;
  return !isDoubleAssertionThroughUnknown(inner, ts);
}

/**
 * 无参 catch 的注释卫生（C41 口径，2026-09-11 并入本工具）。
 *
 * `catch {`（未绑定错误变量）**本身不是缺陷**：仓内 try 体几乎全是 `JSON.parse` / `fs.*` /
 * `new URL`，删掉 try 会改变行为，改写成 `catch (e)` 只影响计数不影响语义。真正的隐患是
 * **没有任何意图说明**的静默回退，故这里统计「无注释的无参 catch」，而不是总数。
 *
 * 判定「已注释」的三种形态（任一命中即视为已说明）：
 *   1. catch 行内   —— `catch { // 凭据缺失 → 视为未配置`
 *   2. catch 上一行 —— 整行为注释
 *   3. 体内         —— 独立注释行，或代码行尾注释（`return null; // 缓存损坏 → 失效重扫`）
 */
function scanNoParamCatch(files) {
  const rows = [];
  for (const f of files) {
    const lines = readLines(f);
    const rel = relative(ROOT, f);
    for (let i = 0; i < lines.length; i++) {
      const m = /\bcatch\s*\{/.exec(lines[i]);
      if (!m) continue;
      const tail = lines[i].slice(m.index + m[0].length);
      const inlineComment = tail.includes("//") || tail.includes("/*");
      const prevLineComment = /^\s*(\/\/|\/\*|\*)/.test(lines[i - 1] ?? "");
      let depth = 1;
      let bodyComment = false;
      for (let j = i; j < lines.length && depth > 0; j++) {
        const seg = j === i ? tail : lines[j];
        let seen = "";
        for (let k = 0; k < seg.length; k++) {
          const ch = seg[k];
          if (ch === "{") depth++;
          else if (ch === "}") {
            depth--;
            if (depth === 0) break;
          }
          seen += ch;
        }
        if (seen.includes("//") || seen.includes("/*")) bodyComment = true;
      }
      rows.push({ file: rel, line: i + 1, documented: inlineComment || prevLineComment || bodyComment });
    }
  }
  const perModule = {};
  let documented = 0;
  for (const r of rows) {
    if (r.documented) documented += 1;
    const mod = moduleOf(join(ROOT, r.file));
    perModule[mod] = (perModule[mod] ?? 0) + 1;
  }
  return { total: rows.length, documented, undocumented: rows.length - documented, perModule };
}

/** 检测 ui/server→src 深层导入、src→ui 导入、edgeclaw 编译产物导入。 */
function boundaryChecks() {
  const uiServerFiles = listFiles(join(ROOT, "ui/server"), [".js", ".mjs", ".ts"]);
  const srcFiles = listFiles(join(ROOT, "src"), [".ts", ".tsx"]);
  const collect = (files, re) => {
    const out = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(re)) {
        const line = src.slice(0, m.index).split("\n").length;
        out.push({ file: relative(ROOT, f), line, match: m[0].trim() });
      }
    }
    return out;
  };
  const uiServerToSrc = collect(uiServerFiles, /from\s+['"]\s*(\.\.\/)+src\//g);
  const srcToUi = collect(srcFiles, /from\s+['"][^'"]*(?:\/ui\/|@\/ui)/g);
  const edgeclawLib = collect(uiServerFiles, /from\s+['"][^'"]*edgeclaw-memory-core\/lib\//g);
  return {
    uiServerToSrcCount: uiServerToSrc.length,
    uiServerToSrcDeepImports: uiServerToSrc,
    srcToUiCount: srcToUi.length,
    srcToUiImports: srcToUi,
    edgeclawLibCount: edgeclawLib.length,
    edgeclawLibCompiledImports: edgeclawLib,
  };
}

function testCoverage() {
  const srcDirs = readdirSync(join(ROOT, "src"), { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);
  const perModule = {};
  for (const m of srcDirs) {
    const testDir = join(ROOT, "tests", m);
    if (existsSync(testDir)) {
      const c = listFiles(testDir, [".spec.ts", ".test.ts"]).length;
      if (c > 0) perModule[m] = c;
    }
  }
  return {
    perModule: Object.fromEntries(Object.entries(perModule).sort((a, b) => b[1] - a[1])),
    total: Object.values(perModule).reduce((a, b) => a + b, 0),
  };
}

function flattenKeys(obj, prefix = "") {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) keys.push(...flattenKeys(v, key));
    else keys.push(key);
  }
  return keys;
}

function i18nDiff() {
  const enDir = join(ROOT, "ui/src/i18n/locales/en");
  const zhDir = join(ROOT, "ui/src/i18n/locales/zh-CN");
  if (!existsSync(enDir) || !existsSync(zhDir)) return null;
  const out = [];
  for (const name of readdirSync(enDir).filter(x => x.endsWith(".json"))) {
    const enPath = join(enDir, name);
    const zhPath = join(zhDir, name);
    if (!existsSync(zhPath)) continue;
    const en = JSON.parse(readFileSync(enPath, "utf8"));
    const zh = JSON.parse(readFileSync(zhPath, "utf8"));
    const enKeys = new Set(flattenKeys(en));
    const zhKeys = new Set(flattenKeys(zh));
    out.push({
      namespace: name.replace(/\.json$/, ""),
      enKeys: enKeys.size,
      zhKeys: zhKeys.size,
      missingZh: [...enKeys].filter(k => !zhKeys.has(k)).length,
      missingEn: [...zhKeys].filter(k => !enKeys.has(k)).length,
    });
  }
  return { namespaces: out.map(x => x.namespace), namespacesDetails: out };
}

// 知识卡逐字节重复检测：按内容哈希分组 wiki 下全部 md。
// 背景：TD-KNOWLEDGE-N08（2026-08-27）曾出现整棵嵌套重复目录树（205 个文件逐字节相同），
// 该指标用于防止复发——组数/重复文件数/重复字节数任一非零即值得人工下钻。
function knowledgeDupMd() {
  const wikiRoot = join(ROOT, "src", "knowledge", "patent", "wiki");
  if (!existsSync(wikiRoot)) return { groups: 0, files: 0, bytes: 0 };
  const byHash = new Map();
  // 同样走 git 感知清单：本仓 wiki 下存在被 .gitignore 忽略的 md，
  // 用 readdir 遍历会让本机与 CI 的「重复组数」不一致（#340 实施时实测 72 vs 70）。
  for (const p of listFiles(wikiRoot, [".md"])) {
    const buf = readFileSync(p);
    const h = createHash("sha256").update(buf).digest("hex");
    if (!byHash.has(h)) byHash.set(h, []);
    byHash.get(h).push(p);
  }
  let groups = 0;
  let files = 0;
  let bytes = 0;
  for (const paths of byHash.values()) {
    if (paths.length < 2) continue;
    groups += 1;
    // 记「冗余份数」：每组可删的最小副本数（n-1），体积同比例计
    const sorted = paths.sort((a, b) => a.length - b.length || a.localeCompare(b));
    for (const dup of sorted.slice(1)) {
      files += 1;
      bytes += readFileSync(dup).length;
    }
  }
  return { groups, files, bytes };
}

export async function measure() {
  // 扫描作用域按 SCOPE_DOC 展开（此前全部只用 allSrcForScan = src/）
  const jsLike = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

  // `src/` 先取全量再分流（#341）：过滤掉的文件不是「不存在」，而是**单列**在
  // `vendored` 分组里由 `renderMarkdown` 单独成节——若直接把它们从扫描集里删掉，
  // 「已单列」与「该目录已被移除」在输出上不可区分。
  const srcScanAll = listFiles(join(ROOT, "src"), jsLike);
  const srcScan = srcScanAll.filter(f => !isVendored(relative(ROOT, f)));
  const vendoredFiles = srcScanAll.filter(f => isVendored(relative(ROOT, f)));
  const srcFiles = srcScan.filter(f => f.endsWith(".ts") || f.endsWith(".tsx"));
  const srcJsFiles = srcScan.filter(f => !f.endsWith(".ts") && !f.endsWith(".tsx"));

  const testsFiles = listFiles(join(ROOT, "tests"), [".ts", ".tsx", ".js"]);
  // `ui/src` 的 `.js` / `.jsx`（9 个）此前不在任何文件级扫描里（C39 登记、#530 修复）：
  // 它们是产品源码（`main.jsx`、`contexts/*.jsx`、`i18n/config.js`、`utils/api.js` 等），
  // 漏掉会让 catch / TODO / 行数三处同时少算——而 `console` 口径早就含 `ui/server` 的 .js，
  // 两套口径自相矛盾。`godFunctions` / `scanTypeEscapes` 自身按扩展名跳过非 TS 文件，不受影响。
  const uiSrcFiles = listFiles(join(ROOT, "ui/src"), [".ts", ".tsx", ".js", ".jsx"]);
  const uiServerFiles = listFiles(join(ROOT, "ui/server"), [".js", ".mjs", ".ts"]);
  const uiServerScan = listFiles(join(ROOT, "ui/server"), jsLike);
  const testsScan = listFiles(join(ROOT, "tests"), jsLike);
  // catch 口径含 ui/server（2026-09-16 · #341）。`catchEmpty` 与 `catchNoParam` 共用本集合，
  // 所以两者要么一起含 ui/server、要么一起漏——这正是本 issue 要消除的「口径自相矛盾」。
  const productCatchFiles = [...srcFiles, ...uiSrcFiles, ...uiServerScan].filter(f => !isTestFile(f));
  const consoleFiles = [...srcFiles, ...srcJsFiles, ...uiServerScan].filter(
    f => !SANCTIONED_CONSOLE_ENTRIES.has(relative(ROOT, f)),
  );

  // vendored 子包整体移出文件级指标，但**单列**报告自身规模与 Top 文件（#341）：
  // 「已单列」与「该目录已被删除」必须在输出上可区分，否则口径变更会静默变成数据丢失。
  const vendored = {
    subtrees: VENDORED_SUBTREES,
    files: vendoredFiles.length,
    lines: countLines(vendoredFiles),
    topFiles: topFiles(vendoredFiles, VENDORED_TOP_LIMIT),
    godFunctionCount: 0,
  };

  // God function 与「Top 大文件」同口径：一次扫描后分组，不扫两遍——两侧来自同一份 AST，
  // 口径不会各自漂移。
  const srcTsAll = srcScanAll.filter(f => f.endsWith(".ts") || f.endsWith(".tsx"));
  const godAll = await godFunctions([...srcTsAll, ...uiSrcFiles]);
  const god = godAll.filter(g => !isVendored(g.file));
  vendored.godFunctionCount = godAll.filter(g => isVendored(g.file)).length;

  return {
    date: new Date().toISOString().slice(0, 10),
    scopes: SCOPE_DOC,
    stats: {
      srcTsFiles: srcFiles.length,
      srcTsLines: countLines(srcFiles),
      srcJsFiles: srcJsFiles.length,
      testsFiles: testsFiles.length,
      uiSrcFiles: uiSrcFiles.length,
      uiSrcLines: countLines(uiSrcFiles),
      uiServerFiles: uiServerFiles.length,
      uiServerLines: countLines(uiServerFiles),
    },
    topFiles: topFiles([...srcFiles, ...uiSrcFiles, ...uiServerFiles], TOP_FILES_LIMIT),
    vendored,
    godFunctions: { threshold: GOD_FN_THRESHOLD, count: god.length, items: god },
    unsafe: await scanTypeEscapes([...srcFiles, ...uiSrcFiles]),
    console: grepCountByModule(consoleFiles, CONSOLE_PATTERN),
    catchEmpty: grepCountByModule(productCatchFiles, EMPTY_CATCH_PATTERN),
    catchNoParam: scanNoParamCatch(productCatchFiles),
    todos: grepCountByModule([...srcFiles, ...srcJsFiles, ...uiSrcFiles, ...uiServerScan, ...testsScan], TODO_PATTERN),
    boundaries: boundaryChecks(),
    tests: testCoverage(),
    i18n: i18nDiff(),
    knowledgeDupMd: knowledgeDupMd(),
  };
}

function topModules(perModule, n = 3) {
  const entries = Object.entries(perModule)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
  if (entries.length === 0) return "—";
  return entries.map(([m, c]) => `${m}(${c})`).join(" · ");
}

function renderMarkdown(m) {
  const L = [];
  L.push(`# Sati 技术债务指标基线与趋势`);
  L.push(``);
  L.push(`> 由 \`node scripts/measure-techdebt.mjs --update\` 自动生成，谨防手工编辑。`);
  L.push(`> 最近一次快照：**${m.date}**`);
  L.push(``);
  L.push(`## 规模`);
  L.push(``);
  L.push(`| 维度 | 值 |`);
  L.push(`|---|---|`);
  L.push(`| src TS 文件 / 行数 | ${m.stats.srcTsFiles} / ${m.stats.srcTsLines} |`);
  L.push(`| src JS 文件 | ${m.stats.srcJsFiles} |`);
  L.push(`| tests 文件 | ${m.stats.testsFiles} |`);
  L.push(`| ui/src 文件 / 行数 | ${m.stats.uiSrcFiles} / ${m.stats.uiSrcLines} |`);
  L.push(`| ui/server 文件 / 行数 | ${m.stats.uiServerFiles} / ${m.stats.uiServerLines} |`);
  L.push(``);
  L.push(`## 指标口径`);
  L.push(``);
  L.push(`| 指标 | 作用域 |`);
  L.push(`|---|---|`);
  for (const [k, v] of Object.entries(m.scopes)) L.push(`| ${k} | ${v} |`);
  L.push(``);
  L.push(`## 异味指标（越少越好）`);
  L.push(``);
  L.push(`| 指标 | 总量 | 热点模块 |`);
  L.push(`|---|---|---|`);
  L.push(`| \`any\`/\`@ts-expect-error\`/\`@ts-ignore\` | ${m.unsafe.total} | ${topModules(m.unsafe.perModule)} |`);
  L.push(
    `| \`as unknown as\`（双重断言） | ${m.unsafe.asUnknownAs.total} | ${topModules(m.unsafe.asUnknownAs.perModule)} |`,
  );
  L.push(`| 裸 \`console.*\` | ${m.console.total} | ${topModules(m.console.perModule)} |`);
  L.push(`| 空 \`catch {}\` | ${m.catchEmpty.total} | ${topModules(m.catchEmpty.perModule)} |`);
  L.push(`| 无参 \`catch {\`（总计） | ${m.catchNoParam.total} | ${topModules(m.catchNoParam.perModule)} |`);
  L.push(`| ↳ **无注释**（隐患类，目标） | **${m.catchNoParam.undocumented}** | — |`);
  L.push(`| ↳ 已带意图注释 | ${m.catchNoParam.documented} | — |`);
  L.push(`| \`TODO/HACK/FIXME/XXX\` | ${m.todos.total} | ${topModules(m.todos.perModule)} |`);
  L.push(`| 分层违规 \`ui/server→src\` | ${m.boundaries.uiServerToSrcCount} | — |`);
  L.push(`| 分层违规 \`src→ui\` | ${m.boundaries.srcToUiCount} | — |`);
  L.push(`| edgeclaw \`lib\` 编译产物直连 | ${m.boundaries.edgeclawLibCount} | — |`);
  L.push(
    `| 知识卡逐字节重复（组 / 冗余文件 / 冗余字节） | ${m.knowledgeDupMd.groups} 组 · ${m.knowledgeDupMd.files} 文件 · ${m.knowledgeDupMd.bytes} B | — |`,
  );
  L.push(``);
  L.push(`## God function（单函数 ≥ ${m.godFunctions.threshold} 行）`);
  L.push(``);
  if (m.godFunctions.items.length === 0) L.push(`无。`);
  else {
    L.push(`| 文件 | 函数 | 行 | 类型 |`);
    L.push(`|---|---|---|---|`);
    for (const g of m.godFunctions.items) L.push(`| \`${g.file}\` | \`${g.name}\` | ${g.length} | ${g.kind} |`);
  }
  L.push(``);
  L.push(`## Top ${m.topFiles.length} 大文件`);
  L.push(``);
  L.push(`| 文件 | 行 |`);
  L.push(`|---|---|`);
  for (const f of m.topFiles) L.push(`| \`${f.file}\` | ${f.lines} |`);
  L.push(``);
  L.push(`## vendored 子包（单列，不计入上述规模与排名）`);
  L.push(``);
  L.push(
    `> ${m.vendored.subtrees.map(p => `\`${p}\``).join(" · ")} 是从外部项目整体搬入的记忆内核` +
      `（自带 \`package.json\` / \`tsconfig\` / 独立 \`build\`·\`test\`），本仓不参与其演进。` +
      `按 #341 从**规模 / Top 大文件 / God function** 三处整体移出，在此单列以免丢失可见度。`,
  );
  L.push(``);
  L.push(`| 子包 | 文件 | 行 | ≥ ${m.godFunctions.threshold} 行函数 |`);
  L.push(`|---|---|---|---|`);
  L.push(
    `| ${m.vendored.subtrees.map(p => `\`${p}\``).join(" · ")} | ${m.vendored.files} | ${m.vendored.lines} | ${m.vendored.godFunctionCount} |`,
  );
  L.push(``);
  if (m.vendored.topFiles.length === 0) L.push(`无。`);
  else {
    L.push(`其自身 Top ${m.vendored.topFiles.length} 大文件（**不参与**上方排名）：`);
    L.push(``);
    L.push(`| 文件 | 行 |`);
    L.push(`|---|---|`);
    for (const f of m.vendored.topFiles) L.push(`| \`${f.file}\` | ${f.lines} |`);
  }
  L.push(``);
  L.push(`## 测试覆盖（tests/<模块> 文件数）`);
  L.push(``);
  L.push(`| 模块 | 测试文件 |`);
  L.push(`|---|---|`);
  for (const [mod, c] of Object.entries(m.tests.perModule)) L.push(`| ${mod} | ${c} |`);
  L.push(``);
  L.push(`| **合计** | **${m.tests.total}** |`);
  L.push(``);
  if (m.i18n) {
    L.push(`## i18n en/zh-CN 对齐`);
    L.push(``);
    L.push(`| namespace | en keys | zh keys | 缺 zh | 缺 en |`);
    L.push(`|---|---|---|---|---|`);
    for (const ns of m.i18n.namespacesDetails)
      L.push(`| ${ns.namespace} | ${ns.enKeys} | ${ns.zhKeys} | ${ns.missingZh} | ${ns.missingEn} |`);
    L.push(``);
  }
  return L.join("\n");
}

function writeIf(args, content) {
  const idx = args.indexOf("--update");
  if (idx === -1) return false;
  const path = args[idx + 1];
  if (!path) {
    console.error("--update 需要目标路径参数");
    process.exit(2);
  }
  const full = path.startsWith("/") ? path : join(ROOT, path);
  let existing = "";
  if (existsSync(full)) existing = readFileSync(full, "utf8");
  const history = extractHistory(existing);
  const doc = `${content}\n\n## 历史快照\n\n${history}`;
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, doc, "utf8");
  return true;
}

function extractHistory(existing) {
  const idx = existing.indexOf("## 历史快照");
  if (idx === -1) return "";
  return existing.slice(idx + "## 历史快照".length).trim();
}

/**
 * 基线新鲜度校验用的一行式快照时间戳。
 * 必须挡住它，否则「今天生成的基线明天在 CI 里跑」会无条件变红——时间戳不是内容。
 */
const SNAPSHOT_DATE_RE = />\s*最近一次快照：\*\*\d{4}-\d{2}-\d{2}\*\*/;

/**
 * 把 `metrics.md` 归一化为「可比较的正文」：去掉历史快照段与快照时间戳。
 * `--update` 写入的是 `<正文>\n\n## 历史快照\n\n<历史>`，故历史段不属于本次内容。
 * @param {string} markdown
 * @returns {string}
 */
export function normalizeForCheck(markdown) {
  const bodyEnd = markdown.indexOf("## 历史快照");
  const body = bodyEnd === -1 ? markdown : markdown.slice(0, bodyEnd);
  return body.replace(SNAPSHOT_DATE_RE, "> 最近一次快照：**<date>**").trimEnd();
}

/**
 * 逐行比较两段正文，返回「快照缺少」与「快照多余」的行（多重集口径，不依赖行序）。
 *
 * 用多重集而非按下标逐行比：`--update` 是整篇重写，一行插入会让其后所有行错位，
 * 按下标比会报出满屏假差异，反而看不出真正变了什么。
 *
 * @param {string} actualBody 磁盘上基线文件的正文
 * @param {string} expectedBody 依当前工作树重算出的正文
 * @returns {{ missing: string[], extra: string[] }}
 */
export function metricBodyDiff(actualBody, expectedBody) {
  const counts = new Map();
  for (const line of actualBody.split("\n")) counts.set(line, (counts.get(line) ?? 0) + 1);
  const missing = [];
  for (const line of expectedBody.split("\n")) {
    const n = counts.get(line) ?? 0;
    if (n > 0) counts.set(line, n - 1);
    else missing.push(line);
  }
  const extra = [];
  for (const [line, n] of counts) for (let i = 0; i < n; i++) extra.push(line);
  return { missing, extra };
}

/** `--check` 的失败指引：如何把基线刷回与工作树一致。 */
const METRICS_REFRESH_HINT =
  "node scripts/measure-techdebt.mjs --update docs/technical-debt/metrics.md\n" + "  （等价于 pnpm measure:update）";

/**
 * 基线新鲜度校验（issue #340）：把当前工作树的**重算结果**与磁盘上的基线正文比对，
 * 不一致即非 0 退出。挂到 `pnpm lint` 链尾，使「基线静默失真」不再可能——
 * 2026-09-14 的审计实证过其后果：基线停在 09-11，`createLocalGateway.ts` 声称
 * 2696 行而实际 448 行，四条 god function 早已不存在，排期却仍照旧数字定。
 *
 * 比的是**整篇正文**（而非少数几个数）：正文全部由本脚本生成，全量比对既最简单也最严，
 * 且新增指标时无需同步维护「关键指标白名单」——白名单本身就会再次成为漂移点。
 */
export function checkFreshness(targetPath, renderedBody) {
  const full = targetPath.startsWith("/") ? targetPath : join(ROOT, targetPath);
  if (!existsSync(full)) {
    console.error(`✗ 指标基线不存在：${targetPath}`);
    console.error(`  请先生成：\n  ${METRICS_REFRESH_HINT}`);
    process.exitCode = 1;
    return;
  }
  const { missing, extra } = metricBodyDiff(
    normalizeForCheck(readFileSync(full, "utf8")),
    normalizeForCheck(renderedBody),
  );
  if (missing.length === 0 && extra.length === 0) {
    console.log(`✓ 指标基线新鲜：${targetPath} 与当前工作树一致`);
    return;
  }

  const show = lines => lines.slice(0, 10).map(l => `      ${l}`);
  console.error(`✗ 指标基线已过期：${targetPath} 与当前工作树不一致。`);
  console.error(`  基线缺少 ${missing.length} 行（当前工作树应写入）：`);
  for (const l of show(missing)) console.error(l);
  if (missing.length > 10) console.error(`      … 另有 ${missing.length - 10} 行`);
  console.error(`  基线多余 ${extra.length} 行（当前工作树已不再产生）：`);
  for (const l of show(extra)) console.error(l);
  if (extra.length > 10) console.error(`      … 另有 ${extra.length - 10} 行`);
  console.error("");
  console.error(`  修复：\n  ${METRICS_REFRESH_HINT}`);
  console.error("  说明：指标口径变更（如新增指标行）同样会让基线变红——这是有意的，");
  console.error("       口径变更须与基线刷新在同一个 PR 内落地。");
  process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2);
  const m = await measure();

  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify(m, null, 2) + "\n");
    return;
  }
  const md = renderMarkdown(m);

  const checkIdx = args.indexOf("--check");
  if (checkIdx !== -1) {
    checkFreshness(args[checkIdx + 1] ?? DEFAULT_METRICS_PATH, md);
    return;
  }

  if (writeIf(args, md)) {
    console.log(`metrics 已写入 ${args[args.indexOf("--update") + 1]}`);
    return;
  }
  process.stdout.write(md + "\n");
}

// 仅当直接以脚本运行时执行 CLI 逻辑；被 import 时（如 scripts/measure-techdebt.test.mjs）
// 不触发度量与输出。纯函数（perModuleOf / isDoubleAssertionThroughUnknown）可被单测直接引用。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
