# Agent Note: policy-bridge 工具拦截接线（flag 默认关 + phase 语义门）

Status: implemented

## Problem

宪法规则 `action: block` 宣称拦截工具调用，实现却停在半路：`rulesToPolicyDenyRules`
能把 block 规则编译成 `PermissionRule(source: "policy")`，但没有任何生产代码调用它——
`PermissionRuntime` 的 deny 通道因此永不收到宪法规则，`block` 只作用于输出层（挂起审批）。
`rules/README.md` 与本地 `CLAUDE.md` 都只能以"未接线"括注披露这一落差。

接线前必须先回答：**哪些规则该用于工具*输入*拦截？** 规则资产用 `phase` 描述检查时机。
`activation-overrides.yaml`（2026-08-16 评审，31 条 block 降级到 2 条）保留下来的两条
block 规则——`CON-COMP-0101`（编造占位专利号）与 `X-REF-003`（编造案例案号）——都是
`post_execution`：它们的语义是检查**已生成的产物**，不是阻止工具入参。把输出面规则编译成
工具输入拦截，等于拿产物词表去拦正常调用。

## Decision

通道接通，但**默认关 + phase 语义门**：

- 新增 flag `SATI_RULE_POLICY_BRIDGE_ENABLED`（默认关）。关闭时 `mergePolicyDenyRules`
  返回入参同一引用，`PermissionContext.rules.deny` 与接线前逐项相同。
- `rulesToPolicyDenyRules` 新增 `excludePhases`（默认 `["post_execution"]`）：**显式**声明为
  输出面 phase 的规则不参与编译；未声明 `phase` 的规则保持旧行为（既有测试 fixture 因此零破坏）。
- policy deny **前置**合并进 `rules.deny`（`mergePolicyDenyRules`）。这是不变式而非风格：
  `PermissionRuntime.decide` 取 deny 数组中首个匹配，且仅在首个匹配来源为 `"user"` 时才可能被
  session allow 覆盖——policy 排在 user deny 之后会被该短路路径绕过。合并函数同时剔除既有
  数组里的 policy 条目，避免重复注入累积。
- 编译产物带 `ruleId`，`denyFromRule` 因此给出"宪法规则 X 拦截工具调用 Y"的可读消息
  （无 `ruleId` 时逐字保持原文案）。
- 组合根在 flag 开启而编译结果为空时**显式告警**，不让"已启用"看起来像"已生效"。

当前规则资产下该 flag 开启仍编译出 0 条规则（2 条 block 均为 `post_execution`）。真正的拦截
能力要等新的 `pre_execution` 关键词规则入库；本次交付的是通道就绪、语义错配消除与文档一致。

## Alternatives considered

- **全量编译（不过滤 phase，接线即拦 2 条）** — 落选：这两条规则的语义是检查产物，拦工具入参
  属错配；`activation-overrides.yaml` 的评审先例（"block 误伤严重"而降级
  `CON-102`/`EX-CLM-001`/`EX-SEL-004`）正说明输出面词表用于入口会误伤，此处只是换了个方向。
- **把两条规则改标 `pre_execution` 以取得真实拦截** — 落选：改的是规则资产语义
  （`rules/patent/*.yaml`），会同时改变输出门禁所用规则集的定义（`phase` 是资产字段），须独立
  评审误拦面；本次不动资产。
- **不接线，只把"未启用"写成显式决策**（issue 给的第二条路） — 落选：通道已实现却永不生效，
  正是 `backlog.md` §13 单列的「未接线实现」型债务；且 `rules/README.md`「遗留」小节的
  `X-REF-003` 全角括号漏报也只有在通道真正可用后才有处理意义。
- **接线并默认开启** — 落选：全局权限面的爆炸半径要求灰度；且当前资产下默认开启并不拦任何
  东西，除风险外无收益。

## Consequences

- `block` 不再有"实现存在但生产永不生效"的落差：`rules/README.md` 的接线状态、本地
  `CLAUDE.md` 的能力描述与台账 `TD-RULE-N02` 都改为现实。
- 未来新增 `pre_execution` 关键词规则即自动获得工具拦截，无需改代码；但每一条都要先评审误拦面
  ——`keyword_blocklist` 一旦用于工具输入，误伤代价是**硬拒绝**（不经 HITL）。
- 接线点放在组合根（`createLocalGateway`）而非 `PermissionRuntime`：policy 规则随
  `PermissionContext` 流动，子代理继承与会话级覆盖合并因此在同一处生效；代价是组合根多了一处
  按 `projectRoot` 的缓存与 flag 判断。
- 资产侧的两条 block 规则仍只作用于输出层；`rules/README.md`「遗留」的全角括号增强等待办保持
  未处理。
