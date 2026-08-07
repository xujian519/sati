# 路径 C 实施方案：以 nuo-patent 为 TS 数据引擎增强 Sati 专利 skill 生态

> 状态：**已实施**（Phase 0 / 1 / 2a 完成，2026-08；Phase 2b 本地库适配器未实施、Phase 3 部分完成；决策点确认见 §2 与文末"实施记录"）
> 关联分析：`docs/` 之前轮次对 nuo-patent 的深度探查（能力画像、重叠矩阵、路径 A/B/C 评估）
> 目标读者：Sati 核心维护者、专利域技能维护者

---

## 0. 背景与目标

### 0.1 为什么做

- nuo-patent 是成熟的 TS 专利**数据采集层**（Google Patents 元数据 / PDF / 法律状态 / CNIPA），代码健康（42 测试全绿、typecheck 通过），性能优于 Python 版 ~2x，且提供纯解析函数与无状态 Agent API。
- Sati 专利 skill 生态的现状痛点：**数据获取靠 `ego_browser` / `web_search` 降级**，无 TS 原生、结构化、可审计的数据通道（见 `patent-retriever` 角色检索方法）。
- 路径 C 的核心主张：**以 nuo-patent 为单一 TS 数据引擎，封装为 Sati 内置工具，增强现有 20+ 专利 skill 的取数与检索能力**；不替代现有上层分析 skill（撰写/对比/新颖性/侵权/无效），也不抛弃 nuo-patent（路径 A 被否决）。

### 0.2 目标（本方案成功标准）

1. Sati 具备 TS 原生、domain 标注的专利数据工具：`patent_metadata` / `patent_legal_status`（Phase 1）。
2. 补上 nuo-patent 的**检索缺口**：`patent_search`（Phase 2），并接入 `StageProvider.search` 供 patent workflow 原子使用。
3. `patent-retriever` 等角色能直接调度上述工具，数据链路从"浏览器降级"升级为"结构化 TS 通道"（Phase 3 收口）。
4. 全部新代码通过 `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`。

### 0.3 非目标

- 不重写现有 20+ 专利分析 skill（撰写/新颖性/侵权/无效等保持现状）。
- 不把 nuo-patent 的 Python CNIPA 薄包装替换为新的实现（脚本本就共用，保持现状）。
- 不强制替换 `patent-download` / `google-patents-search` 的 Python 脚本（列为可选项，见 Phase 3）。

---

## 1. 总体架构

```
┌─ skill/角色层 ─────────────────────────────────────────────┐
│  patent-retriever / patent-novelty-analysis / patent-agent …  │
│  （SKILL.md + type: role，经 visibleDomains 裁剪工具）          │
├─ 内置工具层（Sati src/tool/builtin，domain: "patent"）──────┤
│  patent_metadata · patent_legal_status · patent_search        │
│  （参照 literature 双工具模式：注册表 + 通用工具）              │
├─ 数据引擎层（nuo-patent 依赖）─────────────────────────────┤
│  scrapePatent / parsePatentHtml / LegalStatusChecker / search │
│  （TS 原生，ego-browser 反爬优先，回退 fetch/代理隧道）         │
└────────────────────────────────────────────────────────────┘
```

- 边界约束（CLAUDE.md）：`src/` 禁止导入 `ui/`；新模块放 `src/tool/builtin/`（工具）与 `src/patent/data/`（数据适配，如 Phase 2 本地库）。
- 参照物：`src/literature/`（`ConnectorRegistry` + `paper_list_sources`/`paper_search`）、`src/tool/registry/createBuiltinRegistry.ts`（`annotate(tool, domain)` 集中标注）、`src/agent/sub/roleFromSkill.ts`（`DOMAIN_REQUIRED_TOOLS` 域一致性校验）。

---

## 2. 决策点与推荐（实施前需确认）

| # | 决策点 | 推荐 | 备选 | 影响 | 实施结论 |
|---|--------|------|------|------|---------|
| D1 | nuo-patent 依赖引入方式 | **git 依赖**（`"nuo-patent": "github:xujian/nuo-patent#v2.2.0"`） | pnpm workspace 成员；或 child_process 调 CLI | Phase 1 前置 | ✅ 采用 git 依赖，锁定 `#v2.3.1` → **2026-08 改为 workspace vendor**：预构建产物存 `vendor/nuo-patent/`（源自 `#v2.3.1`），`workspace:*` 链接，安装离线不依赖外部 git 源 |
| D2 | Phase 2 检索实现位置 | **nuo-patent 仓库新增 `searchPatents()`**（Google Patents 搜索结果页解析），Sati 侧只封装 | Sati 侧直接对接本地 PG 库 | 决定 Phase 2a/2b 分工 | ✅ 采用 nuo-patent 侧实现（Phase 2a 完成） |
| D3 | 本地 7520 万专利库对接 | **可选适配器**（Sati 配置层，默认关闭，不随开源分发强制启用） | 不做 | 决定 Phase 2b 是否实施 | ❌ 未实施（本地 PG 库适配器未开工） |
| D4 | PDF 下载是否封装为工具 | **Phase 3 可选项**（`patent_pdf_download`，`isDestructive: true`） | 不封装（沿用 patent-download skill 的 python 脚本） | 影响权限模型 | ❌ 未实施（沿用 patent-download skill 的 Python 脚本） |

> D1 依赖用户对 nuo-patent 仓库发布策略的取舍；D2/D3 影响工作量约 ±2 人日。

---

## 3. Phase 0：依赖引入（0.5 人日）

### 3.1 变更清单

| 文件 | 变更 |
|------|------|
| `package.json` | `dependencies` 增加 `"nuo-patent": "github:xujian/nuo-patent#v2.2.0"` |
| `pnpm-lock.yaml` | `pnpm install` 更新 |

### 3.2 兼容性核查（已确认）

- Node：nuo-patent `engines >= 18`，Sati `>= 22.13` ✅
- 传递依赖：nuo-patent 依赖 `cheerio`/`domhandler`/`undici`（Sati 已有 `undici`）；`playwright` 是 optionalDependency（仅 CNIPA 链路，Sati 不引入）✅
- 模块格式：nuo-patent `exports` 同时支持 ESM/CJS + `.d.ts` ✅
- 构建：nuo-patent 以 dist/ 发布，`pnpm install` 自动执行其 `prepare`/`build`（git 依赖需确认仓库有 `prepare` 脚本或直接引用 dist 已提交的 tag）

### 3.3 验证

```bash
pnpm install
node -e "const {scrapePatent, validatePatentNumber} = require('nuo-patent'); console.log(validatePatentNumber('US11452699B2'))"
```

---

## 4. Phase 1：内置工具 `patent_metadata` / `patent_legal_status`（2 人日）

### 4.1 新文件

| 文件 | 说明 |
|------|------|
| `src/tool/builtin/patentMetadata.ts` | `createPatentMetadataTool()`：按专利号取元数据 |
| `src/tool/builtin/patentLegalStatus.ts` | `createPatentLegalStatusTool()`：批量法律状态 |
| `src/patent/data/nuo/types.ts` | nuo-patent 数据模型 → Sati 工具的转换类型（JSON 字符串字段 → 结构化） |
| `src/patent/data/nuo/mapper.ts` | `PatentData` JSON 字段解析 helper（`inventor_name`/`assignee_*`/`classifications`/引证 4 字段） |
| `tests/tool/builtin/patentMetadata.spec.ts` | 工具单测（mock 网络） |
| `tests/tool/builtin/patentLegalStatus.spec.ts` | 工具单测（mock 网络） |
| `tests/patent/data/nuo/mapper.spec.ts` | mapper 纯函数单测 |

### 4.2 工具契约

#### `patent_metadata`

```ts
type PatentMetadataInput = {
  patent: string;              // 必填，如 "US11452699B2"
  timeout?: number;            // 默认 30000
  return_abstract?: boolean;   // 默认 true
  return_legal?: boolean;      // 默认 true
};
type PatentMetadataOutput = {
  success: boolean;
  patent: string;
  url: string;
  data: {                     // 成功时为结构化 PatentData（JSON 字段已 parse）
    title: string;
    inventors: string[];
    assignees_current: string[];
    pub_date: string;
    filing_date: string;
    grant_date: string;
    legal_status: string;
    estimated_expiration: string;
    abstract_text: string;
    pdf_url: string;
    classifications: string[];
    backward_cites: Citation[];   // 前向/后向引证
    forward_cites: Citation[];
  } | null;
  errorCode: "" | "VALIDATION_ERROR" | "NETWORK_ERROR" | "HTTP_ERROR"
            | "TIMEOUT" | "PARSE_ERROR" | "NOT_FOUND" | "ABORTED";
  errorMessage: string;
  parseWarnings: { field: string; message: string }[];
};
```

#### `patent_legal_status`

```ts
type PatentLegalStatusInput = {
  patents: string[];           // 必填，1-20 个
  max_concurrency?: number;    // 默认 4
};
type PatentLegalStatusOutput = {
  results: Array<{
    patent_number: string;
    title: string;
    status: string;
    estimated_expiration: string;
    events_summary: { type: string; date: string; title: string }[];
    error?: string;
  }>;
};
```

### 4.3 实现要点（严格对照 paperSearch.ts 模式）

1. **`SatiToolDefinition` 声明**：`name`/`aliases`/`description`（模型可读，含用法提示）/`kind: "network"`/`domain: "patent"`/`inputSchema`（`additionalProperties: false`）/`isReadOnly: () => true`/`isConcurrencySafe: () => true`/`isOpenWorld: () => true`/`checkPermissions`（按 `paper_search` 的 `ask` 模式）。
2. **错误映射**：`ScrapeResult.errorCode` 映射为 `SatiToolRuntimeError`（`invalid_tool_input` / `tool_execution_failed`），与"无结果"天然区分；`parseWarnings` 原样透出（非致命，不降级为错误）。
3. **依赖注入**：工具构造器接受 `{ scraper?: typeof scrapePatent; checker?: LegalStatusChecker }`，测试注入 mock；**默认不注入时**读取 `NUO_PATENT_EGO_BROWSER` 环境（沿用 nuo-patent 语义）。
4. **取消**：透传 `context.abortSignal` → `ScrapeOptions.signal` / `LegalStatusOptions.signal`。

### 4.4 注册接线

| 文件 | 变更 |
|------|------|
| `src/tool/registry/createBuiltinRegistry.ts` | import 两个 creator；`options.patent !== false` 分支内 `registry.register(annotate(createPatentMetadataTool(), "patent"))` / `createPatentLegalStatusTool()`；增加 `patentData?: false` 选项（默认注册） |
| `src/agent/sub/roleFromSkill.ts` | `DOMAIN_REQUIRED_TOOLS` 增加 `patent_metadata: "patent"`、`patent_legal_status: "patent"` |
| `src/tool/index.ts`（如有 barrel） | re-export creator 与类型 |

### 4.5 测试（mock 策略）

- nuo-patent `scrapePatent` 无 `fetchImpl` 注入点 → 测试中 `process.env.NUO_PATENT_EGO_BROWSER = "0"` 禁用 ego-browser，再 monkey-patch `globalThis.fetch` 返回固定 HTML fixture（`meta[name="DC.title"]` 等结构）。
- 用例覆盖：成功解析（含 JSON 字段映射）、404 → `NOT_FOUND`、超时 → `TIMEOUT`、非法专利号 → `VALIDATION_ERROR`、`parseWarnings` 透出、`patent_legal_status` 批量与单错不中断。
- 参照：`tests/literature/tool/paperSearch.spec.ts`（注入式测试风格）。

### 4.6 验证

```bash
pnpm typecheck && pnpm lint && pnpm format:check
pnpm test -- tests/tool/builtin/patentMetadata.spec.ts tests/tool/builtin/patentLegalStatus.spec.ts tests/patent/data/nuo/mapper.spec.ts
```

---

## 5. Phase 2：检索缺口 `patent_search`（2-3 人日）

### 5.1 分工

- **Phase 2a（在 nuo-patent 仓库，1.5 人日）**：新增 `searchPatents(query, opts)` —— 抓取 Google Patents 搜索结果页（`https://patents.google.com/?q=...`）并解析命中列表（复用现有 `fetchHtml` + cheerio；ego-browser 反爬优先逻辑天然复用）。产出 `SearchHit[]`（patent/title/assignee/pub_date/abstract/url）。需补 `tests/` 镜像用例与 `bench/`。
- **Phase 2b（Sati 侧，可选，1 人日）**：本地 7520 万专利库适配器 `src/patent/data/local/sql.ts`——`pg` 客户端查询（`postgresql://127.0.0.1:5433/patent_db`），经 `checkAvailability` 报告 `setup_required`（库未启动/未配置时工具不可用而非报错）。**默认关闭**，配置启用（`tools.patentLocalSearch` 开关，参照 `tools.paperSearch` 配置模式）。

### 5.2 工具契约（Phase 2a 产物）

```ts
type PatentSearchInput = {
  query: string;               // Google Patents 原生检索语法（关键词/布尔/assignee:/日期）
  limit?: number;              // 1-50，默认 10
};
type PatentSearchOutput = {
  total: number;
  hits: Array<{
    patent: string;
    title: string;
    assignee: string;
    pub_date: string;
    abstract: string;
    url: string;
  }>;
};
```

### 5.3 接入 `provider.search`

- 新增 `src/patent/data/nuo/searchProvider.ts`：实现 `StageProvider`（`callLLM` 缺失时仅提供 `search`），供 `runWorkflow(..., { provider })` 注入；`SearchHandler`（`atoms/handlers/builtin/search.ts`）即从"degraded"变为真实检索。
- 接线点：`patentWorkflowTool.ts` 目前传**空 `StageHandlerRegistry`**（收口语义）。保持收口语义不变；新增可选的 `patent_search_atoms` 路径时再注入 `provider`（**Phase 3 可选**，避免改变现有工具行为）。

### 5.4 验证

```bash
# Phase 2a（nuo-patent 仓库）
cd ../nuo-patent && npm run typecheck && npm test

# Sati 侧
pnpm typecheck && pnpm test -- tests/patent/data/nuo/searchProvider.spec.ts
```

---

## 6. Phase 3：skill 与角色收口（1 人日 + 可选）

### 6.1 `patent-retriever` 角色（必做）

- 现状：`tools: ["*"]`、`domains` 已含 `"patent"` → 新工具对角色自动可见（无需改 frontmatter）。
- 必做：`skills/patent-retriever/SKILL.md` 的 systemPrompt 检索方法一节补充："优先 `patent_metadata` / `patent_legal_status` / `patent_search` 结构化工具，次选 `ego_browser` / `web_search` 降级"。
- 同步：`skills/patent-agent/SKILL.md`（总控）中检索阶段的工具指引。

### 6.2 可选：Python 脚本替换（决策点 D4 相关）

- **前提**：Phase 2a 完成（nuo-patent 具备 `search` CLI 命令）。
- `google-patents-search`（patent-search.py）：可由 `nuo-patent search` 替代（性能 2x、无 python 依赖），保留 SKILL.md 作为文档层。
- `patent-download`（download_patent_ego.py）：保持现状（ego-browser + CDN 双模式已成熟）；如封装 `patent_pdf_download` 工具需走 `isDestructive`/目标目录白名单权限模型，工作量另计。

### 6.3 文档更新

| 文件 | 变更 |
|------|------|
| `CLAUDE.md` | "专利域能力"一节补充内置数据工具说明 |
| `docs/technical-debt-report.md`（如相关） | 记录"浏览器降级取数"痛点已闭环 |

---

## 7. 验证总纲（每阶段完成即全量跑）

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
```

改动核心模块（tool/patent/agent）必须附测试，遵循 CLAUDE.md 测试要求；提交遵循 Conventional Commits（建议 scope：`patent` / `tool`）。

---

## 8. 风险与缓解

| 风险 | 等级 | 缓解 |
|------|------|------|
| Google Patents 页面结构变动破坏解析 | 中 | nuo-patent `parseWarnings` 降级语义 + 工具透出 warnings；页面结构监控纳入 nuo-patent 测试 |
| ego-browser 依赖（macOS）在 CI/无浏览器环境不可用 | 中 | 工具 `checkAvailability` 检测 + 回退 fetch；测试用 `NUO_PATENT_EGO_BROWSER=0` mock |
| 本地 PG 库（移动硬盘）不可移植 | 低 | Phase 2b 设计为可选适配器 + `setup_required`，不阻塞开源主链 |
| `patent_workflow` 行为回归 | 低 | 保持空 `StageHandlerRegistry` 收口语义不变；provider 注入走新路径 |
| 依赖引入（git 依赖）构建不稳定 | 已消除 | 2026-08 已切换 D1 备选 workspace vendor 方案（`vendor/nuo-patent/`） |

---

## 9. 工作量与里程碑

| 阶段 | 内容 | 估算 | 里程碑验收 |
|------|------|------|-----------|
| Phase 0 | 依赖引入 | 0.5 人日 | `pnpm install` 成功，`nuo-patent` 可 import |
| Phase 1 | 两个只读工具 + mapper + 测试 | 2 人日 | 全量验证通过；`patent-retriever` 可见新工具 |
| Phase 2a | nuo-patent `searchPatents` | 1.5 人日 | nuo-patent 测试绿；`patent_search` 工具可用 |
| Phase 2b | 本地库适配器（可选） | 1 人日 | `setup_required` 语义正确 |
| Phase 3 | 角色/文档收口 + 可选 CLI 替换 | 1 人日 | 检索链路文档化 |

**合计：约 5-6 人日（含 Phase 2b 约 6-7 人日）。**

---

## 10. 实施记录（2026-08 落地对照）

> 原"待确认项"已全部决策（见 §2 表格），本节记录实际落地与方案的偏差。

**已落地（与方案一致）**

- **Phase 0**：`package.json` dependencies 增加 `"nuo-patent": "github:xujian519/nuo-patent#v2.3.1"`；`pnpm-workspace.yaml` 的 `onlyBuiltDependencies` 追加 nuo-patent。
- **Phase 1**：`src/tool/builtin/patentMetadata.ts` / `patentLegalStatus.ts` 两个只读工具 + `src/patent/data/nuo/mapper.ts`（`mapPatentData` 解析 PatentData JSON 字符串字段）+ `searchProvider.ts`（`createNuoSearchProvider` 适配 workflow 原子 `StageProvider.search`）；注册于 `src/tool/registry/createBuiltinRegistry.ts`（`annotate(tool, "patent")`）。
- **Phase 2a**：nuo-patent 侧 `searchPatents` 完成，`patent_search` 工具可用；`searchProvider` 经 `patent_workflow_run` 工具接线生产。
- **Phase 3（部分）**：`patent-retriever` 角色检索方法升级为"结构化工具优先"（`d0b73135`）；`docs/technical-debt-report.md` 已更新"浏览器降级取数"闭环状态。

**未落地（按决策保留）**

- Phase 2b 本地 7520 万专利库适配器（D3 未实施，`patent-search` skill 的本地 PostgreSQL 检索仍走 skill 层）。
- `patent_pdf_download` 工具（D4 未实施，沿用 patent-download skill 的 Python 脚本）。
- Phase 3 可选：google-patents-search / patent-download 的 Python 脚本替换未做。

**后续扩展（超出本方案）**

- patent 域工具后续扩展至 17 个：`patent_kg_query`（知识图谱查询）、`patent_case_search`（判例全文检索，见 `docs/knowledge-case-law-integration.md`）、`analyze_patent_figure` / `search_patent_figure`（附图分析/检索）、`patent_wiki_search`、`patent_eval`、`draft_claims` / `draft_specification` / `validate_specification` / `evaluate_evidence` 等。
- flexible-plan 阶段级生命周期（见 `docs/design/import-xiaonuo-flexible-plan.md`）与 workflow-runs 持久化（`src/patent/workflow-store.ts`）。
