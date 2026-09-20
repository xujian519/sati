# Agent Note: patent 域的工作区级默认裁剪

Status: implemented

## Problem

新会话首个模型请求的**固定开销**（system prompt + 全部工具 schema）默认达 33,641 tokens——
128k 窗口的 25.7%，128k 以下的窗口直接被吃掉三到五成。其中专利域 28 个工具占 13,670
tokens，专利技能与角色的清单条目再占 3,429 tokens。

问题不在于"专利工具存在"，而在于**它们无条件地推给每一个工作区**：`tools.visibleDomains` /
`hiddenDomains` 是机器级配置（`~/.sati/sati.yaml`），而"这是不是一个专利项目"是工作区级事实。
`<projectRoot>/.sati/sati.yaml` 通道虽然存在（`getPilotProjectConfigFilePath`），但全仓零消费者，
是死代码。于是写代码的项目和写专利的项目拿到完全相同的工具面。

## Decision

**patent 域可见性由工作区判据决定，用户可三态覆盖。**

判据（`src/pilot/workspace/patentSignals.ts`，纯函数 + 可注入 fs）顺序即优先级：

1. `tools.patentDomain` 显式声明（`true` / `false` 都最高优先）
2. 机器级 `sati.yaml` 有 `patents:` 段
3. `<projectRoot>/.sati/rules.yaml` 引用专利规则包
4. `<projectRoot>/.sati/skills/` 下有 `patent-*` / `provision-*` / `drafting-*` 技能
5. 工作区有专利产物（`data/cases/**`、`.sati/figures*`、`.sati/documents`）
6. 该项目历史 transcript 出现过 `patent_*` 工具调用

判据为否时：patent 域并入隐藏域（`projectRuntimeFactory` 的注册表裁剪点），技能/角色清单
同步不列专利条目（`PromptAssembler` 只裁**清单**，不裁注册——模型仍可经 `read_skill` 按名读到）。
判据为是时行为与改动前逐字一致。

**判据一律"宁可判成专利"**：误判为专利只多花固定 schema 体积；误判为非专利会让用户整片
失去能力面（32/32 内置角色都声明 patent 域）且没有提示。因此所有判据都是"存在即命中"，
transcript 扫描因字节预算被截断时也按命中处理，且优先扫最近的会话文件。

**实测（`pnpm measure:fixed-overhead`，空 pilotHome 口径）**：

| 工作区 | 工具数 | system | tool schemas | 固定开销 | 128k 占比 |
|---|---|---|---|---|---|
| 非专利 | 51 | 6,061 | 10,479 | **16,540** | 12.6% |
| 专利 | 79 | 9,491 | 24,149 | 33,640 | 25.7% |
| A/B 差分 | 28 | 3,429 | 13,670 | 17,099 | |

## Alternatives considered

- **直接减少默认注册集（去掉 patent 域，无判据）** — 既有专利用户升级后静默失去全部专利
  工具与角色，且无从知道原因。判据的第 6 条（历史用过 `patent_*`）就是为了保住这批用户。
- **激活 `<projectRoot>/.sati/sati.yaml` 通道做工作区级配置** — 语义上正确但要新定义"机器级与
  工作区级如何合并、谁覆盖谁"，且那个通道从无消费者、没有测试面；判据只需读工作区事实，
  不引入第二套配置合并语义。
- **让 UI 复制一份判据以显示"当前检测为：专利工作区"** — 跨层双实现会漂移（UI 改一处、
  引擎改一处），而显示价值可由引擎日志 + 三态开关覆盖。改为：面板提供「自动 / 始终开启 /
  始终关闭」，运行期在装配时打一行判据日志（signal + evidence）。
- **默认连 kanban / team / documentStyle 三组一起关** — 再多省约 0.8k，代价是三类内置能力
  对所有用户默认消失。余量（16.5k vs 20k 目标）已足够，不值得。
- **在 onboarding 询问用户是否为专利工作区** — 增加首启摩擦，且用户答"否"之后再改需要回设置页；
  判据能自动覆盖绝大多数情况，开关留给例外。
- **`inputSchema` 参数描述瘦身（原计划 §3.5）** — 参数描述是 llm-replay 请求键的一部分
  （`requestKey.ts` 含 `tools(name + inputSchema)`），任何删改都要重录 fixture；实测全部参数
  描述文本仅 6,808 tokens，且 TOP20 里 18 个属 patent 域（本次已被判据裁掉），净收益 −1~2k。
  在验收主线（≤20k）不依赖它的前提下，收益不抵契约成本，**本批不做**。
- **把判据结果物化进配置文件当默认值** — 见下条守卫：物化会把"自动"冻成结论。

## Consequences

- 固定开销从 33,641 降到 16,540（−50.8%），达成 #450 的"128k 窗口下 ≤15%"目标（12.6%）。
- 新增 `tools.patentDomain` 三态配置，设置页「搜索」面板提供开关。**缺省态必须保持"未声明"**：
  `ui/server/services/satiConfig.js` 的 `guardPatentDomainTriState` 把归一化输出的该键钉成
  "配置文件写过什么就是什么"——默认值注入（无论 `true` 还是 `false`）都会让用户保存一次配置
  后就永久失去专利能力面，且没有任何提示。
- 判据在**装配期算一次**并随项目运行时缓存：工作区中途变成专利项目（例如新写了
  `.sati/rules.yaml`）需要重启或显式配置才生效。这是可接受的取舍——判据读的是启动期可得的事实。
- 非专利工作区里，模型不再被告知专利技能的名字，但仍可用 `read_skill` 读取（名字来自用户提示时）。
  技能**注册**未变，`agent` 工具的 `subagent_type` 仍可调度专利角色。
- 顺带修复一个独立缺陷：`src/context/budget/tokenizer.ts` 的"病态输入"抽样判据用**墙钟 80ms**
  判定，冷进程首次编码要构造 Tiktoken（rank 表 + wasm 初始化），会把自然语言样本误判成病态并
  按密度外推——实测 system prompt 精确 9,494 被报成 5,736（−39.6%），且低估结果进内容缓存
  **永不纠正**。修复是"取样两次、只计第二次"，并有冷启动回归用例与负控制。
