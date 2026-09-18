import type { FormEvent, KeyboardEvent, MouseEvent, TouchEvent } from "react";

/**
 * 程序化触发提交用的伪事件。
 *
 * 两处需要它：斜杠命令执行完成后延迟提交（`useSlashCommandExecute`），
 * 以及忙碌队列在会话空闲后补发（`useChatComposerState`）——故从
 * `useChatComposerState.ts` 抽出（#159 N01），两处共用同一份。
 */
export type ComposerSubmitHandler = (
  event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
) => Promise<void>;

export const createFakeSubmitEvent = () => {
  return { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;
};
