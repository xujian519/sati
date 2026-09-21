/**
 * hook 声明的「人可读投影」（审批界面据此让人知道自己在授权什么）。
 *
 * 只做投影、不做判断：这里出现的文本就是将要被执行的命令 / 将被请求的 URL /
 * 将送进模型的提示词首行。路径与命令不进遥测，但**必须**出现在本机审批界面上——
 * 看不见内容的「授权」不是授权。
 */
import type { SatiHookEvent } from "../../hooks/protocol/events.js";
import type { SatiHookCommand, SatiHookMatcher } from "../../hooks/protocol/settings.js";
import type { SatiLoadedPlugin } from "../protocol/plugin.js";

/** 单条摘要上限：够看清命令，又不至于把一条 hook 撑成一屏。 */
export const HOOK_DECLARATION_SUMMARY_MAX_CHARS = 300;

export type HookDeclarationSummary = {
  event: SatiHookEvent;
  /** matcher 模式；缺省 = 该事件下全部匹配。 */
  matcher?: string;
  kind: SatiHookCommand["type"];
  summary: string;
  /** `if` 条件（子代理名等限定）。 */
  condition?: string;
};

export function summarizeHookDeclarations(plugin: SatiLoadedPlugin): HookDeclarationSummary[] {
  const summaries: HookDeclarationSummary[] = [];
  const settings = plugin.hooksConfig ?? {};
  for (const [event, matchers] of Object.entries(settings) as Array<[SatiHookEvent, SatiHookMatcher[] | undefined]>) {
    for (const matcher of matchers ?? []) {
      for (const hook of matcher.hooks) {
        summaries.push({
          event,
          ...(matcher.matcher === undefined ? {} : { matcher: matcher.matcher }),
          kind: hook.type,
          summary: truncate(describeHookCommand(hook)),
          ...(hook.if === undefined ? {} : { condition: hook.if }),
        });
      }
    }
  }
  return summaries;
}

function describeHookCommand(hook: SatiHookCommand): string {
  if (hook.type === "command") return hook.command;
  if (hook.type === "http") return hook.url;
  if (hook.type === "callback") return hook.name;
  return hook.prompt;
}

function truncate(text: string): string {
  const singleLine = text.replace(/\s+/gu, " ").trim();
  return singleLine.length > HOOK_DECLARATION_SUMMARY_MAX_CHARS
    ? `${singleLine.slice(0, HOOK_DECLARATION_SUMMARY_MAX_CHARS)}…`
    : singleLine;
}
