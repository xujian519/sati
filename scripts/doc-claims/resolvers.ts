/**
 * 文档事实层解析器（doc-claims）。
 *
 * 每一条 claim = 一个「文档里会被写死、且会随代码变化」的事实 + 一个从代码现算的
 * 解析器。`scripts/gen-doc-claims.ts` 用它生成 `docs/code-facts.md`，并回填/校验
 * 叙述性文档里的 marker（`<!-- claim:id -->值<!-- /claim -->`）。
 *
 * 设计约束：
 *   - 解析器**只读取既有门禁的产物或运行期真值**，不重复实现其它门禁的校验逻辑
 *     （协议版本来自 `version.ts` 模块值；事件数来自 `docs/event-producer-consumer.md`
 *     的行数，而该文件本身有 `check:event-matrix` 保真）；
 *   - 工具数一律取**运行期注册结果**（`createBuiltinRegistry()`），不靠 AST 计数模拟
 *     条件分支——AST 只能近似，运行期是事实；
 *   - 新增 `src/` 模块若未在 `MODULE_NOTES` 登记，`src_module_list` 解析即抛错，
 *     迫使文档索引与代码同 PR 更新（这正是过去漏列 5 个模块的成因）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_METHOD_VERSION, PROTOCOL_RELEASES } from "../../src/gateway/protocol/version.js";
import { createBuiltinRegistry } from "../../src/tool/registry/createBuiltinRegistry.js";

/**
 * 仓库根：从本文件所在目录向上找到含 `pnpm-workspace.yaml` 的目录。
 * 不能按层数写死——同一份代码既可能从 `scripts/doc-claims/`（tsx 直跑）也可能从
 * `dist/scripts/doc-claims/`（`pnpm test` 跑编译产物）加载，层数差一层。
 */
export const REPO_ROOT = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml")) && existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repo root not found (no pnpm-workspace.yaml ancestor)");
    dir = parent;
  }
})();

export type DocClaim = {
  id: string;
  /** 人类可读的一行说明（生成文档的表格用）。 */
  label: string;
  /** 解析来源，报错时提示人工核查方向。 */
  sources: string[];
  resolve: () => string;
};

function readText(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readText(relativePath)) as Record<string, unknown>;
}

function dirEntries(relativePath: string): string[] {
  return readdirSync(join(REPO_ROOT, relativePath)).sort();
}

function subdirectories(relativePath: string): string[] {
  return dirEntries(relativePath).filter(entry => statSync(join(REPO_ROOT, relativePath, entry)).isDirectory());
}

function filesWithSuffix(root: string, suffix: string): string[] {
  const out: string[] = [];
  const walk = (relative: string): void => {
    for (const entry of dirEntries(relative)) {
      const child = `${relative}/${entry}`;
      if (statSync(join(REPO_ROOT, child)).isDirectory()) walk(child);
      else if (entry.endsWith(suffix)) out.push(child);
    }
  };
  walk(root);
  return out;
}

/**
 * 按 **git 清单**列出 `root` 下的源文件（`git ls-files --cached --others --exclude-standard`）。
 *
 * 为什么文件系统遍历在这条 claim 上不可用（#520）：`readdirSync` 递归不会跳过忽略目录，
 * 于是「`src/<模块>/` 的 .ts/.tsx 文件数」把**依赖类型声明**（`node_modules/**`）与
 * **编译产物**（`*.d.ts`，如 vendored 子包的 `lib/**`）算成模块源码——同一份代码在
 * 「干净检出 / 只装了依赖 / 子包也 build 过」三种环境分别算出 98 / 280 / 316。
 * 事实层因此既不是模块规模，又随本机环境漂移；而「让门禁变绿」的顺手做法是把本机环境写回
 * 仓库，下一个人再撞一次。
 *
 * 口径与 `scripts/measure-techdebt.mjs` 的 `listFiles()` **同源**（同一条 git 命令、同样排除
 * `.d.ts`、同样跳过点开头目录段与忽略目录）：那边自 #340 起就是 git 感知的（本机 = CI），
 * 这里把它对齐过来，也符合 AGENTS.md「按 `git ls-files` 统计」的既有声明。**刻意不 import
 * 那个实现**——它是 `.mjs`（不进 `tsc` 产物），而本文件既可能从 `scripts/doc-claims/`（tsx 直跑）
 * 也可能从 `dist/scripts/doc-claims/`（编译产物）加载，跨文件引用会在 dist 下解析失败。
 *
 * 注意：git 口径含「未跟踪但未被忽略」的文件 ⇒ 本地新增一个未 `git add` 的 `.ts` 会即时改变
 * 计数。这与 `measure-techdebt` 的行为一致，是刻意对齐而非缺陷（见本 PR 的决策记录）。
 */
function gitListedFiles(root: string, suffixes: string[]): string[] {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const listing = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", root], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return listing
    .split("\0")
    .filter(Boolean)
    .filter(path => path.startsWith(prefix))
    .filter(path => suffixes.some(suffix => path.endsWith(suffix)) && !path.endsWith(".d.ts"))
    .filter(path => !path.split("/").some(segment => segment.startsWith(".")))
    .sort();
}

function packageJson(): Record<string, unknown> {
  return readJson("package.json");
}

const registry = createBuiltinRegistry();
let cachedTools: ReturnType<typeof registry.list> | undefined;
function tools(): ReturnType<typeof registry.list> {
  cachedTools ??= registry.list();
  return cachedTools;
}

/**
 * `src/` 模块 → 一行职责。**新增模块必须在此登记**（否则 `src_module_list` 直接抛错），
 * 这样模块索引不可能漏列——过去 `board/browser/fs/runtime/shared` 五个模块长期不在
 * 任何指南里，正是"手写清单 + 无门禁"的后果。
 */
const MODULE_NOTES: Record<string, string> = {
  adapters: "IM 渠道适配器（21 个渠道 + Channel/render/SessionMapper）",
  agent: "Agent 循环、会话、子代理与团队编排",
  "always-on": "常驻后台执行（Discovery 计划/报告/工作周期）",
  board: "项目看板（protocol/runtime/storage 三组，kanban_* 工具与网关方法组）",
  browser: "浏览器后端抽象（ego lite / BrowserOS 等后端探测与驱动）",
  cli: "CLI 入口与命令（sati.ts / satiServer.ts / createLocalGateway.ts）",
  context: "上下文（压缩/预算/记忆/向量/workspace registerLeak）",
  cron: "定时任务（config/protocol/runtime/storage/tool）",
  extension: "插件系统（plugin.json、lifecycle hooks、skills、贡献点）",
  fs: "文件系统小工具（JSONL run 写入器）",
  gateway: "WebSocket 网关（protocol/server/client/approval）",
  knowledge: "知识库（图谱/判例/法规/embeddings/wiki 卡片）",
  lifecycle: "生命周期（protocol/runtime）",
  literature: "学术论文检索（arXiv/OpenAlex/Semantic Scholar/Crossref）",
  mcp: "MCP 客户端/协议/运行时",
  methodology: "方法论注册表（five-whys/mece/triz/bridge-reencode 等）",
  model: "模型抽象（providers/embedding/catalog/resolveModelInfo/streaming）",
  network: "网络层（fetch 封装）",
  patent: "专利执行管线（workflow/graph/atoms/evidence/figure/document 等）",
  permission: "权限（decision/PermissionRuntime + guard/ToolGuardRegistry）",
  pilot: "配置（PilotConfigStore / lastGoodFacts / workspace 判定）",
  router: "智能路由（含多模态媒体降级）",
  rule: "宪法规则引擎（协议/加载器/评估器/输出门禁/policy-bridge）",
  runtime: "运行时环境适配（命令 shell 解析）",
  session: "会话管理（transcript/artifacts/resume/search/storage/workspace 账本）",
  shared: "跨模块共享工具（env/paths/retry/sqlite/ttl-cache/timeouts）",
  status: "状态（agent 状态详情与可见错误体）",
  task: "后台任务存储与运行时",
  telemetry: "遥测（analytics.v2 契约）",
  "test-support": "测试基建（llm-replay 录制/重放 seam）",
  tool: "工具系统（registry/execution/audit/builtin）",
  web: "Web 服务端与浏览器客户端投影",
};

function srcModuleList(): string {
  const modules = subdirectories("src");
  const rows = modules.map(module => {
    const note = MODULE_NOTES[module];
    if (note === undefined) {
      throw new Error(
        `src/${module}/ 未在 scripts/doc-claims/resolvers.ts 的 MODULE_NOTES 登记职责——` +
          "请在登记后重新生成 docs/code-facts.md（模块索引不得漏列）",
      );
    }
    const fileCount = gitListedFiles(`src/${module}`, [".ts", ".tsx"]).length;
    const barrel = existsSync(join(REPO_ROOT, "src", module, "index.ts")) ? "✓" : "—";
    return `| \`src/${module}/\` | ${fileCount} | ${barrel} | ${note} |`;
  });
  return [
    `\`src/\` 现有 **${modules.length}** 个模块（另有根级 \`env.ts\` / \`version.ts\`）：`,
    "",
    "| 模块 | .ts/.tsx 文件数 | barrel | 职责 |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    "> 文件数按 **git 清单**统计（`git ls-files --cached --others --exclude-standard`，排除 `.d.ts`），",
    "> 与 `docs/technical-debt/metrics.md` 同口径 ⇒ 装了依赖、编没编译子包都不改变它（#520）。",
  ].join("\n");
}

/** 事件矩阵主表行数（= AgentEvent ∪ GatewayEvent ∪ TeamEvent 的事件总数）。 */
function eventMatrixRows(): number {
  const doc = readText("docs/event-producer-consumer.md").split("\n");
  const start = doc.findIndex(line => line.trim() === "| 事件 | 生产者 | 消费者 |");
  if (start < 0) throw new Error("docs/event-producer-consumer.md: 未找到事件矩阵主表表头");
  let rows = 0;
  for (let i = start + 2; i < doc.length; i += 1) {
    const line = doc[i] ?? "";
    if (!line.startsWith("|")) break;
    rows += 1;
  }
  return rows;
}

function lintGateCount(): number {
  const scripts = packageJson().scripts as Record<string, string>;
  return [...(scripts.lint ?? "").matchAll(/\bpnpm check:[a-z0-9-]+/g)].length;
}

function ciJobCount(): number {
  const lines = readText(".github/workflows/ci.yml").split("\n");
  const jobsIndex = lines.findIndex(line => /^jobs:\s*$/.test(line));
  if (jobsIndex < 0) throw new Error(".github/workflows/ci.yml: 未找到 jobs: 段");
  let count = 0;
  for (let i = jobsIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^\S/.test(line)) break;
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)) count += 1;
  }
  return count;
}

function generatedYamlFiles(): string[] {
  return dirEntries("assets/workflows/patent/generated").filter(entry => entry.endsWith(".yaml"));
}

function draftingStageCount(): number {
  const yaml = readText("assets/workflows/patent/generated/patent_drafting_v1.yaml");
  return (yaml.match(/^ {2}- id: /gm) ?? []).length;
}

export const CLAIMS: DocClaim[] = [
  {
    id: "app_version",
    label: "应用版本（根 package.json）",
    sources: ["package.json"],
    resolve: () => String(packageJson().version),
  },
  {
    id: "node_engine",
    label: "Node 版本下限",
    sources: ["package.json engines.node"],
    resolve: () => String((packageJson().engines as Record<string, string>).node),
  },
  {
    id: "pnpm_version",
    label: "pnpm 版本",
    sources: ["package.json packageManager"],
    resolve: () => String(packageJson().packageManager).replace(/^pnpm@/, ""),
  },
  {
    id: "typescript_version",
    label: "TypeScript 版本",
    sources: ["package.json devDependencies.typescript"],
    resolve: () => String((packageJson().devDependencies as Record<string, string>).typescript).replace(/^[\^~]/, ""),
  },
  {
    id: "protocol_version",
    label: "网关协议版本（台账末条）",
    sources: ["src/gateway/protocol/version.ts PROTOCOL_RELEASES"],
    resolve: () => String(PROTOCOL_RELEASES[PROTOCOL_RELEASES.length - 1]?.version),
  },
  {
    id: "protocol_release_count",
    label: "协议台账版本条目数",
    sources: ["src/gateway/protocol/version.ts PROTOCOL_RELEASES"],
    resolve: () => String(PROTOCOL_RELEASES.length),
  },
  {
    id: "gateway_method_count",
    label: "网关方法数",
    sources: ["src/gateway/protocol/version.ts PROTOCOL_METHOD_VERSION"],
    resolve: () => String(Object.keys(PROTOCOL_METHOD_VERSION).length),
  },
  {
    id: "event_total_count",
    label: "事件总数（生产者/消费者矩阵行数）",
    sources: ["docs/event-producer-consumer.md（由 check:event-matrix 保真）"],
    resolve: () => String(eventMatrixRows()),
  },
  {
    id: "default_tool_count",
    label: "默认注册工具数（无参 createBuiltinRegistry）",
    sources: ["src/tool/registry/createBuiltinRegistry.ts（运行期实例化）"],
    resolve: () => String(tools().length),
  },
  {
    id: "patent_tool_count",
    label: '专利域工具数（domain === "patent"）',
    sources: ["src/tool/registry/createBuiltinRegistry.ts（运行期实例化）"],
    resolve: () => String(tools().filter(tool => tool.domain === "patent").length),
  },
  {
    id: "channel_adapter_count",
    label: "IM 渠道适配器数",
    sources: ["src/adapters/channel/（目录数，不含 protocol/）"],
    resolve: () => String(subdirectories("src/adapters/channel").filter(name => name !== "protocol").length),
  },
  {
    id: "skill_count",
    label: "内置技能数（SKILL.md 总数）",
    sources: ["skills/**/SKILL.md"],
    resolve: () => String(filesWithSuffix("skills", "SKILL.md").length),
  },
  {
    id: "role_skill_count",
    label: "专家角色数（type: role）",
    sources: ["skills/**/SKILL.md frontmatter"],
    resolve: () =>
      String(filesWithSuffix("skills", "SKILL.md").filter(file => /^type:\s*role\s*$/m.test(readText(file))).length),
  },
  {
    id: "patent_skill_count",
    label: "专利相关技能数（patent-* 与 provision-* 技能目录）",
    sources: ["skills/ 目录命名"],
    resolve: () => {
      const dirs = subdirectories("skills");
      return String(dirs.filter(name => name.startsWith("patent-") || name.startsWith("provision-")).length);
    },
  },
  {
    id: "src_module_count",
    label: "src/ 模块数",
    sources: ["src/ 顶层目录"],
    resolve: () => String(subdirectories("src").length),
  },
  {
    id: "src_module_list",
    label: "src/ 模块索引（含一行职责）",
    sources: ["src/ 顶层目录 + resolvers.ts MODULE_NOTES"],
    resolve: srcModuleList,
  },
  {
    id: "loop_module_count",
    label: "agent/loop 模块数（.ts 文件）",
    sources: ["src/agent/loop/"],
    resolve: () => String(dirEntries("src/agent/loop").filter(name => name.endsWith(".ts")).length),
  },
  {
    id: "patent_atom_count",
    label: "内置原子数",
    sources: ["src/patent/atoms/index.ts registerBuiltinAtoms"],
    resolve: () => {
      const source = readText("src/patent/atoms/index.ts");
      return String((source.match(/globalAtomRegistry\.register\(builtin\.\w+Atom\)/g) ?? []).length);
    },
  },
  {
    id: "patent_manifest_count",
    label: "内置 patent manifest 数",
    sources: ["assets/workflows/patent/generated/*.yaml（由 check:patent-workflow-docs 保真）"],
    resolve: () => String(generatedYamlFiles().length),
  },
  {
    id: "drafting_stage_count",
    label: "patent_drafting_v1 阶段数",
    sources: ["assets/workflows/patent/generated/patent_drafting_v1.yaml"],
    resolve: () => String(draftingStageCount()),
  },
  {
    id: "lint_gate_count",
    label: "pnpm lint 链上的领域门禁数",
    sources: ["package.json scripts.lint"],
    resolve: () => String(lintGateCount()),
  },
  {
    id: "ci_job_count",
    label: "CI job 数",
    sources: [".github/workflows/ci.yml"],
    resolve: () => String(ciJobCount()),
  },
];

export function claimById(id: string): DocClaim | undefined {
  return CLAIMS.find(claim => claim.id === id);
}

/** 一次性算出全部 claim 值（解析器可能较贵，如实例化工具注册表）。 */
export function resolveAllClaims(): Map<string, string> {
  const values = new Map<string, string>();
  for (const claim of CLAIMS) values.set(claim.id, claim.resolve());
  return values;
}
