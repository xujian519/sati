import { logWarn } from "../../../utils/logging";
import type { ChatMessage } from "../types/types";
import type { CommandExecutionResult } from "./useSlashCommandExecute";

/**
 * 内置斜杠命令的落地渲染。
 *
 * 从 `useSlashCommandExecute` 的 `handleBuiltInCommand` 整体搬出（#646 B2.4），
 * 函数体与 action 分派逐字未改；React 侧动作经 deps 传入，模块内不调用 hook。
 */

type BuiltInCommandDeps = {
  addMessage: (msg: ChatMessage) => void;
  clearMessages: () => void;
  rewindMessages: (count: number) => void;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
};

export async function runBuiltInCommand(
  result: CommandExecutionResult,
  { addMessage, clearMessages, rewindMessages, onFileOpen, onShowSettings }: BuiltInCommandDeps,
): Promise<void> {
  const { action, data } = result;
  switch (action) {
    case "clear":
      clearMessages();
      break;

    case "help":
      addMessage({
        type: "assistant",
        content: data.content,
        timestamp: Date.now(),
      });
      break;

    case "model": {
      const modelLines = [`**Current Model**: ${data.current.model}`, "", "**Available Models**:"];
      if (data.available && typeof data.available === "object") {
        for (const [provider, models] of Object.entries(data.available)) {
          if (Array.isArray(models) && models.length) {
            modelLines.push("", `${provider}: ${models.join(", ")}`);
          }
        }
      }
      addMessage({
        type: "assistant",
        content: modelLines.join("\n"),
        timestamp: Date.now(),
      });
      break;
    }

    case "cost": {
      const costMessage = `**Token Usage**: ${data.tokenUsage.used.toLocaleString()} / ${data.tokenUsage.total.toLocaleString()} (${data.tokenUsage.percentage}%)\n\n**Estimated Cost**:\n- Input: $${data.cost.input}\n- Output: $${data.cost.output}\n- **Total**: $${data.cost.total}\n\n**Model**: ${data.model}`;
      addMessage({ type: "assistant", content: costMessage, timestamp: Date.now() });
      break;
    }

    case "status": {
      const statusMessage = `**System Status**\n\n- Version: ${data.version}\n- Uptime: ${data.uptime}\n- Model: ${data.model}\n- Provider: ${data.provider}\n- Node.js: ${data.nodeVersion}\n- Platform: ${data.platform}`;
      addMessage({ type: "assistant", content: statusMessage, timestamp: Date.now() });
      break;
    }

    case "memory":
      if (data.error) {
        addMessage({
          type: "assistant",
          content: `Warning: ${data.message}`,
          timestamp: Date.now(),
        });
      } else {
        addMessage({
          type: "assistant",
          content: `${data.message}\n\nPath: \`${data.path}\``,
          timestamp: Date.now(),
        });
        if (data.exists && onFileOpen) {
          onFileOpen(data.path);
        }
      }
      break;

    case "config":
      onShowSettings?.();
      break;

    case "rewind":
      if (data.error) {
        addMessage({
          type: "assistant",
          content: `Warning: ${data.message}`,
          timestamp: Date.now(),
        });
      } else {
        rewindMessages(data.steps * 2);
        addMessage({
          type: "assistant",
          content: `Rewound ${data.steps} step(s). ${data.message}`,
          timestamp: Date.now(),
        });
      }
      break;

    case "skillInstall": {
      if (data.error) {
        addMessage({
          type: "assistant",
          content: `**Skill install failed**\n\n${data.message || data.errorMessage || "Unknown error"}${
            data.stderr ? `\n\n\`\`\`\n${data.stderr}\n\`\`\`` : ""
          }`,
          timestamp: Date.now(),
        });
        break;
      }
      const lines: string[] = [];

      if (data.needsForce) {
        lines.push(
          `⚠️ **\`${data.slug}\` is flagged as suspicious by VirusTotal.** clawhub refused to install without explicit consent.`,
        );
        lines.push("");
        lines.push("Review the skill before retrying. If you trust the source, rerun:");
        lines.push("");
        lines.push("```");
        lines.push(data.retryCommand || `/skill_install ${data.slug} --force`);
        lines.push("```");
      } else if (data.installed) {
        const versionTag = data.skillMeta?.version ? ` v${data.skillMeta.version}` : "";
        const displayName = data.skillMeta?.name || data.slug;
        lines.push(
          `✅ **Installed** \`${displayName}\`${versionTag} (${data.scope === "project" ? "project" : "user"} scope)`,
        );
        lines.push(`Path: \`${data.installPath}\``);
        if (data.skillMeta?.description) {
          lines.push("");
          lines.push(data.skillMeta.description);
        }
      } else {
        lines.push(`⚠️ clawhub finished but \`SKILL.md\` was not found at \`${data.installPath}\`.`);
      }

      if (data.stdout) {
        lines.push("");
        lines.push("```");
        lines.push(data.stdout);
        lines.push("```");
      }
      if (data.stderr) {
        lines.push("");
        lines.push("**stderr**");
        lines.push("```");
        lines.push(data.stderr);
        lines.push("```");
      }
      if (data.exitCode && data.exitCode !== 0 && !data.needsForce) {
        lines.push("");
        lines.push(`Exit code: \`${data.exitCode}\`. ${data.errorMessage || ""}`);
      }
      if (data.installed) {
        lines.push("");
        lines.push(
          "_New skill is on disk — open a fresh chat (or `/clear-caches`) to make Sati see it. The UI slash menu picks it up next time you open `/`._",
        );
      }
      addMessage({
        type: "assistant",
        content: lines.join("\n"),
        timestamp: Date.now(),
      });
      break;
    }

    case "switchProject": {
      // The server validates that an arg was supplied; project lookup
      // happens here because the client already holds the projects list.
      // window.switchProject is registered by AppShellV2 and returns
      // false when no project matches, letting us surface a helpful
      // "not found" message in chat without leaving the page.
      if (data.error) {
        addMessage({
          type: "assistant",
          content: data.message,
          timestamp: Date.now(),
        });
        break;
      }
      const targetName = String(data.projectName ?? "").trim();
      const switched =
        typeof window !== "undefined" && typeof window.switchProject === "function"
          ? window.switchProject(targetName)
          : false;
      addMessage({
        type: "assistant",
        content: switched
          ? `Switched to project: \`${targetName}\``
          : `No project matched \`${targetName}\`. Try the project's directory name (sidebar tooltip).`,
        timestamp: Date.now(),
      });
      break;
    }

    default:
      logWarn("Unknown built-in command action:", action);
  }
}
