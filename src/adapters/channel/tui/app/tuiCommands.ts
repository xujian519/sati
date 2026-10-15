import type React from "react";
import type { GatewayMode } from "../../../../gateway/index.js";
import { readPermissionSettings, writePermissionSettings } from "../../../../permission/settings.js";
import type { TuiGatewaySurface } from "./gatewaySurface.js";
import type { TuiAppState, TuiMessage } from "./types.js";

/**
 * TUI 斜杠命令处理（`#646` sweep P2.8 从 `TuiApp` 抽出的 commands 层）。
 *
 * 依赖全部显式注入（gateway 面 + `setState` + 各交互回调），不读取组件闭包，
 * 因此可在无 React/ink 运行时的环境下直测。返回 `true` 表示命令已被消费（`TuiApp`
 * 据此短路普通消息提交）；非 `/` 前缀返回 `false`。
 */
export async function handleCommand(
  command: string,
  gateway: TuiGatewaySurface,
  projectKey: string | undefined,
  setState: React.Dispatch<React.SetStateAction<TuiAppState>>,
  exit: () => void,
  openToolOutput: (msg: Extract<TuiMessage, { role: "tool" }>) => Promise<void>,
  messages: TuiMessage[],
  openSidebar: () => Promise<void>,
  switchToSession: (sessionKey: string, summary?: string) => Promise<void>,
): Promise<boolean> {
  if (!command.startsWith("/")) {
    return false;
  }
  const [name, ...args] = command.split(/\s+/);
  switch (name) {
    case "/new": {
      const result = await gateway.newSession({ channelKey: "tui", projectKey });
      setState(current => ({
        ...current,
        activeSessionKey: result.sessionKey,
        messages: [{ role: "system", text: `New session: ${result.sessionKey}` }],
      }));
      return true;
    }
    case "/sessions":
    case "/switch":
    case "/dashboard": {
      if (name === "/switch" && args.length > 0) {
        const n = parseInt(args[0]!, 10);
        if (!isNaN(n) && n >= 1) {
          const result = await gateway.listSessions({ projectKey, limit: 20 });
          const target = result.sessions[n - 1];
          if (target) {
            const sessionKey = target.sessionKey ?? target.sessionId;
            setState(c => ({ ...c, sessions: result.sessions }));
            void switchToSession(sessionKey, target.summary);
            return true;
          }
        }
      }
      void openSidebar();
      return true;
    }
    case "/permissions": {
      const sub = args[0];
      const current = readPermissionSettings();
      if (!sub) {
        const lines = [
          `skipPermissions: ${current.skipPermissions}`,
          `allow: ${current.allowedTools.length === 0 ? "(none)" : current.allowedTools.join(", ")}`,
          `deny: ${current.disallowedTools.length === 0 ? "(none)" : current.disallowedTools.join(", ")}`,
        ];
        setState(c => ({ ...c, messages: [...c.messages, { role: "system", text: lines.join("\n") }] }));
        return true;
      }
      const entry = args.slice(1).join(" ").trim();
      if (!entry && sub !== "bypass") {
        setState(c => ({
          ...c,
          messages: [
            ...c.messages,
            {
              role: "error",
              text: "Usage: /permissions [allow|deny|clear <entry>|bypass]",
            },
          ],
        }));
        return true;
      }
      if (sub === "allow" && entry) {
        writePermissionSettings({ allowedTools: [...current.allowedTools, entry] });
        setState(c => ({ ...c, messages: [...c.messages, { role: "system", text: `Added allow: ${entry}` }] }));
        return true;
      }
      if (sub === "deny" && entry) {
        writePermissionSettings({ disallowedTools: [...current.disallowedTools, entry] });
        setState(c => ({ ...c, messages: [...c.messages, { role: "system", text: `Added deny: ${entry}` }] }));
        return true;
      }
      if (sub === "clear" && entry) {
        writePermissionSettings({
          allowedTools: current.allowedTools.filter(e => e !== entry),
          disallowedTools: current.disallowedTools.filter(e => e !== entry),
        });
        setState(c => ({ ...c, messages: [...c.messages, { role: "system", text: `Cleared: ${entry}` }] }));
        return true;
      }
      if (sub === "bypass") {
        writePermissionSettings({ skipPermissions: true });
        setState(c => ({
          ...c,
          mode: "bypassPermissions",
          messages: [...c.messages, { role: "system", text: "Permissions bypassed globally (skipPermissions=true)." }],
        }));
        return true;
      }
      setState(c => ({
        ...c,
        messages: [...c.messages, { role: "error", text: `Unknown /permissions subcommand: ${sub}` }],
      }));
      return true;
    }
    case "/mode": {
      const requestedMode = args[0];
      const mode = (
        requestedMode === "plan" || requestedMode === "bypassPermissions" ? requestedMode : "default"
      ) as GatewayMode;
      if (mode === "bypassPermissions") {
        writePermissionSettings({ skipPermissions: true });
      } else {
        const perm = readPermissionSettings();
        if (perm.skipPermissions) {
          writePermissionSettings({ skipPermissions: false });
        }
      }
      setState(current => ({
        ...current,
        mode,
        messages: [...current.messages, { role: "system", text: `Mode: ${mode}` }],
      }));
      return true;
    }
    case "/view": {
      const n = parseInt(args[0] ?? "", 10);
      const tools = messages.filter(
        (m): m is Extract<TuiMessage, { role: "tool" }> =>
          m.role === "tool" && ((m.lineCount ?? 0) > 4 || !!m.resultPath || !!m.fullText),
      );
      if (tools.length === 0) {
        setState(current => ({
          ...current,
          messages: [...current.messages, { role: "system", text: "No tool output to view." }],
        }));
        return true;
      }
      const target = !isNaN(n) && n >= 1 && n <= tools.length ? tools[n - 1]! : tools[tools.length - 1]!;
      void openToolOutput(target);
      return true;
    }
    case "/clear":
      setState(current => ({ ...current, messages: [], focusedIndex: null }));
      return true;
    case "/help":
      setState(current => ({ ...current, helpOpen: !current.helpOpen }));
      return true;
    case "/exit":
      exit();
      return true;
    default:
      setState(current => ({
        ...current,
        messages: [...current.messages, { role: "error", text: `Unknown command ${name}` }],
      }));
      return true;
  }
}

/**
 * 由工具名与 payload 推导持久化的权限条目（`bash` 取命令首词，`git` 取二级子命令）。
 * 「remember (a)」审批与 `bash:*` 白名单铸造共用此逻辑。
 */
export function buildPermissionEntry(toolName: string, payload: unknown): string {
  if (toolName !== "bash") return toolName;
  const record = typeof payload === "object" && payload ? (payload as Record<string, unknown>) : {};
  const command = typeof record.command === "string" ? record.command.trim() : "";
  if (!command) return "bash";
  const tokens = command.split(/\s+/);
  if (tokens[0] === "git" && tokens[1]) return `bash:${tokens[0]} ${tokens[1]}:*`;
  return `bash:${tokens[0]}:*`;
}
