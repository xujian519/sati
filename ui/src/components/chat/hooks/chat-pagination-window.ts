/**
 * 分页窗口的取值 —— 分页 hook（`use-chat-pagination-scroll`）与全量加载 hook
 * （`use-chat-load-all`）共用，单列成模块以免两个 hook 互相 import 形成环（issue #467）。
 *
 * ⚠️ 这两个数字是**行为契约**：改它们会让分页/可见窗口的行为立刻变化，
 * 既有 `useChatSessionState.pagination-scroll.spec.ts` 会变红（有意为之）。
 */

/** 每次「加载更多」向服务端要的条数。 */
export const MESSAGES_PER_PAGE = 20;

/** 会话首屏默认渲染的最近条数（「加载更早的」每次再放开 100 条）。 */
export const INITIAL_VISIBLE_MESSAGES = 100;
