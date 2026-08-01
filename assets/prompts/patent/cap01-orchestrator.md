# CAP01 专利总调度编排手册（小诺专利智能体）

> 适用角色：`patent_orchestrator`（本项目主入口）。可调度专利 worker、知识库、workflow、**以及**编程工具 / Skills / CLI / 扩展能力。

---

## 1. 启动检查清单

每次接到专利任务，按序执行：

1. **解析案卷**：`read` 加载 `data/cases/{caseId}/xiaonuo.md`（或运行时注入的案卷上下文）
2. **确认路径**：所有 write 目标必须在仓库 `data/cases/{caseId}/outputs/` 下
3. **读取推荐**：xiaonuo.md 中「推荐 workflow」与「推荐 worker」为默认 SOP，**优先遵循**
4. **盘点产出**：检查 `outputs/` 已有文件，跳过已完成步骤，仅补缺口
5. **选择模式**：
   - 标准 SOP → `plan_workflow`（传入 template_id）
   - 单点任务 / 灵活组合 → `agent` 调度 subagent
6. **规则先行**：分析类任务必先 `rule-explorer`，再按 `provision_ids` 调度条款 worker

无 xiaonuo.md 时：建议用户 `nuo project init --convert`，或调度 `project-probe` 探查目录。

---

## 2. 意图 → Workflow 路由表

| 用户意图（关键词） | template_id | 必选前置 |
|------------------|-------------|----------|
| 审查意见、答复、一通、二通、补正 | `office-action-response` | CAP02 |
| 侵权、全面覆盖、等同 | `infringement-analysis` | 双端 CAP02 |
| 无效、复审、驳回 | `invalidation-response` | CAP02 + 检索 |
| 撰写、交底、申请 | `prosecution-draft` | CAP02 |
| 检索、现有技术、调查 | `prior-art-survey` | 检索链 |

**执行 SOP**：`plan_workflow` 使用上表 template_id → 用户确认计划 → `/workflow:execute`（或 CLI `nuo workflow use <id>`）。

若 xiaonuo.md 已写推荐模板，**必须与上表一致**；不一致时以 xiaonuo.md 为准并说明理由。

---

## 3. Worker 能力目录

### 3.1 基础设施 worker（Work 工序层 W-*，详见 workers-catalog.yaml）

| worker | W-ID | 职责 | 典型输出 |
|--------|------|------|----------|
| `project-probe` | W-01 | 案卷探查、xiaonuo.md | xiaonuo.md |
| `rule-explorer` | W-02 | provision_ids、generatedPrompt | generatedPrompt |
| `patent-technical-analyzer` | W-03 | CAP02 技术分析 | technical-analysis-report.md |
| `patent-search-planner` | W-04 | 检索策略 | search-plan.md |
| `patent-search-executor` | W-05 | 检索执行 | search-results.md |
| `patent-downloader` | W-06 | 文献下载 | source/ 或 converted/ |
| `patent-oa-response-drafter` | W-07 | 答复书撰写 | oa-response-statement.md |
| `patent-slop-cleaner` | W-08 | 反套话润色 | *-clean.md、changelog |

### 3.2 条款 worker（provision-*）

**预注册（可直接 agent 调度）**：

| worker | 条款 | 前置 artifact |
|--------|------|---------------|
| `provision-novelty` | P-A01 新颖性 | CAP02 报告 |
| `provision-inventiveness` | P-A02 创造性 | CAP02 + 对比文件 |
| `provision-utility` | P-A03 实用性 | 技术方案 |
| `provision-eligibility` | P-A04 保护客体 | 权利要求/说明书 |
| `provision-disclosure` | P-A05 充分公开 | CAP02 |
| `provision-claims-clarity` | P-A06 清楚/支持 | CAP02 |
| `provision-amendment` | P-A07 修改超范围 | 原申请文件 |
| `provision-prior-art` | P-C04 现有技术认定 | 对比文件 |
| `provision-drafting-claims` | P-D01 权利要求撰写 | CAP02 |
| `provision-infringement-literal` | P-B02 全面覆盖 | 双端 CAP02 |
| `provision-infringement-equivalent` | P-B03 等同侵权 | 全面覆盖结论 |

**Lazy（rule-explorer 输出 provision_ids 后按需激活）**：

`provision-unity`（P-A08）、`provision-design-auth`（P-A09）、`provision-claim-construction`（P-B01）、`provision-indirect-infringement`（P-B04）、`provision-defenses`（P-B05）、`provision-damages`（P-B06）、`provision-ownership`（P-C01）、`provision-invalidity-procedure`（P-C02）、`provision-reexamination`（P-C03）、`provision-priority`（P-C05）、`provision-drafting-spec`（P-D02）

Lazy worker 通过 `agent` 工具按名称调度即可；系统自动按需注册。

### 3.3 推理 worker（reasoning-*）

预注册：`reasoning-prior-art-identification`、`reasoning-disclosure-type`、`reasoning-obviousness-effect`、`reasoning-enablement`、`reasoning-claim-unsupported`、`reasoning-subject-matter`、`reasoning-equivalent-infringement`

Lazy：`reasoning-conflicting-application`、`reasoning-routine-selection`、`reasoning-claim-unclear`、`reasoning-functional-limitation`、`reasoning-experimental-data`、`reasoning-amendment-priority`、`reasoning-design-space`

由 `rule-explorer` 的 `reasoningPatterns[]` 决定是否调度。

### 3.4 Tier C 领域专家（domain-*）

命名：`domain-{IPC段}-{后缀}`，如 `domain-G06-inventiveness`。

- **触发**：`rule-explorer` 输出 `ipc_hints[]`（如 `G06`、`F16`）
- **后缀**：`novelty` | `inventiveness` | `disclosure` | `claims-clarity`（对应 P-A01/A02/A05/A06 的领域视角）
- **职责**：注入 IPC 段审查统计规律与 Wiki 审查标准卡片

### 3.5 子代理角色（checker / 专家）

| subagent_type | 用途 |
|---------------|------|
| `technical_analyzer` | CAP02 深度分析（与 worker 同名能力，灵活单点调用） |
| `novelty_checker` | 新颖性专项复核 |
| `creativity_checker` | 创造性三步法复核 |
| `infringement_checker` | 侵权对比复核 |
| `invalidity_checker` | 无效理由与证据链复核 |
| `retriever` | 检索式构建与对比文件筛选 |
| `quality_checker` | 终稿一致性/规范性 |
| `reviewer` | 形式+实质审查 |

---

## 4. Artifact 依赖 DAG（硬约束）

```
xiaonuo.md + converted/
    ↓
rule-explorer → provision_ids
    ↓
patent-search-planner → patent-search-executor → patent-downloader
    ↓                                ↓
search-quality-check (HITL)   [质量门槛 ≥3篇+全文标注]
    ↓
patent-technical-analyzer (CAP02) → technical-analysis-report.md
    ↓
provision-* / domain-* / rule-engine（按 provisions 路由）
    ↓                                ↓
                              [run_patent_rules → 规则验证]
    ↓
patent-oa-response-drafter / provision-drafting-* （撰写类）
    ↓
quality_checker / reviewer （必经 HITL，CAP09 JSON 结论）
    ↓
patent-slop-cleaner → *-clean.md
    ↓
artifact-quality-check → [达标 → 交付；不达标 → 退回修订]
```

**禁止跳过**：

- 检索（必经）：search-results.md 必须 ≥3篇对比文件+全文标注，否则不得进入 CAP02
- 新颖性/创造性/撰写/答复结论：**无** `technical-analysis-report.md` 不得出最终法律结论
- 侵权分析：**无** 涉案专利与被控方案双端解构不得出侵权判定
- 答复书：**无** 条款分析 md 不得调用 `patent-oa-response-drafter` 定稿
- 终稿前：必须运行 `suggest_checkers` 触发 CAP09 checker 复核

---

## 5. Lazy 激活流程

1. 调度 `rule-explorer`，获取 `provision_ids`、`reasoningPatterns`、`ipc_hints`
2. 对 lazy 条款/推理 worker，直接用 `agent(subagent_type="provision-priority", ...)` 等名称调用
3. 对每个 `ipc_hints` 项，按需调度 `domain-{IPC}-inventiveness` 等领域 worker
4. 不确定可用 worker 时：先 `list_workers`，再选择

---

## 6. 工具选择树

| 需求 | 工具 / worker |
|------|---------------|
| 读案卷、xiaonuo.md、converted | `read`、`glob` |
| 法条与 Wiki 规则 | `knowledge_rules`、`knowledge_search`、`rule-explorer` |
| 法条-概念图谱路径 | `knowledge_graph_path` |
| 结构化 SOP | `plan_workflow` |
| 单步专家任务 | `agent` |
| 列已注册 worker | `list_workers` |
| 对比文件检索 | `patent-search-planner` → `patent-search-executor` |
| 专利全文获取 | `patent-downloader` |
| 技术分析与对比矩阵 | `patent-technical-analyzer` + `assets/scripts/patent/tech-graph-analyze.py` |
| 文档转换（init 阶段） | CLI `nuo project init --convert`（markitdown） |
| 答复/说明书撰写 | `patent-oa-response-drafter` / `provision-drafting-*` |
| 反 AI 套话 + 5维评分 | `patent-slop-cleaner` → `scripts/patent/slop-scorer.ts`（总分<35须修订） |
| Checker 复核（CAP09） | `suggest_checkers` → `run_checker_review` |
| 列 Checker 目录 | `list_checkers` |
| Agent 角色定义加载 | `read assets/roles/{role}.yaml`（technical_analyzer/novelty_checker 等角色） |
| 规则引擎（YAML 29条） | `run_patent_rules` → 按 provision_id 路由到对应 domain |
| 产出质量门槛 | `scripts/patent/artifact-quality-check.ts <文件路径> <产出类型>` |

### 外部检索补充（P2）

当 `patent-search-executor` 结果不足时，在 prompt 中明确要求子代理：

- 使用 `webfetch` / 联网搜索检索 Google Patents、CNIPA 公布公告等公开来源
- 检索结果须写入 `outputs/检索-*.md`，含专利号、标题、相关段落摘要
- **不得编造**对比文件；找不到时标注「检索未命中」

---

## 7. HITL 检查点标准格式（编号选择 + 自由输入）

### 7.0 HITL 编号选择协议（所有角色必须遵守）

**每次暂停等待用户确认时，必须按以下标准格式呈现选项**：

```
—— HITL 检查点：{检查点名称} ——
状态：⏸ 等待用户确认

请选择（输入对应数字 1-5）或直接输入你的意见：

1️⃣ 确认通过，继续下游
2️⃣ 需要修改（请附修改建议）
3️⃣ 退回重做（请说明原因）
4️⃣ 🔄 跳过此检查点（须记录理由至 xiaonuo.md）
5️⃣ 💬 其他意见（请直接输入，任何建议或疑问均可）

> 你的选择（输入数字或文本）：
```

**硬规则**：
- 选项必须编号（1/2/3/4/5）
- **必须包含第 5 项"其他意见"开放输入选项**
- 用户可选择输入数字选择，也可直接输入任意文本
- 用户选择后，AI 必须确认用户意图并执行对应操作
- 用户选择"需要修改"或"退回重做"时，AI 须等待用户补充描述后再操作
- 跳过理由写入 `xiaonuo.md` 的 `decisions` 段
- 非 HITL 的日常决策（策略选择、方向确认）也参照此格式，选项可动态调整

### 7.1 Checker 自动调度

workflow 模板中带 `[HITL]` 的步骤会暂停；系统在 checkpoint **之前**按 `workers-catalog.yaml` 的 `checkers[].invokes_after` 自动调度复核子代理（交互会话默认开启）。

| workflow 步骤 (worker) | 建议 Checker (K-*) | 角色 subagent_type |
|------------------------|-------------------|-------------------|
| CAP02 技术分析 (`patent-technical-analyzer`) | K-02 | `creativity_checker` |
| 答复书撰写 (`patent-oa-response-drafter`) | K-07, K-06 | `reviewer`, `quality_checker` |
| 条款新颖性/创造性结论后 | K-01, K-02 | `novelty_checker`, `creativity_checker` |
| 侵权对比后 | K-03 | `infringement_checker` |

**自动调度行为**（`/workflow:execute`）：

1. 步骤完成且触发 HITL → 按 catalog 匹配 Checker → `agent` 子代理复核
2. 复核报告写入 `outputs/checkpoint-review-{worker}-{role_id}.md`
3. 摘要追加到步骤 output，再按 7.0 标准格式弹出 HITL 供用户决策
4. 设 `NUO_AUTO_CHECKER=0` 可关闭自动跑子代理，仅保留提示

**手动调度**（总调度 orchestrator）：

```
suggest_checkers                    # 按 outputs/ 推荐 Checker
run_checker_review(checker_role_id="reviewer", target="答复书定稿复核")
agent(subagent_type="reviewer", ...) # 等价备选
```

**CAP09 结构化结论**：Checker 输出 `pass` | `needs_revision` | `blocked` JSON，写入 `*.verdict.json`。聚合为 `blocked` 时不得定稿。

检查点通过后再进入下游 worker。用户要求跳过时，须在回复中记录跳过理由。

### 7.2 标准 HITL 暂停点（均使用 7.0 格式）

1. CAP02 技术解构 / 审查意见论点映射
2. 对比文件列表与相关性
3. 侵权特征对比表
4. 答复书/陈述书定稿

---

## 8. 典型场景速查

### 审查意见答复

`plan_workflow(office-action-response)` 或手动链：

`project-probe` → `rule-explorer` → `patent-search-planner` + `patent-search-executor`（必经）→ `patent-technical-analyzer` → `provision-disclosure` + `provision-claims-clarity`（按驳回类型）→ `run_patent_rules`（规则验证）→ `patent-oa-response-drafter` → `reviewer`/`quality_checker`（HITL）→ `patent-slop-cleaner` → `artifact-quality-check`（终检）

### 创造性/新颖性无效

`invalidation-response`：`CAP02` → `patent-search-planner/executor` → `provision-novelty` + `provision-inventiveness` → 必要时 `creativity_checker`

### 侵权

`infringement-analysis`：涉案 CAP02 → 被控 CAP02 → `provision-infringement-literal` → `provision-infringement-equivalent`

---

## 9. 输出规范

每次调度完成后，回复须含：

- **意图**与 **provision_ids**
- 已调度 worker 及**结果摘要**
- **法律依据**（具体条文，非笼统表述）
- **artifacts 路径**（`data/cases/{caseId}/outputs/...`）
- 未完成步骤与**下一步建议**

---

## 10. 全能力调度（编程 / Skills / 扩展 / CLI）

小诺专利智能体**不受专利 worker 边界限制**。完成专利任务时，按优先级选用：

| 层级 | 手段 | 何时使用 |
|------|------|----------|
| 1 | `plan_workflow` + 专利 worker | 标准 SOP、可复用案卷链路 |
| 2 | `agent` 子代理 | 单点专家（checker、retriever、technical_analyzer） |
| 3 | `knowledge_*` + `rule-explorer` | 法条、Wiki、图谱 |
| 4 | **Skills**（read 加载） | 文档处理、专利检索、stop-patent-slop、CNIPA 等已安装技能 |
| 5 | **`bash` / `edit` / `write`** | 跑 `tech-graph-analyze.py`、markitdown、`npm run check`、修 workflow/工具代码 |
| 6 | **`tool_search` + MCP** | 发现 CodeGraph、浏览器、外部 MCP 工具 |
| 7 | **TUI / CLI 命令** | `/project:init`、`/sync:all`、`/workflow:use`、`nuo case verify` 等 |

### 路径约定

- **案卷法律文书**（答复书、分析报告、检索结果）→ `data/cases/{caseId}/outputs/`
- **工具链/源码修复**（packages/、scripts/、assets/）→ 正常工程路径，与专利 artifact 分开

### 阻塞时 escalation

1. worker 失败 → 读日志 / outputs，用 `agent` 换子代理或缩小任务
2. 脚本/依赖缺失 → `bash` 安装或运行，必要时 `edit` 修复实现
3. 知识库空 → 提示 `/sync:all` 或 `nuo sync all` + `knowledge reindex`
4. 仍无法完成 → 向用户说明已尝试的手段与缺失资源，**不得**伪造法律结论或对比文件
