# Brooks-Lint Review — 2026-09-23 全仓技术债扫描

**Mode:** Tech Debt Assessment
**Scope:** 整个仓库（`src/` · `ui/` · `ui/server` · `apps/desktop` · `tests/` · `scripts/` · `.github/` · 治理文档），基线 commit `5cba87d2a`（2026-09-22，release/v0.3.1）
**Health Score:** 4/100
**Config:** 无 `.brooks-lint.yaml`（仅 `suppress: []`）⇒ 全风险启用、无忽略路径、`balanced` 预设

> 分数含义提示：本分数是 skill 的机械口径（Critical −15 / Warning −5 / Suggestion −1），**衡量的是本轮主动深挖出的活跃债务条数**，不是项目整体工程水准。Sati 的门禁体系（`pnpm lint` 串 14 个 check）与债务账本（`docs/technical-debt/`）成熟度在同类项目中属上乘；本轮之所以能挖出 20 条，是因为做了「逐条核代码 + 实测复现」而不是读账本转述。

---

## 方法与去重（先说清楚台账边界）

1. **不搬运账本**：`docs/technical-debt/backlog.md` 有 300 条带证据条目（228 条状态未清），但其中一批已交付而未回填状态、另一批的影响数字与实测数量级不符——因此本轮**对每条候选都回到代码**：4 个并行核实代理 + 本机实测（帧计时、SQL UDF 计时、真实 knowledge.db、真实 transcript、`tsx` 复现脚本）。
2. **去重**：所有历史 issue（#147–#520）均已关闭；本轮先核代码再决定是否建票，因此**排除了若干「账本说仍成立、实际已修或量级远小」的条目**（见下节），并把 4 条候选的严重级**下调**。
3. **只读登记**：本轮未修改任何源码；`git status` 在扫描全程为空。唯一的仓库外产物是 `/tmp` 下的复现脚本。

### 被下调/排除的候选（证据见各 issue 正文）

| 账本条目 | 账本写法 | 实测结论 | 处置 |
|---|---|---|---|
| `TD-KNOWLEDGE-N02` | 「最坏数十秒同步阻塞」P2 | 法规语料仅 96 部，LIKE 整查 **5–8 ms**；桌面运行时已固定带 FTS5 的 Node | 排除（P3 以下） |
| `TD-CRON-N01` | 整文件写放大 P2 | 单次整文件重写 **0.29–0.81 ms** | 排除 |
| `TD-UISERVER-N02` | bridge 4 张缓存无上限 | `sessionState` 已被 #413 修好，另有 4 张仍在 ⇒ 缩为 P3 残留 | 缩范围后建票（#529） |
| `TD-UI-APP-N06` | 未虚拟化 ⇒ DOM 膨胀 P2 | 两侧有三重上限（5/30/500），真实 DOM 规模 65–197 行；**真正的卡点在服务端整树拉取** | 改指向后建票（#533） |
| `TD-WEB-N01` / `TD-GATEWAY-003` | P2 热路径 | 实测 9–16 ms / 1.1 µs；且 gateway 那条「可能无人读」与代码矛盾 | 降 P3 合并且更正（#535） |
| `TD-UISERVER-N04` | N+1 子进程 P2 | 默认 limit=10 ⇒ 112 ms；limit=100 才 1.12 s | 降 P3（#534） |
| `TD-PATENT-N13` | 专利号归一化口径发散 | 已收敛为单一实现（`outputPaths.ts` 从 `egoSession.js` 导入） | 排除（已修） |
| `TD-TEAM-N10` 的 (b) | sessionKey 入参被丢 | 是 T6 评审的**刻意取舍**（单用户桌面） | 不主张改行为，仅登记升级条件 |

---

## Findings

### 🔴 Critical

**Domain Model Distortion / 错误处理 — 曲线图退化轴产出 NaN 坐标，而核验器同时判「通过」**（[#542](https://github.com/xujian519/sati/issues/542)）
Symptom: `chart.ts:394-397` 的 `spanX = range[1] - range[0]` 在显式 `min === max` 时为 0，坐标映射得 `NaN`；交付 SVG 出现 `points="NaN,286 NaN,256"`，`checkFigures` 的 V7 判据（`check.ts:606` 的 `printed < charHeight.mm`）对 `NaN` 恒 false，返回 `ok: true`、零 findings（本机 `tsx` 复现确认）。
Source: McConnell — *Code Complete* Ch.8 防御式编程（输入未校验）· Ousterhout — *A Philosophy of Software Design* 异常态被折叠成正常结果。
Consequence: 数据曲线在交付图上完全消失（渲染器丢弃 NaN 元素），而工具输出「核验通过」、sidecar 记 `ok:true` —— 错误直达定稿且无人拦截。
Remedy: 入参校验拒绝 `min >= max`，或退化轴退化为单点轴 + 明确 finding；并让核验对 `NaN` fail-loud。

**Change Propagation — `svg_paths` 回读把图型钉成 flowchart，把已交付的合规附图标为 V7 FAIL**（[#543](https://github.com/xujian519/sati/issues/543)）
Symptom: `patentFigureCheck.ts:234` 回读时手工造骨架并硬编码 `kind: "flowchart"`，`check.ts:248` 的 `figureCanvasPx` 遂按 flowchart/TB 重排；实测交付画幅 130×834px（34.4×220.7 mm，在 cnipa 可印区 170×257 mm 内）被报 **282.0×37.3 mm 超出可印区** → FAIL。
Source: Ousterhout — 信息泄漏（画幅这一设计决策在两个模块各自计算）· Fowler — Alternative Classes with Different Interfaces（核验器与渲染器对同一 figure 用不同解释）。
Consequence: `fail` 级发现意味着「附图不得定稿」，代理师会按一个**并不存在**的尺寸去拆图/缩画幅；反向则是覆盖假象（曲线图回读时骨架为空，量的是一张 57×96px 空骨架）。
Remedy: 回读通路量交付画幅（或按该通路既有意图整体跳过 V7）；补「LR block 多节点产物 → `svg_paths` 复核不得出 V7」断言。

### 🟡 Warning

**Dependency Disorder — 架构边界门禁的存量豁免不拦增长**（[#527](https://github.com/xujian519/sati/issues/527)）
Symptom: `check-architecture-boundaries.mjs:173` 的 `baselineKey` 只含 `(rule, file, detail)`，不含行数；41 条 file-size 豁免中 **6 条已超过基线记录值**（合计 +136 行，最大 `gateway/protocol/types.ts` 911→984）。
Source: Winters et al. — *Software Engineering at Google* 可持续性（门禁必须对目标形态有效）· Brooks — 概念完整性。
Consequence: 门禁自称「冻结存量、拦住新增」，实际只拦新文件；存量大文件可无限增长，且 `--update-baseline` 会静默追认——与已结案的 `TD-PROCGATE-001`（门禁恒真）同型。
Remedy: file-size 的匹配键纳入基线值为上限（棘轮），或至少对超基线增长告警；`--update-baseline` 输出本次追认了哪些增长。

**Knowledge Duplication — 债务活账本的条目状态与影响描述均未回填**（[#528](https://github.com/xujian519/sati/issues/528)）
Symptom: ≥8 条已交付条目标 `new`（`TD-METRIC-001/002`、`TD-PROCGATE-004`、`TD-SESSION-N01`、`TD-ROUTER-001/002`、`TD-PATENT-N13`、`TD-SMALL-N01`）；另有 3 条影响数量级失准（见上文去重表），1 条（`TD-GATEWAY-003`）的描述与代码相反。
Source: Hunt & Thomas — DRY 的实质是「决策只表达一次」；账本与代码是同一事实的两处表达。
Consequence: 每轮复核都要重走「账本说没做 → 核代码 → 发现做了」；照 `TD-GATEWAY-003` 的字面（「可能无人读」）去删缓冲动会破坏重连恢复。
Remedy: 批量回填 + 把 `backlog.md` 补进 `docs/issue-management.md` §6.1 的回填载体清单，条目加「最后复核日期」。

**Accidental Complexity — 文件树 API 急切遍历整棵树，跳过表遗漏 `.pnpm-store`**（[#533](https://github.com/xujian519/sati/issues/533)）
Symptom: `project-files.js:382` 以 `maxDepth=10 + showHidden=true` 拉全树，`filesystem.js:302-318` 的跳过表无 `.pnpm-store`；实测本仓库 **59,287 节点 / 串行 stat 663 ms**，其中 52,639 节点（88.8%）来自 1.0G 的 pnpm store。
Source: McConnell — 性能与正确性同等的基础工程判断 · Hunt & Thomas — 正交性（缓存目录与用户源码树是两回事）。
Consequence: 打开文件视图要多等约 0.7–1.5 s，其中 88.8% 是用户不关心的缓存目录；载荷 MB 级进前端 state。
Remedy: 跳过表补 `.pnpm-store`（最小）；首屏改 `maxDepth=1` 懒加载（同文件 `:76` 已有形态）；串行 `await stat` 改并发。

**Information Leakage — 团队编排两条热路径的全量同步读**（[#531](https://github.com/xujian519/sati/issues/531)）
Symptom: `team-share.ts:50-53` 构造即全量读盘逐行 `JSON.parse`，而调度器每次派发任务都新建实例（`scheduler.ts:253`）；`teamPanel.ts:32-45` 每 10 s 快照做 O(团队×成员) 过滤 + 每成员一次同步 SQL。
Source: Ousterhout — 信息隐藏与泄漏 · Fowler — Feature Envy。
Consequence: 黑板随轮次单调追加 ⇒ 每次派发付全量成本（同步阻塞）；面板成本随团队×成员平方增长。
Remedy: 进程内按 `(mtime,size)` 缓存 TeamShare 实例，或让 `summary()` 只反向扫尾部；`retired` 改一次 `SELECT ... FROM retired_members` 建 Set。

**Accidental Complexity — 记忆检索在每轮请求前阻塞（最坏 30s），且 abort 未透传**（[#536](https://github.com/xujian519/sati/issues/536)）
Symptom: `DefaultContextRuntime.ts:246-247` `await memoryPromise`（超时 30s）；provider 声明了 `signal` 但 memory-core 实现不接收 ⇒ 熔断只解除 await，内层 LLM（45s×3）继续跑；该超时路径无单测。
Source: Ousterhout — 战术编程的累积 · McConnell — 错误路径的可观测性。
Consequence: 首 token 延迟尾巴不可控；超时后仍在消耗配额；唯一静默降级点无回归保护。
Remedy: 非阻塞回退（到期即有则注入）或后台 + 下轮注入；abort 透传到 memory-core；补超时用例。

**Change Propagation — 工作区账本每笔写入落全量快照**（[#537](https://github.com/xujian519/sati/issues/537)）
Symptom: `JsonlTranscriptWriter.ts:267-273` 直接落整个 `state`，而读取侧只认最新一条；实测 200 次笔记累计 3.65 MiB（单条 37.1 KiB，二次增长），约 1000+ 次即撞 `TranscriptReader.ts:7` 的 50MB 硬顶 ⇒ 账本 `unavailable`、`workspace_note` 永久拒绝写入。
Source: Evans — Value Object 语义（历史态被当作权威态落盘）· Fowler — Duplicate Code 的死重形态。
Consequence: 硬故障而非渐进劣化；transcript 是所有能力面共用载体，膨胀同时抬高续算扫描与搜索成本。
Remedy: 只落增量/变更集 + 周期性全量锚点。

**Accidental Complexity — 插件信任门整树逐字节哈希无缓存**（[#538](https://github.com/xujian519/sati/issues/538)）
Symptom: `evaluateHookTrust.ts:55` 每个插件一次整树 readdir+stat+readFile；实测 1990 文件/7.96 MB ⇒ **130 ms/次**，在会话装配关键路径上；且 2000 文件上限 ⇒ `blocked` ⇒ 带 `node_modules/` 的插件永久无法授权。
Source: Ousterhout — 性能是设计属性 · McConnell — 边界条件的完整处理。
Consequence: 每条新会话多 130 ms；一类插件在功能上不可用。
Remedy: 进程内按 `(pluginRoot, 目录 mtime 摘要)` memo（保持内容判据）；`blocked` 区分「超限」与「内容不符」并给可操作提示。

**Cognitive Overload — 专利附图核验 21 条规则共用一个 503 行函数**（[#539](https://github.com/xujian519/sati/issues/539)）
Symptom: `check.ts:252-754` 的 `checkFigures` 503 行；`skipLayoutRules`/`figureCount`/`zoom` 三个共享量把多条规则的结论绑在一起；三个工具 `execute` 各 163–335 行，产物清单拼三遍。
Source: Fowler — Long Method · McConnell — Ch.7 高质量例程 · Ousterhout — 深模块。
Consequence: 改一条规则要通读 500 行并确认连带；新增产物要在 2–3 处同步改（本批 `fit_to_page` 就改了 two 处）。
Remedy: 规则注册表 + 每条规则纯函数（共享量改显式上下文）；抽出共享的产物装配模块。

**Knowledge Duplication — figuregen 内 `escapeXml` ×4、`fmt` ×4（精度已漂移三种）、几何谓词 ×2**（[#540](https://github.com/xujian519/sati/issues/540)）
Symptom: 4 个文件各写一份 `escapeXml`；`fmt` 精度为 1/2/3 位；`boxesOverlap`/`boxWithin` 在择位引擎与 C 规则各一份（同容差、一份常量一份字面量）。
Source: Hunt & Thomas — DRY（同一决策的两处表达必然漂移）· Fowler — Duplicate Code。
Consequence: 同一交付文档内坐标精度不一致；择位与 C 规则可能对「是否压盖」得出相反结论而两边测试都绿。
Remedy: 收敛 `escapeXml` 与几何谓词；`fmt` 精度改显式参数 + 交付层统一声明。

**Inappropriate Intimacy — 引线择位对重复 id 静默丢弃「先出现的落位」**（[#544](https://github.com/xujian519/sati/issues/544)）
Symptom: `leader-line.ts:41` 注释承诺保留先出现者，`:482-483` 的 `Map` 让后者覆盖前者；实测第一个锚点 `(20,20)` 落位消失、两标号重叠、`warnings: 0`。
Source: Fowler — Inappropriate Intimacy / 注释与实现背离 · McConnell — 断言应表达不变式。
Consequence: 图面错位且零告警，下游 C7–C10 按错位几何判定。
Remedy: `Map` 改「保留首个」语义，或工具层补 `id` 唯一性 fail-loud。

**Shotgun Surgery — 两个制图工具把 `invalid_tool_input` 折叠成 `tool_execution_failed`**（[#545](https://github.com/xujian519/sati/issues/545)）
Symptom: `patentFigureGenerate.ts:439` 与 `patentFigureCheck.ts:343` 无差别重抛；`patentFigureProject.ts:511` 有正确写法。
Source: Martin — 稳定依赖（错误码是下游的稳定契约）· McConnell — 错误处理的语义完整性。
Consequence: `errorRecovery.ts` 按 code 选策略、AgentLoop 按 code 熔断「连续非法入参」——折叠后模型反复传错不再熔断；`details` 丢失。
Remedy: 补 `if (err instanceof SatiToolRuntimeError) throw err;` + 断言 code 保持的单测。

**Information Leakage — A4 版式 HTML 的 `title`/`h1` 不转义**（[#546](https://github.com/xujian519/sati/issues/546)）
Symptom: `figuregen/html.ts:113` 直接插值，全文无转义函数；同链路另外四处都有 `escapeXml`。
Source: McConnell — 跨边界的文本必须按目标语言的规则编码。
Consequence: 发明名称含 `&`/`<` 时交付 HTML 畸形，且该 HTML 会被交给 Chromium 打印出 PDF。
Remedy: 复用 `escapeXml`（与 [#540](https://github.com/xujian519/sati/issues/540) 的收敛同批做）。

### 🟢 Suggestion

- **sati-bridge 仍有 4 张 per-session 缓存无上限**（[#529](https://github.com/xujian519/sati/issues/529)）：`_sessionTitleCache` 注释自承「lifetime of the process」；#413 的同类残留。
- **「无注释的无参 catch」零基线被侵蚀（0→12）且无棘轮**（[#530](https://github.com/xujian519/sati/issues/530)）：12 处全部是 #353 之后新引入，逐处核实**均非真隐患**（语义在 JSDoc），实质是护栏缺位；附带发现度量口径两处盲区（真实数字约 17）。
- **`ToolRegistry.clone()` 与 `filterAvailableTools` 丢失 `outputSchema` 严格位**（[#532](https://github.com/xujian519/sati/issues/532)）：修复有陷阱——MCP 工具定义本就不产出 `outputSchema`，透传 options 会立刻让 per-session MCP 注册抛错。
- **git `/commits` 逐 commit 串行 spawn**（[#534](https://github.com/xujian519/sati/issues/534)）：默认 112 ms / limit=100 约 1.12 s；该路由零测试覆盖。
- **web 消息投影与网关事件热路径微优化**（[#535](https://github.com/xujian519/sati/issues/535)）：`cloneMessage` 走 JSON 深拷贝（比仓内既有实现慢 22–40×，且丢 `undefined`）；同批更正 `TD-GATEWAY-003` 的失效行号与「可能无人读」表述。
- **两个新持久层是同一骨架的两份手抄 + `lookup()` 零生产调用者却标注为热路径**（[#541](https://github.com/xujian519/sati/issues/541)）：附带 `figuregen` barrel 225 个导出中 92 个模块外零消费。

---

## Debt Summary

| Risk | Findings | Avg Priority | Classification | Intent |
|------|----------|-------------|----------------|--------|
| Cognitive Overload      | 2 | 6.0 | Critical/Scheduled | accidental |
| Change Propagation      | 4 | 7.0 | Critical | accidental |
| Knowledge Duplication   | 3 | 5.7 | Scheduled | accidental（1 项为流程债） |
| Accidental Complexity   | 4 | 6.3 | Scheduled | accidental（1 项部分设计使然） |
| Dependency Disorder     | 1 | 6.0 | Scheduled | accidental |
| Domain Model Distortion | 2 | 8.0 | Critical | accidental |
| （横切：错误处理/契约）  | 4 | 6.5 | Warning | accidental |

**Recommended focus：**
1. **先修两条 Critical**（[#542](https://github.com/xujian519/sati/issues/542) / [#543](https://github.com/xujian519/sati/issues/543)）——它们是本批唯一会「产出无效交付物」与「阻断正确交付」的问题，且各自修法都很小（一条入参守卫 / 一处图型透传），外加各补一条断言即可闭合。
2. **再修门禁型的两条**（[#527](https://github.com/xujian519/sati/issues/527) / [#528](https://github.com/xujian519/sati/issues/528)）——它们的杠杆最高：前者是「门禁对目标形态无效」，后者让后续每一轮债务复核都要重复劳动。
3. **性能类按实测排序**（[#533](https://github.com/xujian519/sati/issues/533) 663 ms > [#538](https://github.com/xujian519/sati/issues/538) 130 ms > [#536](https://github.com/xujian519/sati/issues/536) 最坏 30 s > [#534](https://github.com/xujian519/sati/issues/534) 112 ms），其中 [#537](https://github.com/xujian519/sati/issues/537) 属「开关一开就爆」的条件债，需在账本转默认开之前清掉。

---

## Summary

本轮扫描没有停在「读账本转述」，而是对 30+ 条候选逐条回到代码与本机实测，因此产出的 20 条 issue 里包含 **2 条账本从未登记的真实缺陷**（NaN 坏图 + 假 fail）与 **1 条账本登记方向相反的更正**（gateway 重放缓冲「可能无人读」），同时把 4 条严重级虚高的候选降级、8 条已修条目排除。整体趋势判断：**项目治理基建扎实（14 道门禁 + 成熟账本），但「门禁有效性」与「账本新鲜度」是本轮暴露的系统性弱项** —— 前者表现为 file-size 豁免不拦增长与指标无棘轮，后者表现为状态与数字双滞后；两者都会让排期建立在失真信号上，建议优先于任何单点实现债务处理。

## 备注

- 本轮 20 条 issue 均以 `status: triage` 落在待分诊队列，未挂 milestone。按 `stale.yml` 现规则（`priority: p0/p1` 已豁免、其他级别不豁免、`exempt-all-milestones: true`），P2/P3 议题若无活动将在 90+30 天后被自动关闭——若希望长期跟踪，分诊时挂下个版本里程碑即可豁免。
- 新登记的条目**尚未回写** `docs/technical-debt/backlog.md`（该文件入库且 `main` 受保护，按 AGENTS.md 需走分支 + PR）。建议下一步在 `backlog.md` 追加一节（§37）收录这 20 条并与 issue 编号互链，同时按 [#528](https://github.com/xujian519/sati/issues/528) 的建议补「最后复核日期」字段。
