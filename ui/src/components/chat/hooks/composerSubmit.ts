/**
 * 程序化触发提交用的伪事件，与提交处理器共享的最小事件契约。
 *
 * 两处需要伪事件：斜杠命令执行完成后延迟提交（`useSlashCommandExecute`），
 * 以及忙碌队列在会话空闲后补发（`useChatComposerState`）——故从
 * `useChatComposerState.ts` 抽出（#159 N01），两处共用同一份。
 *
 * 提交路径只依赖 `preventDefault`；真实 UI 事件（FormEvent / MouseEvent /
 * TouchEvent / KeyboardEvent）与该契约结构上兼容，以最小契约收敛类型，
 * 避免伪事件经双重断言冒充 `FormEvent`（#646 sweep P1.3）。
 */
export type MinimalSubmitEvent = { preventDefault: () => void };

export type ComposerSubmitHandler = (event: MinimalSubmitEvent) => Promise<void>;

export const createFakeSubmitEvent = (): MinimalSubmitEvent => ({ preventDefault: () => undefined });
