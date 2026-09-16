# Agent Note: 专利双链路一致性 fixture + 审批放行改为门粒度

Status: implemented

## Problem

issue #358 的诉求是「专利双链路缺跨链路一致性 fixture」。它给了两张表：一张是 `adapter.ts` 与
`executor.ts` 的能力对照（`approvedGate` 放行分支图路径缺失），一张是「台账 `TD-PATENT-N01`
（验证面）」。逐条对账后，**issue 的事实层已经过期两处，而真实缺口是另外两个**：

1. **`approvedGate` 缺失分叉已修复**：`graph/adapter.ts:129-135` 现已有该分支（含注释），
   由 `7e6d35d96`（#345 / PR #382）引入。
2. **「没有任何测试断言两条链路产出一致」不成立**：`tests/patent/graph/adapter.spec.ts` 已有
   6 条跨链路等价性用例（109/130/288/335/387/417 行），其中就包含「已放行审批门——两路径占位
   输出一致（#345 漂移修复）」。
3. **真实缺口甲——多审批门场景零覆盖**：所有既有等价性用例最多只有**一道**门。
4. **真实缺口乙——放行泄漏是活的**（本次实测确认）：

   ```
   只批准 gate1 ⇒ 图路径整条链路跑完，gate2 静默输出 APPROVED
                 manifest 路径正确停在 gate2
   ```

   根因写在 `graph/checkpoint.ts`：`grantApproval` 往**共享 state** 写全局布尔
   `APPROVAL_GRANTED_KEY = true`，而该键**永不清理** ⇒ 一次批准放行同 run 内后续所有门。
   `patent_drafting_v1` 有六道门。台账 `TD-PATENT-N01` 的「残留」段早已把这条记成
   「新发现待立项」，issue #358 没提它——两件事是同一个 set 的两面：**泄漏是缺陷，缺
   fixture 是「缺陷无人能发现」**。

   `src/patent/workflow/executor.ts` 的头注释记录了**同型历史事故**（manifest 路径侧）：
   「曾因此发生"无 params 的已批准门放行后全链路审批门静默放行"」。

5. **附带缺口**：issue 要求的「有意差异**显式豁免清单**」此前只有 `graph/README.md` 里的一段
   散文，没有可执行的形态。

## Decision

### 一、放行从「共享 state 的全局布尔」改为「门粒度授权集合」

```ts
// atoms/handlers/builtin/gate.ts
export const APPROVAL_GRANTED_KEY = "__approval_granted__";        // 只在 handler 局部执行态
export const APPROVAL_GRANTED_NODES_KEY = "__approval_granted_nodes__"; // 共享 state：被批准的门 id 集合
export function isGateApproved(state: PipelineState, nodeName: string): boolean;
```

- `grantApproval(store, checkpointId)` 写 `APPROVAL_GRANTED_NODES_KEY = [...cp.activeNodes]`——
  值直接取自检查点**待执行节点**，不引入第二套命名空间。批准**非门**检查点 ⇒ 集合里没有门 id
  ⇒ 不放行任何门（**fail-closed，绝不静默放行**）。
- 节点要判「自己是不是被批准的那道门」，就必须知道**自己在图内的名字**。新增
  `GraphNodeContext.nodeName?: string`，由引擎在唯一调用点注入（`graph/engine.ts:213`）。
  直接构造上下文调用节点的场景下为 `undefined`——此时**不得退化为「任意放行」**。
- 两套节点工厂各自把 `APPROVAL_GRANTED_KEY` 注入**执行态拷贝**，共享 state 永不含该键：
  - `graph/adapter.ts` 的 `makeStageNode`：按 `stage.id` 判定（与 manifest 路径的
    `approvalGrants: stageId[]` 同构——本节点在图里正是以 `stage.id` 注册的）；
  - `graph/domains/shared.ts` 的 `handlerNode`：按 `nodeName` 判定。
- 两条链路的承诺收敛为两句：**共享 state 永不含全局放行布尔** + **放行按门 id 集合**。

> ⚠️ 第二条工厂不是「顺手补的」：域图（`domains/{novelty,inventiveness,enablement}.ts`）的
> 审批门**一律带 `params`**（`{ review_context: ... }`）⇒ 执行态本来就是拷贝。它们此前能放行，
> 是**沾了共享 state 的光**（`{...state, review_context}` 把那个全局布尔一起继承了）。
> 改成门粒度后，`handlerNode` 必须自己注入——漏掉就是「`grantApproval` 形同虚设、门在 resume
> 时再次中断」。这条**首轮负控制没转红**才发现（见 Consequences）。

### 二、新增跨链路一致性 fixture 作为判据 home

`tests/patent/graph/link-consistency.spec.ts`（11 例）：

- 9 个代表性 manifest：linear / retry 回退 / 单门 / **双门** / disclosure 全流程（放行、未放行
  两态）/ 无可执行体 / handler 抛错 / 原子内部降级；
- 两链路产物先映射到同一 `LinkView`（`completed` / `interrupted` / `outputs` / `degradedStages` /
  `degradedCount`）再比对，避免「字段名不同就当作差异」；
- **中断点不设豁免**：`assert.equal(wfView.interrupted, grView.interrupted)` 硬断言（两链路字段名
  不同但语义可比），故 `interrupted` 不进登记表；
- 差异走**登记表 ↔ 用例表两向一致**：`LINK_DIFFERENCES`（每项带 `reason` + `source`）登记类型，
  `EXPECTED_DIFFS`（`as const satisfies Record<…, readonly Diff[]>`）逐条实证。`DiffKind` 由登记表
  派生 ⇒ 用例写未登记的类型名是**编译错误**。三种情况都转红：出现未登记差异 / 登记了却无人实证
  （僵尸条目）/ **差异消失**（有人把两链路收敛了）——清单不会腐烂；
- HITL 闭环在 fixture 内跑完整流程：跑到中断 → 命中 `approvals` 则 `grantApproval` + resume。

**刻意取舍**（陷阱 1/6/7/8、双链路字段提取：`docs/problem-atomization-minimal-plan.md:73,199`）
属「功能未提取」，不表现为本 fixture 可观测的产出差异，故**不入登记表**——不入表不是漏登记，
是因为它们根本不产生可比对的产出差。这一点写进了文件头注释。

## Alternatives considered

- **只补 fixture、不动放行实现（严格照 issue 的「验证手段」定位）** — 落选：fixture 一建起来就会
  在「双门只批第一道」上转红（实测确认）。要么把这条**已知缺陷**写进豁免清单（等于用清单把缺陷
  合法化，正是 issue 最不想要的结果），要么先修。修它的成本只有「把布尔换成集合 + 节点自知其名」。
- **豁免清单用「允许的差异」语义（`EXPECTED_DIFFS` 只作上界断言）** — 落选：「只许少不许多」会让
  差异**消失**时静默通过，清单单向腐烂。改为「就是这些」的等值断言，双向都关死。
- **放行记录另起一个 id 命名空间（如 `stageId` 之外的门序号/哈希）** — 落选：图路径的门节点名就是
  `stage.id`（`manifestToGraph` 的 `addNode`），另造命名空间要再维护一套映射；直接用节点 id 集合
  与 manifest 路径的 `approvalGrants: stageId[]` **天然同构**。
- **把 `nodeName` 作为普通 state 键传（如 `state.__node_name__`）** — 落选：会给共享 state 引入一个
  「当前正在跑谁」的隐式全局量（并发/超步语义下本就不该有这种量），且它会进检查点快照。
  作为节点上下文字段既无副作用又天然只在本次调用内有效。
- **让 `handlerNode` 通过闭包捕获节点名（调用方再多传一个参数）** — 落选：节点名由**图注册时**决定
  （`builder.addNode(name, node)`），而 `handlerNode(...)` 在注册之前就已构造完 ⇒ 闭包拿不到名字。
  引擎注入是唯一信息源。
- **把 `interrupted` 也纳入登记表（当"有意差异"处理）** — 落选：两链路 `interrupted` 字段名虽然不同
  （`stageId` vs `node`）但语义完全可比，纳表等于给「同一 run 停在不同的门」留后门。改为无豁免硬断言。
- **诊断/投影用「降级消息里包含阶段 id」来提取图路径的降级阶段** — 落选（实测踩到）：图路径的降级
  粒度是**输出键** `<outputKey>__degradation`（如 `features__degradation`），不是阶段名；用消息子串
  匹配是**错误的投影**，会把「原子内部降级」误算成阶段级。改为按 `<stageId>__degradation` 状态键提取，
  并**另加** `degradedCount`（两链路各自实际标记条数）以捕捉键级差异。
- **「原子内部降级」也拆成一个独立差异类型** — 落选：它的表现就是「manifest 路径报降级 / 图路径阶段级
  不报」，与既有 `degradation-report` 是同一通道、同一理由，拆开只是让登记表变长。
- **`fallbackValue` 一并从 `execState[stage.id]` 改回 `state[stage.id]`（负控制中被验证为不可观测）** —
  落选：它**不属于本 issue 的改动面**（HEAD 原值即 `execState`），且改它是本 issue 之外的行为变更、
  没有任何判据。负控制没转红恰好证明**不该顺手改**。

## Consequences

- **修复的实际缺陷**：多门场景的放行泄漏（`grantApproval` 后同 run 后续门被静默放行）；叠加
  `handlerNode` 路径的漏注入（改门粒度后若不补，域图审批门会永远中断）。两处都从「无人能发现」
  变成「有判据钉住」。
- **新增判据**：`link-consistency.spec.ts` 11 例（全为新增文件）+ `checkpoint.spec.ts` 新增
  fail-closed 用例 1 例、既有 HITL 用例补 3 条断言（放行记录 = 待执行节点 / 共享 state 无全局布尔 /
  引擎注入 `nodeName`）+ `adapter.spec.ts` 该用例改门粒度传态并新增「共享 state 不得残留全局放行
  布尔」断言。`tests/patent/graph/**` 29 例全绿；`tests/patent/**` 1117 例中仅既有的
  「系统 Chrome 存在时可生成 PDF」1 例不恒定失败（与本改动无关）。
- **负控制 9 组**（逐条核对转红名单、相邻用例仍绿、还原复绿）：

  | # | 注入 | 预期转红 | 实测 |
  |---|---|---|---|
  | ① | `isGateApproved` 忽略门 id（`granted.length > 0`） | 跨链路双门 / checkpoint fail-closed | ✅ 2 例 |
  | ② | 完整复现历史全局布尔（写入端 + 读取端 + 适配器三处） | adapter 占位输出 / 共享 state 无全局布尔 / checkpoint HITL / fail-closed / 跨链路双门 | ✅ 4 例 |
  | ③ | 放行写进 delta（泄漏回共享 state） | adapter 共享 state 断言 / 跨链路双门 | ✅ 2 例 |
  | ④ | `grantApproval` 写空集合 | checkpoint HITL / fail-closed | ✅ 2 例 |
  | ⑤ | 引擎不注入 `nodeName` | checkpoint HITL | ✅ 1 例 |
  | ⑥ | 登记表加僵尸条目（`zombie`） | 登记表↔用例表两向一致 | ✅ 1 例 |
  | ⑦ | 登记表删 `stage-output` 条目 | 登记表↔用例表两向一致 | ✅ 1 例 |
  | ⑧ | 图路径降级投影退回「消息子串匹配阶段 id」 | 无可执行体 / handler 抛错 | ✅ 2 例 |
  | ⑨ | `domains/shared.ts` 不注入放行标记 | ——（**首轮 0 例，判据缺口**） | ✅ 补「手建域图」用例后 1 例 |

  **两条如实记录**：
  - ⑨ 首轮**没转红**：`checkpoint.spec` 的 HITL 用例用的是**内联节点**直接调 `isGateApproved`，
    没经过 `handlerNode`。这不是「用例写错」，而是**覆盖盲区**——`handlerNode` 是 public API，
    域图确实走它。已补 `link-consistency.spec.ts` 的「手建域图：同一放行记录对两套节点工厂都生效」
    用例（含 fail-closed 分支），复跑后该注入转红。顺带把该文件里**死掉的 `handlerNode` 导入**用上了。
  - 一条**无效负控制**：把 `resolveStageOutput` 的 `fallbackValue` 由 `execState[stage.id]` 改回
    `state[stage.id]` **不转红**。判定为该变异不对应本 issue 任何已变更行为（HEAD 原值即 `execState`），
    已还原并**放弃**这项顺手改动（见 Alternatives）。
- **未做**：`TD-TEAM-N07`、`TD-ADAPTERS-N07` 等与本 issue 相邻的条目未动；
  `patent_drafting_v1` 的六道门未逐一跑端到端（本次判据在 `graph/**` 层面钉住门粒度语义，
  六门 manifest 的实际放行为同一代码路径）。**`CLAUDE.md` 被 `.gitignore:220` 忽略**，
  本地如需同步放行契约说明请自行处理（本次未改它）。

## 相关

- issue #358、台账 `TD-PATENT-N01`（§8 patent，含「验证面」子条）
- `src/patent/atoms/handlers/builtin/gate.ts`（新增 `APPROVAL_GRANTED_NODES_KEY` / `isGateApproved`）
- `src/patent/graph/{engine.ts,types.ts,adapter.ts,domains/shared.ts,checkpoint.ts}`
- `src/patent/workflow/stage-primitives.ts`（共用原语，未改）
- `tests/patent/graph/link-consistency.spec.ts`、`tests/patent/graph/{adapter,checkpoint}.spec.ts`
- `src/patent/graph/README.md`（放行契约 + 已知差异清单）
