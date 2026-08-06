# 引入 XiaoNuo Provenance — 结论溯源能力设计

- 状态：草案（待评审）
- 日期：2026-08-06
- 范围：结论→证据多跳溯源。**先做差异分析（§2），再按结论选择方案 A（推荐，增强现有体系）或方案 B（完整移植 DAG）**
- 移植源：`/Users/xujian/projects/XiaoNuo Agent/packages/agent-core/src/provenance/`（store.ts ~350 行 + provenance-db.ts，依赖 `@nuo/data` SQLite）

---

## 1. 背景

Sati `src/patent/evidence/` 已实现"结论 → 证据 → 工具调用 → 参数/路径"**全链路可审计**：

| 组件 | 能力 | 文件 |
|------|------|------|
| `Receipt` / `Ledger` | 每次工具调用一张账本（谁/何时/工具/成败/读写分类），turn 级累积 | `receipt.ts` |
| `EvidenceSpan` | 证据片段（文本/来源/方向 supporting/contradicting/neutral） | `span.ts` |
| `ClaimBinding` | **结论↔证据多对多绑定**：`bind/unbind`、`unbackedClaims()`（无证据支持的结论显式标记）、`spansForClaim()` | `claimBinding.ts` |
| `ConflictDetector` | claim 冲突（同结论绑定 support+contradict）与 source 冲突（同来源方向矛盾） | `conflict.ts` |
| 证据判断引擎 | 三性/类型/举证责任/证明标准/日期推定/平台可信度（确定性） | `engine.ts` |
| `contentHash` | FNV-1a 32 位内容哈希（证据原文完整性校验） | `receipt.ts` |

XiaoNuo Provenance 是**通用内容寻址溯源 DAG**：节点/边以 `sha256(canonical JSON)` 前 16 位为 id（相同内容自动去重）、`INSERT OR IGNORE` 幂等、BFS 祖先查询、`supports/refutes/derived-from` 关系边、`findSupporting/findRefuting/findOrigins`。

**本方案的第一动作是差异分析**——判断 XiaoNuo DAG 相对 Sati 现有体系的增量是否值得引入，再选择路径。

---

## 2. 差异分析（决策前置，必读）

### 2.1 能力矩阵

| 能力 | Sati 现状 | XiaoNuo Provenance | 增量价值 |
|------|----------|---------------------|----------|
| 结论↔证据绑定 | ✅ `ClaimBinding`（二维映射） | ✅ DAG 边 | 无（Sati 已等价） |
| 冲突检测 | ✅ `ConflictDetector` | ❌（无此概念） | Sati 更强 |
| 工具调用溯源 | ✅ Receipt/Ledger 全链路 | ✅（record run） | 无（Sati 已等价） |
| **内容寻址去重** | 🟡 FNV-1a（弱哈希，仅校验用） | ✅ sha256 canonical | **有**（但 Sati 场景证据原文极少重复出现，价值存疑） |
| **多跳图遍历** | ❌ ClaimBinding 仅单跳（claim→spans） | ✅ BFS ancestors/descendants | **有**（证据组合多跳追溯：证据A→结论B→结论C） |
| **findSupporting/findRefuting** | 🟡 单跳冲突检测 | ✅ 多跳支撑/反驳链查询 | **有**（无效宣告证据链多跳场景） |
| **findOrigins（起源追溯）** | 🟡 Receipt 链可追但需手写遍历 | ✅ 内置 | 有（工程便利性） |
| 幂等写入 | ❌ | ✅ INSERT OR IGNORE | 低 |

### 2.2 结论

- **真实增量只有一项**：**多跳图遍历**（`findSupporting/findRefuting/findOrigins`）。
- 内容寻址去重在 Sati 场景（证据原文来自文件/检索，重复率低）价值有限，且 sha256 对空白/换行敏感（见 §6 风险 R6-3）。
- **业务触发场景**：无效宣告中"证据组合 → 待证事实 → 结论"形成多跳链（对比文件 D1 支持区别特征 X → X 支撑"无技术启示"结论）；以及 OA 答复中"法条判定 → 权利要求特征 → 对比文件"的链式追溯。此场景在 Sati `orchestrations/invalidation.yaml` 的 `discoveryStages` 与 `availableArticles` 中真实存在。

**建议：方案 A（推荐）**——在现有 `ClaimBinding` 之上增加轻量多跳查询层，**不引入独立 DAG 库**；仅当方案 A 落地后验证不足（如证据量 > 万级、需要跨案件图查询）再升级方案 B。

---

## 3. 设计决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 路径 | **方案 A**：增强 ClaimBinding + 新增 `evidence/dag.ts` 多跳查询；方案 B（完整 DAG + SQLite graph.db）作为备选，仅在 A 验证不足时启用 | 增量只有多跳遍历，A 的成本是 B 的 1/10；避免双溯源体系 |
| 数据模型 | 节点 = EvidenceSpan / Claim（复用现有类型），边 = supports / refutes / derived-from（从 ClaimBinding 绑定 + ConflictDetector 结果推导） | 不建第二套数据结构，图是现有绑定的**查询视图** |
| 持久化 | 方案 A **无新库**：多跳查询在内存 DAG 上做（每案件规模可控）；方案 B 才引入 SQLite（`~/.sati/provenance/graph.db`） | 遵守数据红线：真实案件数据存 `~/.sati/` 且不进仓库 |
| 内容寻址 | 方案 A 不用 sha256 去重（绑定已有 id）；方案 B 才用 canonical hash | 规避 R6-3 过度区分风险 |
| 与证据账本关系 | dag.ts 是 Receipt/ClaimBinding 的**只读查询增强**，不改变写入路径 | 写入路径唯一（Receipt → Span → ClaimBinding），图只是投影 |
| 反思元判断 | **不进图**（见 §7 交叉约束 C3） | 图只存客观证据关系 |
| 开关 | 方案 A 直接可用（纯内存，无依赖）；方案 B 需 env 开关 | 渐进引入 |

---

## 4. 数据模型（方案 A，`src/patent/evidence/dag.ts`）

复用现有类型，新增图查询层：

```ts
import type { EvidenceSpan } from "./span.js";
import type { ClaimBinding } from "./claimBinding.js";

export type DagRelation = "supports" | "refutes" | "derived-from";

export interface EvidenceDagNode {
  id: string;                    // spanId 或 claimId（与 ClaimBinding 同 id 空间）
  kind: "evidence" | "claim";
  direction?: "supporting" | "contradicting" | "neutral";  // evidence 节点
}

export interface EvidenceDag {
  // 从 ClaimBinding + ConflictDetector 结果构建（每案件一次）
  static build(binding: ClaimBinding, spans: EvidenceSpan[]): EvidenceDag;

  /** 多跳祖先查询：返回从 root 可达的所有节点（BFS，环防护） */
  ancestors(rootId: string, maxDepth?: number): EvidenceDagNode[];

  /** 多跳后代查询 */
  descendants(rootId: string, maxDepth?: number): EvidenceDagNode[];

  /** 支撑链：evidence → claim 且 direction=supporting，多跳展开 */
  findSupporting(claimId: string, maxDepth?: number): EvidenceDagNode[];

  /** 反驳链：evidence → claim 且 direction=contradicting，多跳展开 */
  findRefuting(claimId: string, maxDepth?: number): EvidenceDagNode[];

  /** 起源追溯：从 artifact/claim 沿 derived-from 回根（对应 XiaoNuo findOrigins） */
  findOrigins(nodeId: string, maxDepth?: number): EvidenceDagNode[];
}
```

构建规则（推导而非新写入）：
- `supports` 边：ClaimBinding 中 claim ← supporting span
- `refutes` 边：ClaimBinding 中 claim ← contradicting span
- `derived-from` 边：由工具调用链推导（Receipt 的读写分类：产出文件的 Receipt → 输入文件的 Receipt），复用 Receipt 参数/路径

---

## 5. 文件级改动清单

> ⚠️ 本期仅记录方案，**未实施任何代码改动**。

### 5.1 方案 A（推荐）

| 文件 | 内容 | 规模估算 |
|---|---|---|
| **新增** `src/patent/evidence/dag.ts` | §4 图查询层（纯内存 BFS，环防护，无外部依赖） | ~180 行 |
| **修改** `src/patent/evidence/index.ts` | barrel 导出 dag 类型/构建器 | ~5 行 |
| **不改** `claimBinding.ts` / `conflict.ts` / `receipt.ts` | 写入路径保持唯一 | — |

### 5.2 方案 B（备选，仅 A 验证不足时）

| 文件 | 内容 |
|---|---|
| **新增** `src/patent/evidence/provenance-store.ts` | XiaoNuo `ProvenanceStore` 移植（`contentId`/`record`/`link`/`recordClaimRelation`/`query`/`findSupporting`/`findRefuting`/`findOrigins`），存储适配 Sati `DatabaseProvider`（better-sqlite3），库文件 `~/.sati/provenance/graph.db` |
| **新增** `src/patent/evidence/provenance-db.ts` | 建表/索引/WAL/迁移（对齐 XiaoNuo provenance-db.ts，路径改 `~/.sati/`） |
| **修改** `src/patent/evidence/index.ts` | barrel 导出 |

---

## 6. 风险与缓解

| 风险 | 级别 | 缓解 |
|---|---|---|
| **与现有证据体系重叠 → 双溯源**（最核心） | 高 | 方案 A 不做新数据结构（图是 ClaimBinding 的查询视图），从根上消除；方案 B 才需专门评估 |
| **敏感数据存储红线** | 高 | 方案 A 纯内存无存储；方案 B 库文件固定 `~/.sati/provenance/` + `.gitignore` + 按案件清理（TTL）；禁止进工作区 |
| 内容寻址"过度区分"（sha256 对空白/换行敏感） | 中 | 方案 A 不用内容寻址；方案 B 写入前归一化（trim/规范化换行） |
| canonical 序列化 TS 陷阱（BigInt/循环引用/`__proto__`） | 中 | 方案 B 移植时补防御性测试（XiaoNuo canonicalize 可直搬，TS 陷阱测试新写） |
| 多跳查询性能（"1 万节点 <20ms" 未在 Sati 验证） | 中 | 方案 A 先按案件规模 benchmark；退化时降级为单跳 + 应用层 BFS；环防护必须（有向图成环时 BFS 死循环） |
| 维护认知负担（trace/账本/DAG 三套"溯源"） | 低 | 文档明确边界：trace=过程、账本=工具证据、DAG=结论间关系（仅方案 B 时适用；方案 A 只有前两者） |

---

## 7. 交叉约束（与 #5/#7 方案）

| 交叉 | 约束 |
|---|---|
| **C1**（与 Search Commander） | 检索 provenance（数据源/参数/计数对账）是**审计附录格式**，只追加到报告末尾；**不写入**证据关系图。图只承载"结论↔证据"关系，不承载"检索过程" |
| **C3**（与回合反思） | 反思判定（"结论质量低"）是**元判断**，**不进证据图**（"AI 觉得证据不足" ≠ "证据反驳结论"）；反思记录走 telemetry/审计 |

---

## 8. 测试计划（`tests/patent/evidence/`）

| 测试文件 | 覆盖 |
|---|---|
| `dag.spec.ts` | 从 ClaimBinding 构建；多跳 ancestors/descendants；findSupporting/findRefuting 链展开；**环防护**（A→B→A 不死循环）；maxDepth 限制 |
| `dag-find-origins.spec.ts` | derived-from 回根追溯；跨多跳；孤儿节点（无来源）返回自身 |
| `dag-build.spec.ts` | 空绑定（空图）；未绑定 claim（无证据）→ 空结果 + `unbackedClaims()` 联动 |
| （方案 B）`provenance-store.spec.ts` | contentId 幂等；record/link 幂等（INSERT OR IGNORE）；query BFS；路径与清理 |

验收命令：`pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`。

---

## 9. 分阶段实施计划

| Phase | 内容 | 交付 | 验证 |
|---|---|---|---|
| **P0（决策）** | 用 §2 差异分析结论拍板方案 A / B；确认无效宣告多跳场景优先级 | 决策记录（本文档更新状态） | 与业务确认场景 |
| **P1** | 方案 A：`evidence/dag.ts`（构建 + BFS + 环防护） | 多跳查询层 | dag.spec 全绿 |
| **P2** | `findSupporting/findRefuting/findOrigins` + index barrel | 完整查询 API | dag-find-origins / dag-build spec 全绿 |
| **P3（可选）** | 接入消费方（如 `evaluate_evidence` 工具输出增加证据链视图） | 业务可见 | 集成测试 + 既有 evidence 测试回归 |
| **P4（备选）** | 若验证不足：方案 B 完整 DAG + SQLite | 跨案件图查询 | provenance-store spec + benchmark |

---

## 10. 不做（本期明确排除）

- **不引入**独立 SQLite graph.db（方案 A 下）；方案 B 仅在多跳查询需求跨案件/数据量 > 万级时启用
- **不替换** Receipt/Ledger/ClaimBinding/ConflictDetector（现有写入路径唯一）
- **不迁移** `contentHash` 到 sha256（现有 FNV-1a 校验语义保留；方案 B 的 canonical hash 是独立的图节点 id，与证据校验哈希无关）
- **不把**反思元判断 / 检索 provenance 写入证据图（C3/C1）
- **不引入** `@nuo/data` 依赖（方案 B 用 Sati DatabaseProvider）
