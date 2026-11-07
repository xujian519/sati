/**
 * Mid-turn steering 注入阶段（#809：从 AgentLoop 抽出，降低主回路扇出）。
 *
 * 只做 drain + 注入 + 广播，不持有实例状态：插件接线由 AgentLoop 组装的
 * deps 传入（未接线即零开销）。
 */

import type { AgentEvent } from "../../protocol/events.js";
import type { AgentLoopInput } from "../../protocol/input.js";
import type { AgentRuntimeDependencies } from "../../runtime/AgentRuntimeDependencies.js";
import { buildSteerMessage, steerPreview } from "../steer.js";
import type { TurnRuntimeState } from "../turnRuntimeState.js";

/** 插话注入阶段依赖袋（AgentLoop 组装注入）。 */
export interface SteeringDeps {
  readonly dependencies: AgentRuntimeDependencies;
}

/**
 * Mid-turn steering（协议 1.6）：模型调用边界 drain 插话邮箱。每个排队项
 * 构造为用户消息先落库（onDurableMessage，fail 即不注入——持久边界优先）
 * 再追加到消息序列尾部，并广播 steer_applied。未接线或空队列时零开销。
 */
export async function* applySteeredMessages(
  deps: SteeringDeps,
  state: TurnRuntimeState,
  input: AgentLoopInput,
): AsyncGenerator<AgentEvent, void, unknown> {
  // 调用期读取（而非构造期快照）：steerSource 非 readonly，后接线依然生效。
  const source = deps.dependencies.steerSource;
  if (!source) return;
  const items = source.drain();
  if (items.length === 0) return;
  for (const item of items) {
    const message = buildSteerMessage(item);
    await input.onDurableMessage?.(message);
    state.messages = [...state.messages, message];
    yield {
      type: "steer_applied",
      sessionId: input.sessionId,
      turnId: input.turnId,
      steerId: item.steerId,
      preview: steerPreview(item.text),
    };
  }
}
