# 决策记录：恢复策略共享化 · 网关参数守卫表 · kanban hook 卫生（debt-batch2）

- 日期：2026-08-27 · 分支：`refactor/debt-batch2`
- 关联：TD-AGENT-101（扩围复核）、TD-GATEWAY-002 待做半、TD-GATEWAY-006、TD-UI-CHAT-N14；
  审计依据 `docs/technical-debt/audit-report-2026-08-27.md`，落地状态汇总 `backlog.md` §30。

## 变更内容

1. **AgentLoop 恢复策略共享化**（agent 主链路，行为保持）
   - 抽出私有生成器 `recoverFromMaxOutputBump` 与 `recoverFromEmptyResponse`，收口两对跨函数复制
     的恢复状态机（TD-AGENT-101 扩围复核定位的 Pair A/B）；调用方仅保留各自的第三级兜底与 strip 差异。
   - terminal 路径透传 `terminateTurn` 返回值，维持生成器返回契约（typecheck 即证）。
2. **网关方法参数守卫表**（协议面，唯一有意行为变化点）
   - 新增 `methodGuards.ts`：声明式字段规格 + 全方法表 + `handleRequest` 分发前拦截；
     畸形入参回结构化 `{code:"invalid_params"}`，替代此前深入实现层的裸 TypeError→gateway_request_failed。
   - 编译期穷尽：`satisfies Record<WsGatewayMethod, ParamSpec>`。
3. **kanban useBoardState 卫生三合一**（UI hook）
   - `mutate({slice?,optimistic?},run)` 统一执行体；`useTranslation` 取代 i18n 单例；
     `parseBoardState` 入口结构校验。外部签名不变。

## Alternatives considered

- **AgentLoop 用独立恢复策略类/事件订阅重构**：改动面大且需重排事件序列回归；本文对应的两个纯提取
  已消除「改上限须同步 N 处」的主要痛源，本体拆分另行排期。弃。
- **守卫直接 zod / 声明式 schema 库**：引第三方依赖违背当前工具链克制约定；99% 收益来自「必填标量
  存在性+基础类型」这一薄层，20 行谓词套件即可。弃。
- **noParams 严格模式**（无参方法收到任何非空对象即拒）：与 M3「任意帧可携带杂散 sessionKey 刷在线态」
  冲突（describe_server 合法携带），且会破坏 presence-wiring 既有契约测试。改为「永不因多余数据拒绝，
  只校验声明过的必填」——拒绝语义只对缺数据生效，向前兼容。
- **运行期未知 method 也由守卫拦截**：会抢在 switch default 之前改变错误码契约（测试锁死为
  gateway_request_failed）。未知成员放行给 default，编译期穷尽才是防漏的正解。
- **presence-wiring 探活帧改为真实完整载荷**：只需最小合法三元组即可触达原断言路径；不做超出用例
  意图的改动。
- **parseBoardState 全面 schema 校验**：镜像类型已有单测覆盖形状（board/store spec）；入口只查骨架
  （数组+每项关键 string 字段）即可把「undefined 渗入渲染」转化为可诊断 error，全量校验留给未来
  引入 schema 层时一并做。

## 行为变化披露

- WS 客户端若发送缺失必填标量或字段类型错误的请求，将首次收到 `invalid_params`
  （此前是深入实现后的 TypeError 文本随 gateway_request_failed 或 not_configured 噪声）。
  现有官方客户端（cli/tui/web/feishu/test fixture）经全量回归确认不受影响。
- 其余两项为零行为变化重构（事件序列逐位对齐由既有 agent/gateway/UI 测试锁定）。

## 验证

- root：typecheck/lint/format ✅；backend node--test 全量（含 agent 275、gateway 132）✅
- ui：sati-ui typecheck/lint ✅；vitest 101 文件 / 617 用例 ✅
