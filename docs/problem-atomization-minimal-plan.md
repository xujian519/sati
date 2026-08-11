# 原子化问题合规校验 — 最小成本落地实施方案

- 方案版本：v0.1（最小落地版，对应 problem-atomization-implementation-plan.md 的"只取问题合规校验这一半收益"）
- 编制日期：2026-08-11
- 适用范围：Sati 专利创造性分析（A22.3 三步法）的 diff 阶段"实际解决的技术问题"合规校验
- 决策依据：`docs/problem-atomization-implementation-plan.md` 深度分析结论（复用度 60–70%，砍高阶体验，只做核心基座）

---

## 一、目标与范围

### 1.1 目标

以最小成本获得"问题合规校验"能力：对创造性分析中"实际解决的技术问题"表述做**确定性四检验**（单一因果 / 单一可测效果 / 手段可反推 / 不绑方案），不合规时经现有规则门**自动阻断或提示**，无需任何 LLM、无需新 Graph 节点、无需改造 manifest。

### 1.2 做什么（范围红线）

| 做 | 不做 |
|---|---|
| `atomicChecker.ts` 纯函数（四检验，确定性正则，零依赖） | 穷举 / 语义合并 / 孤儿双向校验（原方案 S1 其余） |
| `CheckRule.customCheck` 引擎扩展（types + engine） | 评分卡 / 反向测试 / 问题树 / 两两比较（原方案 S2–S3） |
| 3 条 INV 规则接入 `inventivenessRules()`（domain: patent_inventiveness） | 新建 Graph 节点 / 改造 `buildInventivenessGraph()` 节点链 |
| 对应单测 + 规则 fixture + 回归 | 修改 manifest / adapter / SKILL.md（SKILL.md 更新列为可选） |

### 1.3 为什么这是"接入现有 diff 流程"的最小路径

现有 diff 流程的"实际解决的技术问题"产出后，有**两条确定性规则门链路**（均使用 `defaultPatentRules()` + 域过滤，零接线改动）：

```
链路 A（Graph 形态）：buildInventivenessGraph() → conclude → rule_gate
                        （ruleGateNode(["patent_inventiveness"])，
                          collectStateText 拼入 inventiveness_diff 的 JSON）
链路 B（收口形态）：patent_workflow 工具（manifestId: patent_inventiveness_v1）
                        （checkDomains: ["patent_inventiveness"]，主代理产出文本）
```

新增 `domain: "patent_inventiveness"` 的规则在**两条链路自动生效**。customCheck 从评估文本中提取"实际解决的技术问题"片段（兼容 JSON 形态与文本形态）后跑 `atomicChecker` 四检验。**改动面：1 个纯函数文件 + 引擎 2 处小改 + 规则 3 条 + barrel 导出。预计 2–3 天。**

---

## 二、设计

### 2.1 `src/patent/problem/atomicChecker.ts`（核心，纯函数）

```typescript
// 四检验结果：pass 由合规性检验决定（不绑方案 + 单一因果）；
// measurableEffect（质量提示）与 meansReversible（信息性）不参与 pass——
// 缺量化指标或无法判定可反推都不是"确定不合规"。
export type AtomicCheckResult = {
  pass: boolean;
  checks: {
    singleCausality: boolean;
    measurableEffect: boolean;
    meansReversible: boolean;   // true=有现状锚点可反推，false=无法确定性判定（信息性）
    noSolutionBinding: boolean;
  };
  diagnostics: string[];         // 未通过项的具体原因（供规则 message / fixSuggestion）
};

export function checkAtomic(problem: string): AtomicCheckResult;
```

### 2.2 四检验的可执行规则（全部确定性正则，零 LLM）

| 检验 | 检测手段（模式） | 反例 | 说明 |
|---|---|---|---|
| `noSolutionBinding` 不绑方案 | 手段性表述模式：<br>`通过(设置|增设|加装|引入|配置|利用|采用|借助|使用|依靠)`<br>`(设置|增设|加装|引入|配置|利用|采用)[^，。；]{1,12}(机构|装置|组件|模块|系统|结构|部|单元|片|件|阀|泵|块)`<br>`(利用|通过|借助)[^，。；]{1,16}(实现|进行|达到)`<br>**排除泛指词**：技术手段 / 现有技术 / 常规手段 / 通常做法 | "通过设置限位凸台防止位移" | 最高频错误（SKILL.md 标注），命中即阻断 |
| `singleCausality` 单一因果 | 因果连接词计数：`导致\|使得\|造成\|引起\|引发\|致使\|产生\|源于\|归因于`，≥2 次即复合（同词重复亦计数） | "温度过高导致芯片损坏，使得整机宕机" | 陷阱 3 捆绑问题 / 陷阱 5 复合因果 |
| `measurableEffect` 单一可测效果 | 可测指标模式：<br>`\d+(\.\d+)?\s*(%|％|℃|°C|度|dB|mm|cm|m|kg|h|小时|天|次|倍|ppm|MPa|kPa|V|A|W)`<br>`(提升\|降低\|减少\|增加\|升高\|下降\|缩短\|延长)[^。]{0,10}\d`<br>`从\s*\d` | "可靠性差"（无指标） | 无量 → 该项 false + diagnostics 建议"补充可测指标"；**不参与 pass 判定**（规则层 Quality 提示） |
| `meansReversible` 手段可反推 | 现状锚点弱启发式：`现有\|传统\|目前\|常规\|背景技术` | 无任何锚点 → `false` | 信息性检验：true=有现状锚点可反推，false=无法确定性判定；不参与 pass，当前无规则消费 |

> 陷阱 1（伪问题）/ 陷阱 6（层次错位）/ 陷阱 7（前提缺失）/ 陷阱 8（事后诸葛亮）需要上下文或 LLM，**超出最小范围，明确不做**。

### 2.3 技术问题片段提取（customCheck 内，兼容双形态）

```typescript
function extractTechnicalProblem(text: string): string | undefined {
  // 形态 1：Graph 态（collectStateText 拼入的 inventiveness_diff JSON），兼容转义引号
  const json = /"actual_technical_problem"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (json) return unescapeJson(json[1]);
  // 形态 2：文本态（收口工具 / 主代理产出），"实际解决的技术问题：/为/是 ..."
  const flat = /实际解决的技术问题[是为：:]+([^。\n]{4,120})/.exec(text);
  if (flat) return flat[1];
  return undefined; // 提取不到 → 放行（缺"技术问题"由现有 INVENTIVENESS-THREE-STEP 处理）
}
```

> 提取不到即放行是刻意设计：技术问题缺失/未提及属于"三步法必备要素"问题，由现有规则阻断；新规则只做"已有技术问题表述的合规性"，互不重叠、不双重惩罚。

### 2.4 引擎扩展（2 处小改，不破坏现有 68 条规则）

**`src/patent/checker/types.ts`** — `CheckRule` 增加可选字段：

```typescript
/** 自定义判定函数（可选）：在 CheckType 分派检查之后、推理路径检查之前执行；
 *  返回 passed=false 时以 detail 作为失败信息。用于语义型规则（如原子化四检验）。 */
customCheck?: (text: string) => { passed: boolean; detail: string };
```

**`src/patent/checker/engine.ts`** — `evaluateRule` 在 switch 之后追加：

```typescript
if (rule.customCheck !== undefined) {
  const custom = rule.customCheck(text);
  if (!custom.passed) return { passed: false, detail: custom.detail };
}
```

### 2.5 INV 规则（`src/patent/checker/core-rules.ts` 的 `inventivenessRules()` 追加 3 条）

| 规则 ID | level | severity | checkType | 触发（customCheck） | 失败提示 |
|---|---|---|---|---|---|
| `INVENTIVENESS-PROBLEM-SOLUTION-BINDING` | Must(0) | critical | patent_inventiveness | 提取技术问题 → `noSolutionBinding === false` | "技术问题包含解决手段，违反审查指南第二部分第四章 3.2.1.1，属于事后诸葛亮式问题认定；请改写为不含任何具体手段的表述（如'如何提供可靠的轴向定位'）" |
| `INVENTIVENESS-PROBLEM-MULTI-CAUSAL` | Should(1) | major | patent_inventiveness | 提取技术问题 → `singleCausality === false` | "技术问题含复合因果/捆绑问题（多个因果链），请拆分或明确主因" |
| `INVENTIVENESS-PROBLEM-UNMEASURED` | Quality(2) | minor | patent_inventiveness | 提取技术问题 → `measurableEffect === false` | "技术问题缺少可测指标（建议落到量化效果，如'焊点断裂率从 0.1% 升至 3%'）" |

级别梯度设计：INV07 直接违反审查指南（阻断）；INV08 影响后续论证质量（阻断）；INV09 属质量提升项（累计 3 条才 needs_revision），避免过度严格。

> 命名遵循现有 `INVENTIVENESS-*` 长命名习惯（代码中无 INV07 编号，原方案文档的编号不沿用，避免两套体系漂移）。

---

## 三、文件改动清单

### 新增（4 个）

| 路径 | 内容 | 验证 |
|---|---|---|
| `src/patent/problem/atomicChecker.ts` | 四检验纯函数 + 正则模式常量 | `atomic-checker.spec.ts` |
| `src/patent/problem/index.ts` | barrel（导出 checkAtomic 与类型） | — |
| `tests/patent/atomic-checker.spec.ts` | 四检验正向/反向/误报用例 | node --test |
| `tests/patent/problem-rules.spec.ts` | 3 条 INV 规则 PASS/FAIL fixture + 双链路冒烟 | node --test |

### 修改（4 个）

| 路径 | 改动 | 回归 |
|---|---|---|
| `src/patent/checker/types.ts` | `CheckRule` 加 `customCheck?` 字段 | typecheck |
| `src/patent/checker/engine.ts` | `evaluateRule` 追加 customCheck 执行 | `checker.spec.ts` |
| `src/patent/checker/core-rules.ts` | `inventivenessRules()` 追加 3 条（import atomicChecker） | `checker.spec.ts` |
| `src/patent/index.ts` | 追加 `export { checkAtomic, ... } from "./problem/index.js"` | typecheck |

### 明确不改

`buildInventivenessGraph()`、`patentInventivenessManifest`、`adapter.ts`、`patent_workflow*` 工具、`constants.ts`（如需术语常量可内联于规则文件）、三个 SKILL.md（可选：后续在 `patent-inventiveness-analysis` SKILL.md 第 4 步补一句"技术问题表述须通过四检验"，成本低，列入可选）。

---

## 四、测试与验收标准

### 4.1 `tests/patent/atomic-checker.spec.ts` 用例清单

| 分组 | 用例 | 期望 |
|---|---|---|
| 不绑方案 | "如何提供可靠的轴向定位"（合规） | pass |
| 不绑方案 | "通过设置限位凸台防止位移" | fail（noSolutionBinding=false） |
| 不绑方案 | "通过现有技术手段降低成本"（泛指，防误报） | pass |
| 单一因果 | "现有散热方案导致芯片温度超标"（单一因果） | pass |
| 单一因果 | "温度过高导致芯片损坏，使得整机宕机，进而引发停机" | fail（singleCausality=false） |
| 单一因果 | "现有方案导致芯片温度超标，导致散热效率下降"（同词重复） | fail（singleCausality=false） |
| 可测效果 | "现有技术温度高 15°C，超出额定上限" | pass |
| 可测效果 | "可靠性差" | checks.measurableEffect=false（pass 不受影响，仅质量提示） |
| 手段可反推 | "现有技术散热方案噪音达 58dB"（现状锚点） | true |
| 手段可反推 | "提升用户体验"（无锚点） | false（信息性，不阻断） |
| 组合 | "通过增设液冷泵降低噪音至 42dB" | fail（绑方案，即使有效果） |

### 4.2 `tests/patent/problem-rules.spec.ts` 用例清单

| 用例 | 输入（engine.evaluate，rules: inventivenessRules()） | 期望 |
|---|---|---|
| INV07 FAIL | "…实际解决的技术问题为：通过设置限位凸台防止位移…" | 命中 SOLUTION-BINDING，aggregate=blocked |
| INV07 PASS | "…实际解决的技术问题为：如何在部件装配后提供可靠的轴向定位…" | 不命中 |
| INV08 FAIL | "…实际解决的技术问题：温度过高导致芯片损坏，使得整机宕机…" | 命中 MULTI-CAUSAL |
| INV09 FAIL | "…实际解决的技术问题：提高可靠性…" | 命中 UNMEASURED |
| 提取不到 | 无"实际解决的技术问题"字样（复用现有测试文本） | 3 条均不触发（放行） |
| Graph 形态 | 文本含 `"actual_technical_problem":"通过设置限位凸台防止位移"` 的 JSON 段 | 命中 SOLUTION-BINDING |
| 现有回归 | 现有 checker.spec.ts 的 inventiveness 两个用例 | 不新增失败（提取不到） |

### 4.3 验收（对齐验证顺序）

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
```

- 全部通过；`tests/patent/checker.spec.ts` 零新增失败（关键回归：inventiveness 两用例）；
- 新增测试覆盖：atomicChecker 单测 ≥10 用例、3 条规则各 ≥1 PASS + ≥1 FAIL、双形态（JSON/文本）提取各 ≥1 用例；
- 特性可独立关闭：规则定义处留注释说明"移除 3 条规则即回退"（无需特性开关，改动面仅规则数组）。

---

## 五、风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| INV07 正则误报（"通过技术手段"等泛指被误判为绑方案） | 合规文本被错误阻断 | 泛指词排除表（技术手段/现有技术/常规手段/通常做法）；误报用例进单测 |
| JSON 形态转义（LLM 输出 `\"` 或含引号） | 提取失败 → 静默放行 | 正则兼容 `\\.` 转义；提取失败路径有专门用例 |
| 新增规则影响现有 checker.spec.ts | 回归失败 | 已验证现有 inventiveness 用例不含技术问题表述（提取不到→放行）；跑全量确认 |
| 双链路行为差异（Graph JSON vs 收口文本） | 两边结果不一致 | 两种形态各 ≥1 fixture；如后续发现差异，可在 `ruleGateNode` 前加"提取技术问题字段再评估"（超出最小范围，暂不做） |

---

## 六、任务清单（可逐项勾选）

- [ ] T1 新建 `src/patent/problem/atomicChecker.ts`（四检验 + 泛指词排除 + diagnostics）
- [ ] T2 新建 `src/patent/problem/index.ts`（barrel）
- [ ] T3 `src/patent/checker/types.ts` 加 `customCheck?` 字段
- [ ] T4 `src/patent/checker/engine.ts` 追加 customCheck 执行
- [ ] T5 `src/patent/checker/core-rules.ts` 追加 3 条 INV 规则（含 extractTechnicalProblem）
- [ ] T6 `src/patent/index.ts` 追加 problem 模块导出
- [ ] T7 新建 `tests/patent/atomic-checker.spec.ts`（≥10 用例）
- [ ] T8 新建 `tests/patent/problem-rules.spec.ts`（规则 fixture + 双形态 + Graph 冒烟）
- [ ] T9 回归验证：`pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`
- [ ] T10（可选）`patent-inventiveness-analysis` SKILL.md 第 4 步补"四检验"提示

---

## 七、后续扩展（本次不做，供决策）

若本方案验证有效（规则门能稳定拦截不合规技术问题、无误报），可沿两条路径扩展：
1. **撰写前置**：`atomicChecker` 供 `patent-understand-disclosure` / PFE 提取阶段复用（同函数，零新增引擎改动）；
2. **主动挖掘**（原方案模式二，价值最高）：`buildInventivenessGraph()` diff 之后加并行 `problem_discover` 分支（效果段反向穷举 + 漏列特征挖掘），需引入 LLM 节点与问题树，工作量约 1–2 周，另行立项。
