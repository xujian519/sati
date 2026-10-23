import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";

/**
 * textarea 自适应高度：按内容撑高、超过两行标记展开态；空输入时复位。
 *
 * 从 `useChatComposerState.ts` 搬出（#646 B2.5），**两条 effect 逐字未改且相对顺序保留**；
 * 调用点就在它们原来的位置（草稿 hook 之后、输入层之前）。
 */

type ComposerAutosizeOptions = {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  input: string;
  setIsTextareaExpanded: Dispatch<SetStateAction<boolean>>;
};

export function useComposerAutosize({ textareaRef, input, setIsTextareaExpanded }: ComposerAutosizeOptions): void {
  useEffect(() => {
    if (!textareaRef.current) {
      return;
    }
    // Re-run when input changes so restored drafts get the same autosize behavior as typed text.
    textareaRef.current.style.height = "auto";
    textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    const lineHeight = parseInt(window.getComputedStyle(textareaRef.current).lineHeight);
    const expanded = textareaRef.current.scrollHeight > lineHeight * 2;
    setIsTextareaExpanded(expanded);
  }, [input, textareaRef, setIsTextareaExpanded]);

  useEffect(() => {
    if (!textareaRef.current || input.trim()) {
      return;
    }
    textareaRef.current.style.height = "auto";
    setIsTextareaExpanded(false);
  }, [input, textareaRef, setIsTextareaExpanded]);
}
