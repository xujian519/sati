/**
 * 快捷键的输入焦点判定。
 *
 * 撤销/重做挂在 `window` 上（画布未必持有焦点），所以必须自己让开正在编辑的输入框：在说明
 * 文本框里按 Ctrl/Cmd+Z 应该撤销刚打的字，而不是撤销一条标注。
 */

/** 是否正在可编辑控件里打字（此时不接管快捷键）。 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (target === null || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const editable = target.getAttribute("contenteditable");
  if (editable !== null && editable !== "false") return true;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}
