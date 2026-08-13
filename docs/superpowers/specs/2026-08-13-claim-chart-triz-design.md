# Claim Chart 内核 + 五场景接入 + TRIZ 组件 — 设计文档

日期：2026-08-13
状态：已与用户逐节确认

## Context

竞品调研（专利/法律智能体开源项目）发现：Sati 现有"四级对比矩阵 + 区别特征四层分析"（`creativity-assessment.yaml` / `prior-art-survey.yaml` 的 `tech-compare` 步骤）是**技术方案层面**的对比，而专利实务的标准交付物 claim chart 是**权利要求要素层面**的证据网格——左列把权利要求拆成编号要素（`[1a]`、`[1b]`…），右列对应证据（对比文件公开内容或产品特征），**每个单元格必须 pin-cite**，并产出 gap list（"哪里证据薄"）。

行业标准已核实：
- **Wikipedia claim chart**：两列表格 + All-Elements Rule（侵权全面覆盖 / 丧失新颖性单篇全要素）
- **Anthropic claude-for-legal 官方 claim-chart skill**：要素拆分（preamble 限定性 / Markush / 结构术语同源词防误判）→ mapping 状态机（`literal` / `partial` / `not-found` / `needs-evidence` / `construction-dependent` / `obviousness-combination`）→ **gap list 第一优先输出**
- **CNIPA 官方模板**：《技术方案与指定权利要求的特征对照表》（专利链接制度）
- **中国法三步法**（审查指南二部分四章）：最接近现有技术 → 区别特征 + 实际解决的技术问题 → 是否显而易见；任何一步不成立则整个否定不成立

**Sati 的落差**：方案级对比矩阵（七维解构 vs 七维解构）与要素级证据网格（claim chart）互补——现有分析产出"区别特征清单"，缺"要素级证据网格"这一法律文书层（意见陈述书 / 无效请求书 / 侵权比对表的骨架）。

**已确认决策**：
1. 统一内核 + 场景模板（五场景共享同一 claim-element-mapping 内核，差异只在目标对象与判断框架）
2. LLM 拆分 + 确定性内核（LLM 负责要素拆分与证据定位；TS 模块负责状态机 / 校验 / pin-cite 规范检查 / 持久化，白盒可审计）
3. 首版：内核 + 五场景全接（撰写 / OA 答复 / 无效 / 复审 / 侵权）
4. TRIZ = 40 发明原理 + 39×39 矛盾矩阵

## 一、数据模型与内核 runtime

### 数据模型（`src/patent/claim-chart/protocol/types.ts`）

```ts
type ElementKind = "preamble" | "transitional" | "limitation"
                 | "means-plus-function" | "markush-member";

interface ClaimElement {
  id: string;              // "1a"/"1b"/"2[add'l]" — 稳定编号是表脊
  claimNo: number;
  text: string;            // verbatim 权利要求原文子串（validator 强制）
  kind: ElementKind;
  disputedTerm?: string;   // 需 claim construction 的术语
}

type ChartMode = "infringement" | "invalidity" | "oa-response"
               | "reexamination" | "patentability";

type Mapping = "literal" | "literal-construction-dependent" | "doe"
             | "anticipation" | "obviousness-combination" | "partial"
             | "not-found" | "needs-evidence" | "construction-dependent";

type RowState = "mapped" | "mapped-doe" | "partial" | "not-found"
              | "needs-evidence" | "construction-dependent"
              | "anticipation" | "obviousness-combination";

interface ChartTarget {
  id: string;                       // "D1" / "D2" / "产品A"
  kind: "prior-art" | "accused-product";
  sourcePath?: string;              // 对比文件 converted 路径 / 产品材料路径
  title?: string;
}

interface ChartRow {
  elementId: string;  targetId: string;
  quote: string;      // 对比文件/产品证据 verbatim 引用
  pinCite: string;    // [D1 段[0032] 图3] — 必须能在源文定位
  mapping: Mapping;   state: RowState;
  verified: boolean;  // HITL 核验标记（重跑保留）
}

interface GapEntry {
  elementId: string;  targetId: string;
  mapping: Mapping;
  reason: string;                 // 为何缺证据（要素无对应/文献未公开/材料不足）
  suggestion: string;             // 补充检索 / 证据固化 / 等同分析
}

interface ClaimChart {
  chartId: string;  mode: ChartMode;  caseId: string;
  claimNos: number[];  targets: ChartTarget[];  rows: ChartRow[];
  gaps: GapEntry[];        // 第一优先输出
  draftNotice: string;     // "本表为分析草稿"免责声明（行业标准）
}
```

### 内核 runtime（`src/patent/claim-chart/runtime/`）

| 模块 | 职责 | 白盒价值 |
|---|---|---|
| `element-validator.ts` | 每个要素 `text` 必须是权利要求原文**连续子串**（归一化空白后校验）；编号连续无跳号 | 防幻觉拆分 |
| `pin-cite-validator.ts` | pin-cite 格式解析 + 与对比文件 converted markdown 存在性检查（段号存在 + 引文子串匹配） | 防幻觉引用 |
| `mapping-machine.ts` | 行级状态机：`anticipation`/`obviousness-combination` 仅限 prior-art 目标、`doe` 仅限侵权模式；跨行推导：新颖性=每要素单篇 mapped、区别特征=D1 上 not-found 行 | 场景合法性 + 法理推导 |
| `gap-detector.ts` | 聚合 `not-found`/`needs-evidence`/`partial` → gap list（排序 + 建议动作：补充检索/证据固化/等同分析） | 第一优先输出 |
| `store.ts` | 持久化 `claim-chart.json` + `claim-chart.md`（顶部 gap list + 免责声明，表格 `[#]│Element│目标特征│证据│Mapping│State│Verified`）；HITL 退回重跑保留 `verified` 行 | 增量修订 |

## 二、原子 / 工具 / 五工作流接入

### 原子与工具

**`build-claim-chart` 原子**（`src/patent/atoms/handlers/builtin/chart.ts`，对齐现有 10 原子模式）
- category: `"analyze"`；流程：读权利要求 + 目标材料 → LLM 产出要素拆分与逐行映射 JSON → 过 element/pin-cite/mapping 三关 → 非法行打回 LLM 重做（限 2 次）→ 持久化
- 输入：claimText、targets[]（对比文件 converted 路径 / 产品材料路径）、mode；输出：chart 摘要 + gap list

**`claim_chart_build` 工具**（`src/tool/builtin/claimChart.ts`，domain: `patent`，检索型角色经 `visibleDomains` 自动可见）

### 五工作流注入

在现有 YAML 的 `tech-analyze`（对比矩阵）之后插入 `claim-chart` 步骤，**不新建工作流**：

```
撰写   prior-art-survey（现有技术调查）:
       tech-compare → claim-chart(mode=patentability, targets=D1…)
       → draft-claims 基于 not-found 区别特征布局，规避 D1
       （prosecution-draft 为纯撰写无对比对象，不注入）

OA答复 office-action-response:
       tech-analyze → claim-chart(mode=oa-response, targets=审查员引用D1/D2)
       → draft 答复书引用 chart 生成"新颖性陈述+三步法"证据网格部分

无效   invalidation-response:
       tech-analyze → claim-chart(mode=invalidity, targets=证据组合)
       → novelty（mapping-machine 校验单篇全覆盖）→ inventiveness
         （区别特征 = D1 not-found 行，组合启示 = D2 映射行）

复审   复用 invalidation-response（已声明"无效/复审答复"双场景）:
       mode=reexamination, targets=驳回决定引用对比文件

侵权   infringement-analysis:
       对比分析 → claim-chart(mode=infringement, targets=被控产品,
       支持 doe 行 + 现有技术抗辩子表) → 报告
```

关键点：
- 不新建工作流 YAML，只注入步骤（五场景流程骨架已存在且被 benchmark 验证）
- chart 是"方案级对比矩阵"到"法律文书"的桥梁：CAP02 出区别特征 → chart 落要素级证据 → 下游 novelty/inventiveness/draft 消费 `claim-chart.json`，不再各自重复对比
- HITL 检查点：chart 步骤后加确认点（对齐现有"编号选择协议"）

## 三、TRIZ 组件

**`src/methodology/runtime/components/triz.ts`**——第 8 个 `MethodologyComponent`（严格对齐现有 7 组件模式：`identify()` 关键词匹配 + `execute()` 生成 prompt）：

```ts
export const triz: MethodologyComponent = {
  name: "triz",
  description: "TRIZ 矛盾矩阵 + 40 发明原理：定义技术矛盾 → 查矩阵 → 原理启发构思",
  category: "creative",
  applicableDomains: ["patent", "general"],
  // TRIGGERS: 矛盾/冲突/权衡/折中/trade-off/规避/design around/改进/优化…
  identify(context) { return keywordScore(context, TRIGGERS); },
  execute(context) { return { prompt: ... }; },
};
```

execute 四步 prompt：
1. **定义技术矛盾**：改善参数（39 工程参数之一）vs 恶化参数 → 输出矛盾对
2. **查矛盾矩阵**：`triz-matrix.json` 确定性查表 → 得该格推荐原理编号（1-4 个）——LLM 凭记忆做不到的确定性查表
3. **原理启发构思**：按命中原理（含 `triz-principles.json` 的说明）生成 2-3 个候选方案
4. **专利场景落点**：撰写前创新辅助（区分与现有方案）/ 规避设计（识别保护点找替代手段）/ 问题重构（把"改进 X"重构为矛盾形式）

**内置数据**（`components/data/`）：
- `triz-principles.json`——40 原理（名称 + 说明 + 专利示例方向）
- `triz-matrix.json`——Altshuller 经典 39×39 矛盾矩阵（1521 格，公开经典数据整理内置）
- 注册进 `MethodologyRegistry`

## 测试与验证

| 层 | 内容 |
|---|---|
| 内核单测 `tests/patent/claim-chart/` | element-validator（verbatim 子串拦截改写/跳号检测）、pin-cite-validator（幻觉引用拦截）、mapping-machine（场景合法性 + 新颖性单篇覆盖推导 + 区别特征提取）、gap-detector（排序/建议动作）——全纯函数 |
| 原子测试 | `build-claim-chart` 非法行打回重做路径、verified 行增量保留 |
| TRIZ 测试 `tests/methodology/triz.spec.ts` | identify 触发词命中/不命中、execute prompt 含矩阵推荐原理编号、矩阵数据完整性（39×39 结构校验） |
| 工作流测试 | 5 处 YAML 注入后步骤拓扑合法 |
| 端到端 | benchmark `invalidation_analysis` 业务任务跑真实案例：claim-chart.md（顶部 gap list + 免责声明）、claim-chart.json、下游消费 |
| 质量门 | `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` |

## 文件清单

新建：
- `src/patent/claim-chart/protocol/types.ts`
- `src/patent/claim-chart/runtime/{element-validator,pin-cite-validator,mapping-machine,gap-detector,store}.ts`
- `src/patent/claim-chart/index.ts`（barrel）
- `src/patent/atoms/handlers/builtin/chart.ts`
- `src/tool/builtin/claimChart.ts`
- `src/methodology/runtime/components/triz.ts`
- `src/methodology/runtime/components/data/{triz-principles,triz-matrix}.json`
- `tests/patent/claim-chart/*.spec.ts`、`tests/methodology/triz.spec.ts`

修改：
- 4 个工作流 YAML（`assets/workflows/patent/`：prior-art-survey / office-action-response / invalidation-response / infringement-analysis）注入 `claim-chart` 步骤
- `src/patent/atoms/handlers/builtin/index.ts`、`src/methodology/runtime/MethodologyRegistry.ts`（注册新组件）
