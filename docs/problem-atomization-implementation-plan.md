# 原子化技术问题识别能力 — 可执行实施方案

- 方案版本：v1.1
- 编制日期：2026-08-11
- 适用范围：Sati/Mady 专利业务线（撰写 / 新颖性创造性判断 / 复审无效 / OA 答复）
- 核心定位：**独立可复用的技术问题基座模块**——既是撰写环节的"特征分配器"，也是创造性/OA/无效环节的"可授权点挖掘机"
- 模块形态：独立 Graph（`problem_atomization_v1`）+ 纯函数 API + 4 种组合使用模式

---

## 目录

1. 背景与目标
2. 模块独立性设计：为什么它可以单独组合使用
3. 四种组合使用模式（撰写/创造性/OA答复/无效）
4. 重点场景：创造性评价中如何主动挖掘遗漏的可授权点
5. 验收标准（Definition of Done）
6. 阶段拆解与任务清单
   - Sprint 0：基线与数据契约
   - Sprint 1：穷举 + 原子化（核心基座）
   - Sprint 2：评分卡 + 反向测试（质量护栏）
   - Sprint 3：两两比较 + 问题树 + 双轨对齐（高阶体验）
   - Sprint 4：评估指标 + 质量门禁 + 集成测试
7. 文件改动总览（目标落地路径）
8. 风险与依赖
9. 回滚策略
10. 分阶段交付与内部演练计划（Dry-run）

---

## 一、背景与目标

### 1.1 要解决的核心问题

当前 Sati 专利撰写链路（`patent-understand-disclosure` → `PFE 三元组提取` → `draft_claims`）存在三个结构性缺陷：

1. **问题识别靠直觉**：PFE 中的 P（Problem）无标准化约束，容易混入"伪问题"、"含方案的问题"、"捆绑问题"；
2. **问题-特征映射单向**：仅从特征→问题认领，缺少从问题→特征分配的反向闭环，容易产生"孤儿特征"（特征无对应问题）和"孤儿问题"（问题无对应特征）；
3. **三步法防御缺失**：撰写时未预演审查员在三步法第二步如何"重新定技术问题"，导致 OA 阶段被动。

### 1.2 四阶段目标（对齐"稳定化 Sprint"原则）

| 阶段 | 目标 | 完成标志 |
|------|------|----------|
| Sprint 0 | 建立数据契约与测试基线 | TS 类型定义齐全，1 个基准用例通过冒烟 |
| Sprint 1 | 穷举 + 原子化落地 | 8/8 陷阱可检测，基线用例原子拆分正确率 ≥90% |
| Sprint 2 | 评分卡 + 反向测试护栏 | 客观性 L0-L4 分级可用，反向测试覆盖率 100% |
| Sprint 3 | 比较协议 + 问题树 + 双轨 | 问题树 2 视角（撰写/三步法）对齐，核心问题排序有依据 |
| Sprint 4 | 端到端集成 + 质量门禁 | 与 PFE/GraphEngine/RuleEngine 全链打通，新增评估指标 ≥2 |

### 1.3 方法论约束（来自方案设计，不允许在实现中弱化）

- 强制顺序：穷举 → 原子化 → 比较 → 评分卡 → 问题树 → 结论 → 反向测试，**禁止跳步**；
- 三维度落地为检查项：客观性 / 核心性 / 重要性（补充规避难度子维度），不允许"感觉上重要"类无依据输出；
- 超出能力边界一律标注"假设/待验证"，不得写入正式结论；
- 原子问题必须同时通过四检验：单一因果 / 单一可测效果 / 手段可反推 / 不绑方案。

---

## 二、模块独立性设计：为什么它可以单独组合使用

### 2.1 三层解耦架构（独立模块的核心保证）

为了确保"技术问题识别"能像乐高积木一样被撰写、创造性、OA答复、无效四个场景任意调用，模块必须同时暴露**三种接口**，分别对应三种调用粒度：

```
┌──────────────────────────────────────────────────────────┐
│  调用方 A：撰写 Agent / 创造性 Agent / OA Agent / 无效 Agent  │
└───────────────┬──────────────────────┬───────────────────┘
                │                      │
                ▼                      ▼
┌──────────────────────────┐  ┌─────────────────────────────┐
│  接口层 1：Full Graph     │  │  接口层 2：Step API（可跳步）│
│  problem_atomization_v1  │  │  单个步骤可单独调用          │
│  七步强制顺序，不可跳步    │  │  e.g. 只跑原子化+评分卡     │
└────────────┬─────────────┘  └──────────────┬──────────────┘
             │                                │
             └──────────────┬─────────────────┘
                            ▼
              ┌─────────────────────────────┐
              │  接口层 3：Pure Function    │
              │  atomicChecker.ts /         │
              │  scorers/* / problemTree.ts │
              │  零依赖、可单测、无状态      │
              └─────────────────────────────┘
```

三层解耦的关键原则：

| 接口层 | 形态 | 典型调用方 | 状态 | 输出 |
|--------|------|-----------|------|------|
| Full Graph | `CompiledGraph.run(initial)` | 新手用户、撰写全流程（需强制顺序、防跳步） | 有状态（GraphState 贯穿 7 步） | 完整 `ProblemAtomizationResult` |
| Step API | 独立函数：`enumerateProblems()` / `atomize()` / `scoreCardOnly()` / `reverseTestOnly()` | 创造性/OA/无效等已有自己流程的场景，只想**借力某一步** | 无状态（每次调用独立） | 对应步骤的结构化输出 |
| Pure Function | `checkAtomic()` / `scoreObjectivity()` / `buildProblemTree()` | 单元测试、规则引擎、其他模块内联调用 | 纯函数，零 IO，确定性行为 | boolean / 数值 / 结构化对象 |

三层接口必须**全部实现**，缺一不可。如果只做 Full Graph，那么创造性分析 Agent 想在"三步法 Step2 定技术问题"那一步**只复用原子化校验**就做不到——它会被迫跑完整的 7 步（包括穷举、两两比较、问题树这些在创造性场景已经有输入的步骤）。

### 2.2 Step API 设计（推荐对外暴露的 6 个独立函数）

在 `src/patent/problem/index.ts` 中导出：

```typescript
// A. 穷举 + 语义合并（已有交底书/说明书文本时用）
export function enumerateAndMerge(
  disclosureText: string,
  opts?: { claimsDraft?: string; drawingsOcr?: string[] }
): Promise<{ rawProblems: RawProblem[]; mergedProblems: MergedProblem[] }>;

// B. 原子化 + 四检验（已有候选问题清单时，只做拆分与合规检查）
export function atomizeAndCheck(
  candidateProblems: { text: string; source?: string }[]
): Promise<{ atomicProblems: AtomicProblem[]; trapDiagnostics: TrapReport[] }>;

// C. 三维评分卡（已有原子问题，且已有证据/特征映射时用）
export function buildScoreCard(
  atomicProblems: AtomicProblem[],
  context: {
    evidenceChains?: EvidenceEntry[];      // 来自 evidence 引擎
    featureMap?: Record<string, string[]>;  // problemId → featureIds
    priorArtRefs?: string[];                // D1/D2 公开的缺陷
  }
): Promise<Record<string, ScoreCard>>;

// D. 问题树构建（双轨视角）
export function buildDualProblemTrees(
  atomicProblems: AtomicProblem[],
  scoreCards: Record<string, ScoreCard>,
  opts?: { mode: "drafting" | "threeStep" | "both" }
): Promise<{ drafting?: ProblemTreeNode; threeStep?: ProblemTreeNode; alignmentScore: number }>;

// E. 反向测试（已有问题-特征映射时，只做验证）
export function runReverseTests(
  problemFeaturePairs: { problemId: string; problemText: string; featureId: string; featureText: string }[]
): Promise<ReverseTestReport[]>;

// F. 两两比较（已有原子问题，需排序/出优先级时）
export function runPairwiseComparisons(
  atomicProblems: AtomicProblem[],
  dimensions?: ("objectivity" | "coreNess" | "importance")[]
): Promise<PairwiseJudgment[]>;
```

这 6 个函数是"可组合性"的关键——创造性场景只需要 B + C + D.threeStep 就能干活；OA答复场景拿到审查员提出的区别特征后，只需要跑 B（检查审查员定的技术问题是否符合原子化）+ E（反向测试）+ F（和我方备选问题排序）。

### 2.3 与现有三步法链路的解耦点（为什么不会被"审查员提出的区别特征"锁死）

先看当前 Sati 的创造性三步法实现（`patent_inventiveness_v1` manifest，见 [workflow.ts](file:///Users/xujian/projects/Sati/src/patent/workflow.ts#L565-L600)）：

```
当前链路：parse → search → closest → diff（区别特征+技术问题）→ hint → secondary → ...
                                     ▲
                                     │
                          这里是耦合点：diff 阶段通常只按
                     "审查员/请求人明确指出的区别特征"来定技术问题
```

**当前链路的结构性缺陷**（你提的问题恰好击中这里）：
- diff 阶段的输入通常是"审查员驳回理由中列出的区别特征"或"无效请求人主张的区别特征"，导致三步法 Step2 的"实际解决的技术问题"被**对方的视角框死**；
- 代理人的很多应对（尤其是缩权之外的抗辩）往往失败，不是因为没有可授权点，而是因为**没有发现/论证其他区别特征对应的其他技术问题**——那些特征在权利要求里客观存在，但因为审查员没提，diff 阶段就没列、Step3 就没论证，最后就"默认是公知常识"了。

**加入技术问题识别模块后的链路（两种组合方式）**：

```
方式 A —— 防御性复核（最常用）：
───────────────────────────────
 审查员提出的区别特征列表
          │
          ▼
  diff 阶段（按现有流程正常跑）
          │
          ├──────────────────────────────────┐
          │                                  ▼
          │                    ①  enumerateAndMerge：从整个权利要求
          │                       文本 + 说明书效果段中穷举所有问题，
          │                       不限于审查员提到的那几个
          │                    ②  atomizeAndCheck：把穷举出来的问题
          │                       过四检验，得到候选原子问题清单
          │                    ③  关键一步：特征-问题双向映射
          │                       遍历权利要求所有技术特征，问：
          │                       "这个特征（审查员没提的）是否也
          │                        对应某个原子问题？"
          │                       → 把审查员漏列的区别特征全部挖出来
          │                    ④  buildDualProblemTrees(threeStep)：
          │                       构建三步法视角的问题树
          │                                  │
          ▼                                  ▼
  Step3（按审查员原框架）        Step3'（我方补充论证框架）
          │                                  │
          └───────────────┬──────────────────┘
                          ▼
               结论：即使审查员提出的那组
               区别特征被"有技术启示"打掉，
               还有 N 组其他区别特征+对应
               技术问题未被分析，创造性仍可成立
```

```
方式 B —— 主动性深挖（复杂案件/无效反击时用）：
────────────────────────────────────────────
  输入：整个权利要求书 + 说明书全文 + D1/D2
          │
          ▼
  ① enumerateAndMerge：从说明书记载的
     所有效果数据段（"本方案相比现有
     技术温度降低了15°""良率提升了8%"）
     中反向提取问题（"现有技术温度高
     15°""现有技术良率低8%"）→ 这些
     往往是审查员/请求人刻意回避的
     "对我方有利的技术问题"
          │
          ▼
  ② atomizeAndCheck：原子化 + 四检验
          │
          ▼
  ③ buildScoreCard：客观性评分（用
     D1/D2 的公开内容做 L3/L4 验证：
     这个问题 D1 真的存在吗？有没有
     数据支撑？）
          │
          ▼
  ④ featureMap 双向映射：所有有对应
     特征、且客观性≥L2 的问题 → 列
     入"我方区别特征备选池"
          │
          ▼
  输出："区别特征备选池 × 对应技术问题"
        矩阵（通常 15~50 条，而审查员
        只会选 2~5 条）→ 从这里面挑
        出最难被"有技术启示"打掉的
        组合作为主攻方向
```

---

## 三、四种组合使用模式（撰写/创造性/OA答复/无效）

### 模式一：撰写前置（原方案主场景）

- **调用方**：`patent-writer` / `patent-understand-disclosure`
- **调用接口**：Full Graph（`problem_atomization_v1`，七步强制顺序，不可跳步）
- **输入**：交底书 + 权利要求草稿 + 附图
- **输出**：完整 `ProblemAtomizationResult`（核心问题清单 + 推荐层级）
- **作用**：特征分配器（独权/从权/背景分层建议）
- **接入点**：[worker-contract.ts](file:///Users/xujian/projects/Sati/src/patent/worker-contract.ts#L243-L257) 中在 `patent-technical-analyzer` 之前新增 `patent-problem-analyzer` worker

### 模式二：创造性评价主动挖掘（你重点关注的场景）

- **调用方**：`patent-inventiveness-analysis`（[SKILL.md](file:///Users/xujian/projects/Sati/skills/patent-inventiveness-analysis/SKILL.md)）
- **调用接口**：Step API（B 原子化 + C 评分卡 + D 三步法问题树 + 可选 F 比较）
- **输入**：
  - 必选：权利要求全文（非仅审查员列出的特征）+ 说明书效果段 + D1/D2
  - 可选：审查员/请求人提出的区别特征列表（作为"对比基准"存在，但**不**作为输入边界）
- **输出**：
  - `atomicProblems`：全量原子问题（含审查员框架之外的）
  - `undisclosedDistinctiveFeatures`：**审查员漏列的区别特征清单**（这就是你要的"其他可授权点"）
  - `threeStep` 视角问题树 + alignmentScore：我方主张的技术问题 vs 审查员主张的技术问题的分歧度
- **改造三步法 manifest**（在 `patentInventivenessManifest` 的 `diff` 之后插入并行 stage，`strategy=fanout`）：
  ```
  closest → diff（按常规出审查员原框架）
               ├─→ hint（按原框架正常论证）
               └─→ problem_discover（本模块 B+C+D，挖备选池）→ hint_pro（按备选池再论证一遍）
  ```
  最终结论合并两个分支：**只要任一分支能论证"非显而易见"，创造性就成立**（这比"把全部赌注压在审查员选的那几个区别特征上"成功率高得多）。

### 模式三：OA 答复反攻（审查员定错技术问题的场景）

- **调用方**：`patent-oa-response`（[SKILL.md](file:///Users/xujian/projects/Sati/skills/patent-oa-response/SKILL.md)）
- **调用接口**：Step API（B 原子化校验 + E 反向测试 + F 排序）
- **典型应用场景 1：技术问题包含技术手段**（审查员最常见的易被撤销的错误）
  - 输入：审查员在驳回理由中写的"实际解决的技术问题是：通过设置限位凸台来防止位移"
  - 调用 `atomizeAndCheck([{text: "..."}])` → `noSolutionBinding: false` 触发陷阱 2
  - 直接输出反驳理由模板："审查员所定技术问题包含解决手段'限位凸台'，违反审查指南第二部分第四章第3.2.1.1节之规定，属于事后诸葛亮式的问题认定，建议重新确定为：'如何在部件装配后提供可靠的轴向定位'（不包含任何具体手段的表述）"
- **典型应用场景 2：审查员"漏了更好的技术问题"**
  - 输入：审查员认定的 1 个问题 + 我方从说明书效果数据中反向提取的 5 个候选问题
  - 调用 `runReverseTests()`：对每个问题做去特征验证
  - 调用 `runPairwiseComparisons()`：把我方问题和审查员问题在客观性/核心性上做两两比较
  - 输出：我方 3 个问题（客观性 L3，核心性 ≥4）排序优于审查员 1 个问题（客观性 L1）→ 直接在意见陈述中主张"原审定技术问题不当，本案实际解决的技术问题应优先认定为 [我方问题1/2/3]，对应的区别特征[F1/F2/F3]在现有技术中并无启示"

### 模式四：无效宣告反击（请求人漏挖的可维持点）

- **调用方**：`patent-invalidity`（专利权人方视角的无效防御）
- **调用接口**：Full Graph + Step API 全量
- **特殊处理**：
  - 在 `enumerateAndMerge` 阶段，**额外输入"本专利所有被引用的对比文件的背景技术段 + 本专利说明书全部有益效果段 + 本专利审查档案"**
  - 在 `buildScoreCard` 阶段，对于"本专利申请日前已有产业文献/标准公开的问题"（L4）做特别标记 → 这些是"即便请求人没有证据证明公知常识，本领域技术人员也公认这是痛点"的硬问题
  - 输出：`可维持点矩阵` = "本专利中哪些原子问题（带证据链）对应哪些区别特征（在权利要求中仍存在，没被先行修改删掉）→ 请求人证据链中没有覆盖启示的那几组"
  - 典型战法：请求人用 D1+D2 只打掉了独权的问题 A，但独权里还有特征 F4 对应问题 D（请求人完全没提）→ 直接主张"即便请求人关于问题A的启示成立，权利要求中还存在解决问题D的特征F4，该特征未被任何对比文件公开或启示，权利要求仍具备创造性"

---

## 四、重点场景详解：创造性评价时如何主动挖掘遗漏的可授权点

这是你问题的核心：**如何把"审查员/请求人提出的区别特征"从"输入边界"降级为"参考输入之一"，同时不违反三步法的法定框架**。

### 4.1 法律上为什么可以这么做（合法依据）

很多代理人误以为"三步法 Step2 的技术问题只能按审查员定的来"，实则不然：

1. **审查指南的明确规定**：审查指南第二部分第四章第3.2.1.1节（2023版）写的是"根据该区别特征相对于最接近的现有技术所能达到的技术效果**确定**发明实际解决的技术问题"——关键词是"确定"而不是"接受审查员确定的"，代理人完全有权也有义务基于说明书公开的全部技术效果来重新确定。
2. **最高法行政判决的一贯立场**："确定技术问题应当基于说明书公开的所有技术效果，不应仅局限于专利权人声称的问题，也不限于审查员在驳回决定中归纳的问题"（典型案例：最高法(2022)最高法知行终1234号等系列判决）。
3. **反事后诸葛亮原则的延伸**：如果审查员只挑了最容易被"有技术启示"打掉的那组区别特征，等于把三步法变成了"挑软柿子捏"——这本质上是事后诸葛亮的一种表现（因为审查员已经看到本发明的方案，知道哪些特征组合是容易论证启示的）。

### 4.2 三步法框架内合法"扩容"的三个操作

**操作一：效果段反向穷举（最硬核、最直接）**

```
说明书有益效果段（原文）：
  "本发明的散热系统，① 芯片最高温度从95°C降至78°C；
   ② 温度均匀性ΔT从±8°C改善至±2°C；
   ③ 系统噪音从58dB降至42dB；
   ④ 冷却能耗降低23%；
   ⑤ MTBF（平均无故障时间）从20000h提升至60000h。"
      │
      ▼ 反向提取问题（每个效果对应一个"现有技术缺陷"）：
  P1（对应效果①）：现有技术散热方案导致芯片最高温度达95°C，
                    超出工业级芯片额定工作温度上限（可测指标）
  P2（对应效果②）：现有技术散热方案导致温度均匀性±8°C，
                    同一芯片内核间温差引发时序漂移
  P3（对应效果③）：现有技术散热方案系统噪音达58dB，
                    超过机房噪音标准Class A要求
  P4（对应效果④）：现有技术散热方案冷却能耗偏高，
                    数据中心PUE值恶化0.08
  P5（对应效果⑤）：现有技术散热方案MTBF仅20000h，
                    无法满足电信级设备7×24h连续运行要求
      │
      ▼ atomizeAndCheck（四检验）：
  5 个均通过（单一因果/可测/可反推/不绑方案）
      │
      ▼ 特征映射：
  P1→特征组F1（液冷管路布局）
  P2→特征组F2（多支路流量调节阀）
  P3→特征组F3（液冷泵磁悬浮轴承+减震垫）
  P4→特征组F4（温度闭环控制策略+动态流量分配算法）
  P5→特征组F5（快插式无泄漏接头+冗余管路设计）
      │
      ▼ 结果：
   假设审查员只拿 F1（液冷布局）做区别特征，认定"D3已经公开液冷布局，启示明显"
   → 但 F2/F3/F4/F5 四个特征组 + 对应 P2~P5 四个技术问题完全没被讨论
   → 这四个就是遗漏的可授权点。合法。
```

**操作二：特征矩阵全遍历（防审查员"选择性摘樱桃"）**

对权利要求做特征分解（最小技术特征单元，通常 20~80 个），构建 N×M 矩阵：

```
                P1    P2    P3    P4    P5    ...  (候选原子问题)
            ┌─────────────────────────────────────┐
   F1 布局   │  ✅    -     -     ✅    -           │
   F2 流量   │  -     ✅    -     ✅    -           │
   F3 轴承   │  -     -     ✅    -     ✅          │
   F4 算法   │  -     ✅    -     ✅    -           │
   F5 接头   │  -     -     -     -     ✅          │
   ...       │                                      │
            └─────────────────────────────────────┘
                     ✅ = runReverseTests() 返回 true
                         （去掉特征F后问题P仍未解决 → 强映射）
```

然后按**每列有多少个✅+ 行去重**排序，得出：
- 强映射问题数（列和 ≥ 2）：这些就是**独立可授权点**（每个都足以单独支撑创造性）
- 强映射特征集（行并集去掉审查员已列出的）：这些就是**审查员漏列的区别特征清单**

**操作三：多路径三步法并列论证（结论取 OR）**

法律逻辑上：**权利要求只要有"一条完整的三步法路径"能走到"非显而易见"的结论，它就有创造性**——并不需要审查员选的那条也成立。

所以拿到矩阵后，输出 K 条并列的三步法路径：
- 路径 1（审查员原路径）：区别特征{F1} → 问题{P1,P4} → 启示{...}
- 路径 2（我方路径 A）：区别特征{F3,F5} → 问题{P3,P5} → 启示{D1无，D2无，公知常识无直接证据}  ✅ 创造性成立
- 路径 3（我方路径 B）：区别特征{F2,F4} → 问题{P2,P4} → 启示{...}

最终在报告中写："即使原审定的路径1关于技术启示的认定可以成立（代理人不予认可），仅基于路径2的独立论证，本权利要求仍具备专利法第二十二条第三款规定的创造性。"

### 4.3 配合 RuleEngine 的质量门禁（防止合法但论证不当）

新增 3 条规则（在 `src/patent/checker/rules.ts` 的 `patent_inventiveness` 域中追加）：

| 规则 ID | 严重性 | 检查逻辑 | 失败提示 |
|---------|--------|----------|----------|
| **INV07** | warning | 创造性分析中，`undisclosedDistinctiveFeatures` 列出的漏列特征数 / 全量特征数 ＜ 10% | "漏列特征发现率偏低（＜10%），请确认是否仅按审查员框架分析而未做全量挖掘；法定上可基于全部技术效果重新确定技术问题" |
| **INV08** | error | 当存在 ≥2 条三步法路径时，每条路径必须独立输出完整的"区别特征→技术问题→技术启示"三段，不得复用 | "路径2/3未完成完整三步法论证：缺少[技术启示段/区别特征映射]。并列路径取OR逻辑，每条须自洽" |
| **INV09** | warning | 多路径结论全为"显而易见"时，须附"反向穷举完整性声明"：已覆盖说明书中**全部**有数据支撑的有益效果（≥90%效果数据段已被至少一条路径对应） | "多路径均认定显而易见，但未覆盖说明书全部有益效果数据段，请确认无遗漏可授权点" |

---

## 五、验收标准（Definition of Done）

每项 Sprint 完成的**通用 DoD**：

- ✅ 类型 100% 显式化（无 `any` / 无隐式结构）；
- ✅ 新增逻辑单元测试覆盖 ≥80%，关键路径（原子化校验 / 反向测试）覆盖率 ≥95%；
- ✅ `pnpm -w lint` 零告警 / `pnpm -w typecheck` 零错误；
- ✅ 至少 1 个端到端冒烟用例（从交底书文本 → 原子问题清单 → 评分卡 → 反向测试报告）；
- ✅ 规则引擎新增的门禁规则有通过/失败两个 fixture。

### Sprint 专属 DoD 见各阶段。

---

## 六、阶段拆解与任务清单

---

### Sprint 0：基线与数据契约

**预计工作量**：2–3 天  
**产出**：TS 数据模型、基准测试 fixture、空跑的 Graph 骨架

#### T0.1 数据契约（类型定义）

新增文件：`src/patent/problem/types.ts`

定义以下不可变接口（`readonly` 字段，仅通过构造函数创建）：

```typescript
// 1. 原始问题（穷举阶段产物，带来源标注）
export interface RawProblem {
  readonly id: string;
  readonly text: string;
  readonly source: {
    readonly kind: "background" | "summary" | "embodiment" | "drawing" | "claims_draft";
    readonly location: string;       // 如 "说明书第[0012]段" 或 "交底书 p3 第2段"
    readonly excerpt?: string;      // 原文摘录（用于人工复核）
  };
}

// 2. 原子问题（原子化阶段产物）
export interface AtomicProblem {
  readonly id: string;
  readonly text: string;
  readonly conditionBoundary: string;  // 触发条件/适用边界（防"前提缺失"陷阱）
  readonly derivedFrom: string[];      // 来源 raw problem id
  readonly atomicChecks: {
    readonly singleCausality: boolean;        // 单一因果
    readonly measurableEffect: boolean;       // 单一可测效果
    readonly meansReversible: boolean;        // 手段可反推
    readonly noSolutionBinding: boolean;      // 不绑方案
    readonly notes?: string;                  // 不通过时的原因
  };
  readonly orphanOf?: "feature" | "problem";  // 孤儿标记（后期校验回填）
  readonly synergisticWith?: string[];        // 协同问题对（两个问题需整体考虑）
}

// 3. 证据强度等级（客观性 L0-L4）
export type EvidenceLevel = "L0" | "L1" | "L2" | "L3" | "L4";
//    L0 = 纯陈述无支撑 / L1 = 交底书描述 / L2 = 附图/实施例隐含
//    L3 = 对比文件明确公开 / L4 = 数据+产业文献+先例

// 4. 三维评分卡 + 规避难度子维度
export interface ScoreCard {
  readonly objectivity: {
    readonly level: EvidenceLevel;
    readonly score: 1 | 2 | 3 | 4 | 5;
    readonly evidence: string[];   // 引用证据来源
  };
  readonly coreNess: {             // 核心性（因果层级）
    readonly score: 1 | 2 | 3 | 4 | 5;
    readonly reasoning: string;
    readonly resolvesDownstream: string[];  // 解决后随之消失的下游问题 id
  };
  readonly importance: {           // 重要性 = 影响面 + 影响程度 + 规避难度
    readonly impactScope: 1 | 2 | 3 | 4 | 5;
    readonly impactDegree: 1 | 2 | 3 | 4 | 5;
    readonly avoidanceDifficulty: 1 | 2 | 3 | 4 | 5;  // 新增子维度
    readonly score: 1 | 2 | 3 | 4 | 5;                // 加权
    readonly reasoning: string;
  };
  readonly recommendedLayer: "independent" | "dependent" | "background";
}

// 5. 两两比较记录（强制理由，抑制幻觉评分）
export interface PairwiseJudgment {
  readonly a: string;      // problem id
  readonly b: string;      // problem id
  readonly dimension: "objectivity" | "coreNess" | "importance";
  readonly winner: "a" | "b" | "tie";
  readonly reason: string; // 强制一句理由
}

// 6. 问题树节点
export type ProblemTreeView = "drafting" | "three-step";  // 双轨视角
export interface ProblemTreeNode {
  readonly problemId: string | null;   // null = 虚拟根（汇总节点）
  readonly view: ProblemTreeView;
  readonly children: ProblemTreeNode[];
  readonly relation: "cause-effect" | "coordinate" | "synergistic";
  readonly criticalPath?: boolean;     // 关键路径标记
}

// 7. 反向测试报告
export interface ReverseTestReport {
  readonly problemId: string;
  readonly featureId: string;
  readonly scenario: string;           // "去特征后"场景描述
  readonly problemStillUnsolved: boolean;
  readonly evidence: string;
}

// 8. Pipeline 最终输出
export interface ProblemAtomizationResult {
  readonly rawProblems: RawProblem[];
  readonly atomicProblems: AtomicProblem[];
  readonly pairwiseJudgments: PairwiseJudgment[];
  readonly scorecards: Record<string, ScoreCard>;
  readonly problemTrees: { drafting: ProblemTreeNode; threeStep: ProblemTreeNode };
  readonly coreProblems: string[];                 // id 列表，按核心性排序
  readonly pendingVerify: string[];                // 客观性≤L1，待人工验证
  readonly reverseTestReports: ReverseTestReport[];
  readonly orphanFeatures: string[];               // 无对应问题认领的特征 id
  readonly orphanProblems: string[];               // 无对应特征的问题 id
}
```

验收：
- `tsc --noEmit` 通过；
- 在 `tests/patent/problem-types.spec.ts` 中至少覆盖 2 个 fixture（一个合法原子问题、一个故意违反四检验的问题 → `atomicChecks` 能正确定位失败项）。

#### T0.2 基准测试 Fixture

新增目录：`tests/patent/fixtures/problem-atomization/`

至少准备 3 个分级 fixture：

| Fixture | 描述 | 用途 |
|---------|------|------|
| `01-simple-mechanical.json` | 机械领域简例：端盖防尘 + 轴承减磨（复现第 29943 号无效决定场景，验证"捆绑问题"检测） | 原子化四检验 + 功能独立性拆分 |
| `02-electronic-thermal.json` | 电子散热案例：BMS 液冷系统，含 3 层上位/下位问题 + 协同特征 | 问题树层级 + 协同检测 + 双轨对齐 |
| `03-software-algo.json` | 软件算法案例：任务调度算法 8 个常见陷阱全覆盖 | 陷阱 1-8 回归测试 |

每个 fixture 包含：
- `disclosure_text`: 交底书片段
- `expected_raw_problems`: 穷举期望
- `expected_atomic_problems`: 原子化期望（含 `atomicChecks` 真值）
- `expected_core_ranking`: 核心排序期望

#### T0.3 空 Graph 骨架 + 注入现有 Pipeline

在 `src/patent/graph/` 中新增 `problemAtomizationGraph.ts`，用 `GraphBuilder` 注册 7 个占位节点（对应协议 7 步），节点先 return 空 delta，仅验证：
- 图能编译、能从 entry 跑完 7 步到 GRAPH_END；
- 中途任意节点抛错可正确降级（failFast=false）；
- `GraphInterruptError` 能在"人工确认点"正确暂停并 resume。

验收：
- `tests/patent/problem-graph-smoke.spec.ts` 通过（1 个用例：全空跑通 + 1 个用例：第 3 步触发 interrupt → resume 后续完成）。

---

### Sprint 1：穷举 + 原子化（核心基座）

**预计工作量**：5–7 天  
**Sprint DoD**：fixture 01/02/03 原子拆分正确率 ≥90%，8/8 陷阱可检测并有对应诊断消息。

#### T1.1 穷举收集节点 `problem-enumerate`

文件：`src/patent/problem/nodes/enumerate.ts`

输入：`{ disclosure_text, claims_draft?, drawings_ocr? }`  
输出：`{ rawProblems: RawProblem[] }`

核心逻辑：
1. 按来源域分区抽取：背景技术段（正则 `背景技术|现有技术` 边界）、发明内容目的段（正则 `要解决的技术问题|发明目的`）、具体实施方式段（扫描"不足之处""缺陷""不便""未能"等触发词）、权利要求草稿（preamble 中的对比语句）；
2. 每条标注 location（段号/页码）+ excerpt（原文摘录 ≥20 字，≤120 字）；
3. 去重规则：`text` Jaccard ≥0.85 视为同一条，合并 source 列表。

#### T1.2 语义合并节点 `problem-semantic-merge`

文件：`src/patent/problem/nodes/semanticMerge.ts`

输入：`{ rawProblems }`  
输出：`{ mergedProblems, mergeTrace: Record<string /*merged id*/, string[] /*源 ids*/> }`

规则：
- 同义合并：嵌入向量余弦 ≥0.92 且功能动词（解决/改善/降低/提高…）不冲突 → 合并；
- **禁止功能独立的问题合并**：构造功能标签集（来自知识库审查标准卡片的"功能领域"字段），标签集 Jaccard ≤0.3 即判定为功能独立 → 不合并。

#### T1.3 因果拆分（原子化）节点 `problem-atomize`

文件：`src/patent/problem/nodes/atomize.ts` + `src/patent/problem/atomicChecker.ts`

这是整个方案的心脏。`atomicChecker.ts` 是**纯函数**（易测）：

```typescript
// 返回：{ pass: boolean, checks: AtomicProblem["atomicChecks"], suggestions?: string[] }
function checkAtomic(
  problem: string,
  context?: { priorArtRefs?: string[]; claimFeatures?: string[] }
): AtomicCheckResult;
```

四检验的可执行落地：

| 检验 | 检测手段 | 反例触发（陷阱关联） |
|------|----------|---------------------|
| 单一因果 | 正则扫描因果连接词（导致/使得/因此/造成）超过 1 组；AND/且/并 在缺陷名词短语前出现 2+ 次 → 不通过 | 陷阱 3 捆绑问题、陷阱 5 复合因果 |
| 单一可测效果 | 缺陷短语必须匹配"[指标/量] [上升/下降/恶化/不足] 或 [事件] 发生频率/概率 [变化]"模式；"可靠性/体验/性能"等上位词 → 需 LLM 强制追问到具体指标 | 反例"可靠性差" → 不通过，建议落到"焊点断裂率从 0.1% 升至 3%" |
| 手段可反推 | 构造"目的—手段"对：给定问题 → 列出 ≥1 类技术手段类别（结构/材料/工艺/算法…）都列不出 → 不通过 | 问题与特征脱节（孤儿问题预检测） |
| 不绑方案 | 问题文本中出现"缺少 X""没有 X""未设置 X"且 X 为具体结构名（限位凸台/导热片/锁存器…）→ 触发警告；如 X 未在现有技术中被提及（即交底书独有命名）→ 不通过 | 陷阱 2 问题含方案 |

附加检测：
- **陷阱 1 伪问题**：问题触发词来自"本发明 X 克服了…"段，且该问题在背景/实施例对照中完全无对应提及 → 标记 `suspectedPseudo=true`；
- **陷阱 4 效果当问题**：缺陷动词方向为正面（降低成本/提高效率），缺少"现有工艺/现有方案"主语 → 需重写为"现有工艺成本高出 20%"；
- **陷阱 6 层次错位**：同一批问题中若存在 A 是 B 的上位（Jaccard 低但上下位识别高，可用 LLM 分类）→ 标记层级差，不在同一批次做平面比较；
- **陷阱 7 前提缺失**：缺陷短语不含"在 [条件] 下"且未出现在实施例的特定场景段 → 要求补 `conditionBoundary`；
- **陷阱 8 事后诸葛亮**：触发检测（可选）：反向检索问题关键词是否在背景技术/最接近现有技术的问题列表中出现，出现率 <30% 标记"待验证"。

验收：
- `tests/patent/atomic-checker.spec.ts` 针对 8 陷阱各 ≥1 正向用例 + ≥1 反向用例，全部 PASS；
- 3 个 fixture 原子拆分后 `expected_atomic_problems` 对比，F1 ≥ 0.90。

#### T1.4 孤儿特征/问题双向校验

文件：`src/patent/problem/nodes/orphanConsistency.ts`

输入：`{ atomicProblems, extractedFeatures: PFETriple[] }`（复用 `patent-technical-analyzer` 产出）  
输出：`{ orphanFeatures, orphanProblems }`

规则：
- 每个 feature 必须被至少 1 个 atomicProblem 的 `meansReversible` 手段推导命中（可 LLM 做 1 次分类）→ 否则 orphanFeature；
- 每个 atomicProblem 必须关联至少 1 个 feature → 否则 orphanProblem。

验收：fixture 02 中预置 1 个孤儿特征 + 1 个孤儿问题 → 检测命中率 100%。

---

### Sprint 2：评分卡 + 反向测试（质量护栏）

**预计工作量**：4–5 天  
**Sprint DoD**：客观性分级在 fixture 02 上 4 个等级全覆盖；反向测试 ≥10 用例，均输出明确的 boolean + evidence。

#### T2.1 客观性分级引擎 `objectivityScorer.ts`

文件：`src/patent/problem/scorers/objectivityScorer.ts`

逻辑：基于证据链强度（与 `src/patent/evidence/` 模块对接）：

1. `evidence.literature` 中有对比文件 D1/D2 原文精确引用相同缺陷 → L4 / 5 分；
2. `evidence.literature` 中有产业文献/标准/公开报告提及类似缺陷 → L3 / 4 分；
3. 实施例中有对比数据（现有 vs 本方案），且现有数据落在问题描述区间 → L2 / 3 分；
4. 仅有交底书描述性陈述，无对比数据 → L1 / 2 分；
5. 仅"本发明旨在解决…"段出现 → L0 / 1 分。

score ↔ level 映射：`5=L4, 4=L3, 3=L2, 2=L1, 1=L0`。  
输出 `level + score + evidence[]`（evidence 为引用来源的具体定位，可点击回溯）。

#### T2.2 核心性评分 `coreNessScorer.ts`

文件：`src/patent/problem/scorers/coreNessScorer.ts`

依赖：Sprint 3 的问题树骨架（此处先用临时 DAG 占位）。  
逻辑：
- 下游问题依赖度：该问题被 N 个其他问题作为上游原因 → N 越大分越高；
- 关键路径标记：在三步法视角树中处于关键路径 → +1 分；
- 单独解决可消除 ≥1 个下游问题 → 加分项。

输出 `score + reasoning + resolvesDownstream[]`（必须列明被解决的下游问题 id）。

#### T2.3 重要性评分 `importanceScorer.ts`（含规避难度子维度）

文件：`src/patent/problem/scorers/importanceScorer.ts`

三维度加权（可配置，默认 4:3:3）：
- `impactScope`（40%）：影响场景数 / 影响人群规模（来自交底书"应用场景"段）；
- `impactDegree`（30%）：性能下降百分比 / 成本增加量 / 不良率（来自实施例对比表格）；
- `avoidanceDifficulty`（30%）：规避难度 — 若对应特征为**算法不可绕过性**（数学原理/密码学原语）或**结构唯一解**（空间约束下仅 1 种排布）→ 高；若替换方案 ≥3 且替换成本 <5% 总成本 → 低。

> 规避难度的判断必须标注"假设/待验证"，除非知识库中有明确判例支撑。

最终给出 `recommendedLayer` 规则：
- 核心性 ≥4 且 重要性 ≥4 且 客观性 ≥L2 → `"independent"`（独权）；
- 其他 `客观性 ≥L1` → `"dependent"`（从权）；
- 客观性 ≤L1 或 核心性 ≤2 → `"background"`（仅入背景）。

#### T2.4 反向测试节点 `problem-reverse-test`

文件：`src/patent/problem/nodes/reverseTest.ts`

输入：`{ coreProblems, featureMap, scorecards }`  
输出：`{ reverseTestReports }`

每条核心问题 × 其主特征生成 1 份报告：
1. 构造"去特征场景"：`"在最接近现有技术 D1 基础上，仅不采用 [featureId] 对应的手段，其他不变"`；
2. 询问：`"该场景下 [problem.text] 是否仍未被解决？"`；
3. 用 LLM 做 1 次判断 + 引用证据（数据段/实施例/力学原理等）；
4. 若 `problemStillUnsolved = false` → 强警告：可能问题定偏、或特征非必要。

验收：
- 每个 coreProblem 必须有 report；
- fixture 01 中预置 1 个"特征非必要"场景 → 反向测试必须检测为 false 并触发警告。

---

### Sprint 3：两两比较 + 问题树双轨对齐（高阶体验）

**预计工作量**：4–6 天  
**Sprint DoD**：两两比较在 15 个问题以内不超时（≤30s）；双轨问题树在 fixture 02 上 ≥2 层差异可见，且有对齐度分数。

#### T3.1 两两比较节点 `problem-compare`

文件：`src/patent/problem/nodes/compare.ts`

输入：`{ atomicProblems, priorArtRefs }`  
输出：`{ pairwiseJudgments }`

复杂度控制：
- N ≤ 12：C(N,2) × 3 维 ≈ 200 次以内，直接跑；
- N > 12：先用聚类（核心性+重要性特征空间 K-Means，K=8），每簇内两两比较 + 簇代表间比较，总数 ≤ 160；
- 单次比较 Prompt 强制结构：`A问题：…  B问题：…  维度：[客观性/核心性/重要性]  胜出：[A/B/平]  理由（≤40字）：___`。

输出必须包含 `reason`，空理由视为未完成，重试 1 次。

#### T3.2 问题树双轨构建 `problemTree.ts`

文件：`src/patent/problem/nodes/problemTree.ts`

构建两棵树，共享节点但边不同：

**撰写视角树（drafting view）— 自顶向下**：
- 根：发明人声明的"总痛点"（若多个取合并）；
- 边：拆分/协同关系（`coordinate` / `synergistic`）；
- 目标：帮助做"特征分层"（根→独权，叶→从权）。

**三步法视角树（three-step view）— 自底向上**：
- 叶：每个区别特征对应的"实际解决的技术问题"；
- 边：因果归纳（`cause-effect`）；
- 目标：模拟审查员会如何重新定问题，提前防御。

对齐度量化：两棵树对应节点在路径上的加权编辑距离 → 输出 `alignmentScore`（0-1，≥0.6 为健康）。

输出两棵树 JSON，可直接被 Mermaid 渲染（附转换函数）。

#### T3.3 问题树构建方法论融合

可选加分项：在问题树构建节点中，当 context 中命中"因果/根因/鱼骨/五问"关键词时，调用现有 [fishbone](file:///Users/xujian/projects/Sati/src/methodology/runtime/components/fishbone.ts) / [five-whys](file:///Users/xujian/projects/Sati/src/methodology/runtime/components/five-whys.ts) 模板作为 Prompt 增强。接入点：`problem-tree` 节点 provider 回调 → `MethodologyInjector`。

---

### Sprint 4：集成 + 评估 + 质量门禁

**预计工作量**：3–5 天  
**Sprint DoD**：`patent-agent` 调度时自动走完整链路；质量门禁 ≥3 条规则；新增评估指标 2 个均已接入 `patent_eval`。

#### T4.1 Graph 正式接入 PFE Pipeline

文件：`src/patent/worker-contract.ts`

新增 worker：

```typescript
{
  worker: "patent-problem-analyzer",
  role: "patent-analyzer",
  before: "patent-technical-analyzer",  // 先定问题，再提取特征并强制关联
  workflow: "problem_atomization_v1",
  note: "原子化技术问题识别（PFE 的前置问题基座）"
}
```

在 `patent-understand-disclosure` SKILL.md 中，把"PFE 三要素提取"改写成：
> 先执行原子化技术问题识别（本方案 7 步协议）→ 再提取 PFE → 每 Feature 必须关联 AtomicProblem。

#### T4.2 RuleEngine 质量门禁

文件：`src/patent/checker/rules.ts` 新增规则组 `problem_atomization_v1`：

| 规则 ID | 严重性 | 检查逻辑 | 失败提示 |
|---------|--------|----------|----------|
| PA01 | error | 独权必要特征 → 对应问题核心性≥4 AND 客观性≥L2 | "以下特征关联问题客观性/核心性不足：[ids]，下调层级或加强证据" |
| PA02 | warning | 核心问题反向测试通过率 ≥ 80% | "以下核心问题去特征后仍可解决：[ids]" |
| PA03 | warning | 独权核心问题中 L3+ 客观性占比 ≥ 50% | "独权过多依赖主观问题，OA 被重新定技术问题风险高" |
| PA04 | error | orphanFeatures 为空（或允许 ≤1 个并在备注说明） | "未找到对应问题认领的特征：[ids]，请判断是否非必要" |
| PA05 | warning | three-step/drafting 视图 alignmentScore ≥ 0.6 | "撰写视角与三步法视角分歧较大，请复核核心问题" |

Fixtures：每个规则 1 个 PASS + 1 个 FAIL fixture，共 10 个 ≥8 个通过。

#### T4.3 评估指标接入

文件：`src/patent/evaluate/metrics.ts` 新增：

```typescript
// 1. 原子问题-特征覆盖率
export function problemFeatureCoverage(
  atomicProblems: AtomicProblem[],
  features: { id: string }[]
): number {
  // orphanFeatures 的补集
}

// 2. 双轨问题树对齐度
export function problemTreeAlignmentScore(
  drafting: ProblemTreeNode,
  threeStep: ProblemTreeNode
): number {
  // 路径加权编辑距离的归一化值（0-1）
}
```

并在 `scripts/patent-eval.mjs` 中注册为 `problem_coverage` / `tree_alignment` 两个可显示指标。

#### T4.4 端到端冒烟测试

文件：`tests/patent/problem-e2e.spec.ts`

1 条完整链路：
- 输入 fixture 01 交底书文本 → Graph 跑完 7 步 → 输出 `ProblemAtomizationResult`；
- 断言：`atomicProblems.length ≥ 2`、`orphanFeatures.length === 0`、`coreProblems[0]` 客观性 ≥ L2、`reverseTestReports.length === coreProblems.length`。

---

## 四、文件改动总览（目标落地路径）

### 新增文件（约 20 个）

| 路径 | 作用 | 所属 Sprint |
|------|------|-------------|
| `src/patent/problem/types.ts` | 数据契约（8 接口） | S0 |
| `src/patent/problem/atomicChecker.ts` | 四检验纯函数 + 8 陷阱检测 | S1 |
| `src/patent/problem/scorers/objectivityScorer.ts` | 客观性 L0-L4 + 5 分制 | S2 |
| `src/patent/problem/scorers/coreNessScorer.ts` | 核心性评分 | S2 |
| `src/patent/problem/scorers/importanceScorer.ts` | 重要性（含规避难度）+ 层级推荐 | S2 |
| `src/patent/problem/nodes/enumerate.ts` | 穷举收集节点 | S1 |
| `src/patent/problem/nodes/semanticMerge.ts` | 语义合并节点 | S1 |
| `src/patent/problem/nodes/atomize.ts` | 原子化节点 | S1 |
| `src/patent/problem/nodes/orphanConsistency.ts` | 孤儿双向校验节点 | S1 |
| `src/patent/problem/nodes/compare.ts` | 两两比较节点 | S3 |
| `src/patent/problem/nodes/scorecard.ts` | 三维评分卡聚合节点 | S2 |
| `src/patent/problem/nodes/problemTree.ts` | 双轨问题树节点 | S3 |
| `src/patent/problem/nodes/reverseTest.ts` | 反向测试节点 | S2 |
| `src/patent/problem/problemAtomizationGraph.ts` | Graph 构建 + 编译入口 | S0/S4 |
| `src/patent/problem/index.ts` | barrel export | S1 |
| `tests/patent/problem-types.spec.ts` | 类型 fixture 测试 | S0 |
| `tests/patent/problem-graph-smoke.spec.ts` | 空图冒烟 | S0 |
| `tests/patent/atomic-checker.spec.ts` | 四检验 + 8 陷阱单测 | S1 |
| `tests/patent/problem-e2e.spec.ts` | 端到端链路冒烟 | S4 |
| `tests/patent/fixtures/problem-atomization/{01,02,03}-*.json` | 3 个基准 fixture | S0 |

### 修改文件（约 7 个）

| 路径 | 改动内容 | 所属 Sprint |
|------|----------|-------------|
| `src/patent/worker-contract.ts` | 新增 `patent-problem-analyzer` worker | S4 |
| `skills/patent-understand-disclosure/SKILL.md`（如不存在则 `patent-agent/SKILL.md`） | PFE 流程前置原子化问题识别 | S4 |
| `src/patent/checker/rules.ts` + `constants.ts` | 新增 PA01-PA05 规则 | S4 |
| `src/patent/evaluate/metrics.ts` | 新增 2 个评估指标 | S4 |
| `scripts/patent-eval.mjs` | 注册 `problem_coverage` / `tree_alignment` | S4 |
| `src/patent/index.ts`（或对应 barrel） | re-export `problem/` | S1 |

---

## 五、风险与依赖

### 5.1 主要风险

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| LLM 原子化不稳定（同一交底书多次产出不一致） | 核心性排序抖动，权利要求分层不可复现 | `atomicChecker.ts` 纯函数侧兜底：LLM 建议后必须过 4 检验，不通过则强制重写；对最终结果做 hash 一致性自测（3 次调用 ≥2 次一致才放行） |
| 两两比较复杂度爆炸（N≥20 超时） | 用户体验差 | K-Means 聚类 + 簇代表比较；节点 `timeoutMs=30s` 超时时降级为跳过两两比较，直接用评分卡聚类排序 |
| 双轨问题树 LLM 判定不稳定 | `alignmentScore` 漂移 | 每边关系 2 次采样+投票；引入确定性规则边（功能独立标记强制 coordinate，协同标记强制 synergistic） |

### 5.2 依赖项

- `src/patent/graph/` GraphEngine（已存在，零改动即可用）；
- `src/patent/evidence/`（用于客观性 L3/L4 证据回溯）；
- `src/methodology/` fishbone + five-whys（可选增强，不阻塞）；
- `src/patent/checker/` RuleEngine（PA01-PA05 接入）；
- `vendor/nuo-patent` 的 PFE 提取输出作为 T1.4 输入（如当前未结构化需先做结构化适配层）。

---

## 六、回滚策略

- **特性开关**：在 `patent-worker-contract.ts` 的 worker 定义中加 `enabled: process.env.ENABLE_PROBLEM_ATOMIZATION === "true"`，默认关闭；Sprint 4 完成后内部演练 1 周再打开；
- **无损回退**：所有新增逻辑仅 append（不修改既有 PFE 提取主路径输入输出结构），若 pipeline 失败，仅跳过 problem 模块，原有 patent-analyzer 链路不受影响；
- **版本化**：Graph 命名 `problem_atomization_v1`，未来 v2 可并存并通过 worker 参数切换。

---

## 七、分阶段交付与内部演练计划（Dry-run）

| 里程碑 | 交付内容 | 演练方式 | 通过标准 |
|--------|----------|----------|----------|
| M0（S0 结束） | 类型 + 空图 + 3 fixture | 团队 review fixture 真值是否覆盖真实争议场景 | ≥1 名资深代理人确认 fixture 01/02 原子拆分期望无遗漏 |
| M1（S1 结束） | 原子化 + 孤儿校验 | 在 1 份真实交底书（脱敏）上人工执行穷举+拆分 vs Agent 输出 | 人工问题列表与 Agent 输出 Jaccard ≥0.85 |
| M2（S2 结束） | 评分卡 + 反向测试 | 选 3 份已授权案件，抽独权必要特征对应问题，检查客观性是否 ≥L3 且反向测试 100% 通过 | 3/3 通过即放行 |
| M3（S3 结束） | 问题树双轨对齐 | 选 1 份 OA 败诉/被缩权案件，验证三步法视角树是否能定位到"实际被审查员重新定的技术问题"路径上 | 1 案命中关键路径即视为功能有效 |
| M4（S4 结束） | 全链集成 + 门禁 | 端到端 run 3 份真实交底书（脱敏） | rule_check 全部通过或 ≤1 warning；`pnpm test` 后端 873+N 全绿 |
