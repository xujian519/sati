# Agent Note: IM 回复控制器与飞书频道生命周期

Status: implemented

## Problem

`ImLiveReplyController` 在每次流式增量上 `await` 一次 IM 往返，回复吞吐被平台延迟直接限流；
单条消息持续编辑没有上限，飞书在 20 次编辑后返回 230072，长回复会在中途冻结。工具调用边界还会
阻塞等待旧文案落盘，代码围栏可能被截断成两半。飞书频道本身也缺少生命周期收口：`stop()` 只关
WebSocket，在途 agent 回合、watchdog、live reply 定时器与排队中的入站消息都继续运行，停止后仍可能
向外发消息；处理中表情的往返还会拖慢交给 agent 的时机。

## Decision

按上游 #645 移植控制器能力，并给飞书频道补上生命周期守卫：

1. **控制器（`ImLiveReplyController` + `ImCodeFences`）**：增量只入缓冲并合并调度，不再等待
   transport；`minEditIntervalMs` 控制可见编辑的最小间隔（默认 1s，飞书 1.5s）；`maxEditsPerMessage`
   为最终文案预留一次编辑，用尽后自动换新消息继续；工具边界后台定稿；`cancel()` 停止定时器并丢弃
   排队投递；`runExclusive` 改为同步登记 FIFO 尾链，段定稿、权限提示等屏障不再被迟到文本越过；
   把格式化膨胀后的长度纳入分段，并按代码围栏边界切分。
2. **飞书频道**：新增 `stopped` 守卫与 `stopAbort`；`stop()` 取消 active replies、清 watchdog 与
   入站批次，并在 5s 上限内中止在途回合；transport 的 send/edit 先检查回合是否仍为当前回合；
   处理中表情改为并行发起；所有 REST 调用经 `fetchApi` 继承停止信号与超时；watchdog 只对当前
   回合作废。
3. **兼容**：飞书传递 `maxEditsPerMessage: 20`；未设置该值或未开启 `preserveCodeFences` 的频道
   保持原语义（微信共用同一控制器，无需改动调用点）。

## Alternatives considered

- **只在飞书内部做节流/换消息** —— 微信共用同一控制器，两套实现会分叉；上游把节流、编辑预算与
  取消做成 transport 选项，频道只声明能力，后续接入成本最低。
- **保留阻塞式 append，仅降低编辑频率** —— 每个增量仍占用一个 IM 往返，吞吐仍被平台延迟封顶；
  非阻塞缓冲 + 合并调度才能让 agent 事件流不被 IM 拖慢。
- **编辑预算用尽后把 230072 当普通错误记日志** —— 回复会停在半截；预留最终编辑并换新消息能让长
  回复完整送达。
- **`stop()` 只关 WebSocket** —— 在途回合仍会产出事件并发送消息，且 watchdog 可能继续 abort；
  必须在频道层停止回合、取消 reply、清定时器。
- **无限期等待所有 abort 完成** —— 网关异常时 `stop()` 会挂住；用 5s 上限保证停机可完成，超时
  回合作废由后续 `stopped` 守卫兜底。
- **为飞书默认开启代码围栏保护** —— 上游飞书 transport 未开启（富文本路径不同），本项目保持上游
  口径；能力已由控制器测试覆盖，接入频道时再显式开启。

## Consequences

- **换来**：流式回复不再被 IM 延迟限流；长回复在飞书编辑上限前自动续条；停止频道会中止在途回合
  并阻止迟到消息；工具边界文案可作为权限提示的屏障。判据为
  `tests/adapters/channel/im-live-reply-controller.spec.ts`（4 例：非阻塞吞吐、编辑上限续条、
  格式化膨胀不截断、工具边界不越序）与 `tests/adapters/feishu-lifecycle.spec.ts`（stop 中止回合、
  丢弃迟到文本、后续 webhook 返回 503）。
- **负控制**：换回旧控制器 → 前 3 条控制器用例转红；移除 `stop()` 中的 `stopped = true` →
  生命周期用例转红。恢复后定向 5 例、IM 相关 28 例全绿。
- **付出/技术债**：控制器从 1017 行增至 1241 行、`FeishuChannel.ts` 从 1337 行增至 1388 行，
  已按门禁要求显式更新 `docs/technical-debt/architecture-baseline.json`（+224 / +51）。这是移植
  上游完整状态的代价，拆分控制器会偏离上游、增加后续同步成本。
- **未验证**：未用真实飞书租户触发 20 次编辑上限与 1.5s 节流（本地用等价 fake transport 验证）；
  代码围栏保护在当前 Sati 频道尚未启用（飞书/微信未 opt-in）。
