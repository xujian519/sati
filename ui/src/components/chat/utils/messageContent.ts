/**
 * 消息内容 → 可渲染字符串。
 *
 * 原先内联在 `view/subcomponents/MessageComponent.tsx`（#159 N04 抽出）：拆
 * `ToolResultBlock` 时父子两处都要用，故上移到 `chat/utils/`。搬移未改一个 token。
 */
export const stringifyMessageContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  try {
    return typeof content === "object" ? JSON.stringify(content, null, 2) : String(content);
  } catch {
    // Circular or otherwise unserializable content — degrade to String().
    return String(content);
  }
};
