# 专利业务评测集（Golden Benchmark Fixtures）

面向专利代理机构真实业务的能力评测集，供 Sati 专利 agent / workflow / plantask
评测与端到端测试复用。共 **196** 个用例，按 **6 类业务**组织。

## 业务化 Suite（`fixtures/business/`）

| Suite | 数量 | 业务 | 交付成果 |
|---|---|---|---|
| `business-patentability` | 19 | 可专利性分析：新颖性/创造性/客体等授权要件评估 | 可专利性分析意见 |
| `business-drafting` | 15 | 申请文件撰写：基于技术交底材料撰写权利要求书/说明书 | 权利要求书撰写方案 |
| `business-file-review` | 20 | 申请文件审查：充分公开/支持/清楚/单一性/修改超范围 | 申请文件审查意见 |
| `business-oa-response` | 12 | 审查意见答复：分析成立性、拟定修改方案、起草答复 | 审查意见答复意见 |
| `business-infringement` | 6 | 侵权判定：全面覆盖/等同侵权/抗辩事由 | 侵权判定分析意见 |
| `business-invalidation` | 124 | 无效宣告：请求方案、专利权人答辩、决定分析（含外观设计） | 无效宣告意见 |

每个用例带业务口径元数据（`types.ts`）：

- `businessTask`：业务类型（上表 6 类 + 预留 `prior_art_search` / `disclosure_analysis`）
- `clientRole`：委托方身份（专利申请客户 / 发明人客户 / 无效请求人客户 / 专利权人客户 / 企业客户 / 企业客户（决定分析））
- `deliverable`：要求交付的成果物
- `sourceSuite`：原始 suite 名（溯源到 Mady 导出）

用例内容保留了原始案件实体（权利要求、对比文件、法条引文），仅改写"口吻"：
考试式题目改写为客户委托场景，参考答案剥离"官方参考答案要点"等考试痕迹并冠以
业务文书抬头。`input` 不再含"请判断……并说明理由"式提问，`expected` 均为可交付
文书口径。

## 使用

```ts
import { loadAllCases, loadCasesBySuite, loadIndex } from "./loader.js";

const cases = loadAllCases();        // 全部 196 条业务化用例
const bySuite = loadCasesBySuite();  // Map<business-suite, BusinessPatentExamCase[]>
const index = loadIndex();           // 汇总信息
// 原始导出（溯源/对比用）
import { loadRawAllCases } from "./loader.js";
```

## 数据管线（两段式，可复现）

```
Mady 原始导出（考试口径）                 Sati 业务化转换
fixtures/*.json  ──scripts/patent-  ──>  fixtures/business/*.json
（196 用例，1:1）  benchmark-business.ts   （196 用例，ID 不变）
```

```bash
# ① 从 Mady 重新导出原始 fixtures（勿手改 fixtures/*.json）
cd /Users/xujian/projects/Mady
go run ./cmd/export-benchmark -out /Users/xujian/projects/Sati/tests/patent/benchmark/fixtures

# ② 业务化转换（覆盖 fixtures/business/）
cd /Users/xujian/projects/Sati
npm run build && node dist/scripts/patent-benchmark-business.js
```

转换脚本含用例归类表（`TASK_MAP`）与业务场景模板，新业务归类直接改脚本后重跑；
`loader.spec.ts` 校验总数、业务字段、1:1 溯源与改写生效。

## 数据质量审查与修复（2026-08）

对 196 个用例做过一轮准确性与适配性审查，并修复以下问题：

**法条勘误（mock，源头在 Mady `evaluate/benchmark/patent_exam.go`）**
- `patent_exam_006`：论文构成"现有技术"误引《专利法》第二十三条第四款（现有设计定义）→ 改为第二十二条第五款（现有技术定义）
- `patent_exam_007`：将第二条第二款写为实用新型定义 → 改为发明定义（"发明，是指对产品、方法或者其改进所提出的新的技术方案"）
- `patent_exam_008`：先用权主体颠倒（甲/乙混淆）+ 误引修正前第六十九条 → 修正主体为在先实施者乙公司，条款改为第七十五条（2020 修正版）

**决定书核心理由补全（42 条残缺 → 31 条补全 + 11 条降级标注）**
- Mady 数据提取对部分 CNIPA 决定书无法提取"核心理由"（残留"详见决定书正文"占位）
- `scripts/repair-invalidation-decisions.ts` 按专利号定位宝宸知识库_Raw 原始决定书，重新提取理由摘要（决定要点 / 关键论证 / 决定的理由 / 合议组认为 / 综上所述 五级策略）
- 11 条原始文件未收录于数据源（201430008295.8 等现代专利号），已在 expected 中明确标注"仅结论与法条可评测"，避免误导

**适配性说明**
- 无效决定书类用例 input 仅含权利要求 + 证据 + 理由，不含决定结论 → 评测任务为"从案件材料推断无效前景"，结论以 expected 为准
- `patent_exam_043`（OA 策略）input 无具体案件事实，只能评测方法论层策略
- mock/真题 expected 为参考要点（非唯一正确解），建议配合 LLM 评审而非硬门禁

重新生成顺序：`go run`（Mady 导出）→ `patent-benchmark-business.js`（业务化）→ `repair-invalidation-decisions.js`（决定书补全）。

## 覆盖缺口（后续补充方向）

- `prior_art_search`（现有技术检索）与 `disclosure_analysis`（技术交底书分析/挖掘）
  目前为 0 用例：Mady 真题集不覆盖这两类业务，需要按真实检索报告/交底书
  结构化模板新建用例。
- 无效类占比 63%（124/196），反映真实业务分布；如需均衡评测可对
  `business-invalidation` 分层抽样。

## 版权与合规

- 真题层源自 2007-2019 全国专利代理人资格考试/专利代理师资格考试官方真题，
  仅抽取公开题目与官方参考答案要点，**不随仓库分发原始 PDF**，建议仅用于内部评测。
- 无效决定书为 CNIPA 行政公开文书，风险较低。
- 55 条模拟题参考答案为参考质量（非唯一正确解），用作硬门禁（threshold 0.7）
  时可能误杀，建议配合 LLM 评审使用。
