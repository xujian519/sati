import { useCallback, useRef, type RefObject } from "react";
import { authenticatedFetch } from "../../../utils/api";
import { UI_TIMEOUTS } from "../../../constants/timeouts";
import { logError, logWarn } from "../../../utils/logging";
import type { SlashCommand } from "./useSlashCommands";
import { createFakeSubmitEvent, type ComposerSubmitHandler } from "./composerSubmit";
import type { UseChatComposerStateArgs } from "./useChatComposerState";

/**
 * 斜杠命令执行层：`/api/commands/execute` 往返 + 内置/自定义命令的落地渲染。
 *
 * 从 `useChatComposerState.ts` 整体搬出（#159 N01 缝 2），**被搬代码逐字未改**：
 * 三个 `useCallback`（`handleBuiltInCommand` / `handleCustomCommand` / `executeCommand`）
 * 与 `skipSlashDetectionOnceRef` 的注释、`CommandExecutionResult` 契约都原样迁入。
 *
 * 与外界的三个接缝：
 * - 输入框写入走 `applyInputValue`（父级持有，保证 state 与 `inputValueRef` 成对同步）；
 * - 延迟提交走 `handleSubmitRef`（父级在 `handleSubmit` 定义后回填，天然是后绑定）；
 * - `skipSlashDetectionOnceRef` 由本层写入、由父级 `handleSubmit` 读取，故随返回值交回。
 */

export interface CommandExecutionResult {
  type: "builtin" | "custom";
  action?: string;
  /**
   * SAFETY: 内置命令负载为按 action 分派的异构契约（help/content、model/current+available、
   * cost/tokenUsage+cost、status/version+uptime、memory/path、rewind/steps、
   * skillInstall/slug+skillMeta+installPath… 各 action 形状互不相同），且消费处为
   * handleBuiltInCommand 的真值判断+模板拼接（约 30 处字段读取）。
   * 收敛为逐 action 判别联合需同时决定各字段缺失时的兜底值，属行为面变更，
   * 故本卡（C40 保守档）保留 any 并登记，另卡按「action → payload 接口」建模。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 见上方 SAFETY 说明：异构 action 负载，另卡建判别联合。
  data?: any;
  content?: string;
  hasBashCommands?: boolean;
  hasFileIncludes?: boolean;
  // Set by /api/commands/execute for bundled-skill stubs and on-disk
  // SKILL.md commands. When passthrough=true, the frontend re-submits the
  // raw `/<name> <args>` text as user input so the agent's SkillTool runs it.
  metadata?: {
    type?: string;
    passthrough?: boolean;
    [key: string]: unknown;
  };
  command?: string;
}

type SlashCommandExecuteOptions = Pick<
  UseChatComposerStateArgs,
  | "selectedProject"
  | "currentSessionId"
  | "model"
  | "tokenBudget"
  | "addMessage"
  | "clearMessages"
  | "rewindMessages"
  | "onFileOpen"
  | "onShowSettings"
> & {
  /** 当前输入框内容（`executeCommand` 用它切出命令参数）。 */
  input: string;
  /** 统一写输入框的入口（state + `inputValueRef` 成对同步）。 */
  applyInputValue: (value: string) => void;
  /** 父级回填的提交入口；本层在命令执行完成后延迟调用它。 */
  handleSubmitRef: RefObject<ComposerSubmitHandler | null>;
};

type SlashCommandExecuteApi = {
  /**
   * 唯一的对外入口：`/api/commands/execute` 往返，并按 `result.type` 分派到
   * 内置（本模块内部）或自定义命令（本模块内部）。两者都不对外暴露——原先它们
   * 之所以在父 hook 里，只是因为与 `executeCommand` 同住一个文件。
   */
  executeCommand: (command: SlashCommand, rawInput?: string) => Promise<void>;
  /** 一次性跳过下次 submit 的斜杠再识别（父级 `handleSubmit` 读取）。 */
  skipSlashDetectionOnceRef: RefObject<boolean>;
};

export function useSlashCommandExecute({
  selectedProject,
  currentSessionId,
  model,
  tokenBudget,
  input,
  addMessage,
  clearMessages,
  rewindMessages,
  onFileOpen,
  onShowSettings,
  applyInputValue,
  handleSubmitRef,
}: SlashCommandExecuteOptions): SlashCommandExecuteApi {
  // One-shot flag set by `handleCustomCommand` when re-submitting passthrough
  // slash content (e.g. `/projects` for bundled stubs, `/canvas` for skills).
  // Without this, handleSubmit would see the leading `/`, match the command
  // again, call executeCommand, get the same passthrough back, and loop —
  // user-visibly: the input keeps deleting/refilling.
  const skipSlashDetectionOnceRef = useRef(false);

  const handleBuiltInCommand = useCallback(
    async (result: CommandExecutionResult) => {
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
    },
    [onFileOpen, onShowSettings, addMessage, clearMessages, rewindMessages],
  );

  const handleCustomCommand = useCallback(
    async (result: CommandExecutionResult) => {
      const { content, hasBashCommands, metadata } = result;

      if (hasBashCommands) {
        const confirmed = window.confirm(
          "This command contains bash commands that will be executed. Do you want to proceed?",
        );
        if (!confirmed) {
          addMessage({
            type: "assistant",
            content: "Command execution cancelled",
            timestamp: Date.now(),
          });
          return;
        }
      }

      const commandContent = content || "";
      applyInputValue(commandContent);

      // Passthrough commands (bundled-skill stubs, on-disk skills) return their
      // own slash text as `content`. Suppress the next handleSubmit's slash
      // re-detection, otherwise it loops: detect /, executeCommand, passthrough,
      // setInput, submit, detect /, ... See skipSlashDetectionOnceRef.
      if (metadata && (metadata as { passthrough?: unknown }).passthrough) {
        skipSlashDetectionOnceRef.current = true;
      }

      // Defer submit to next tick so the command text is reflected in UI before dispatching.
      setTimeout(() => {
        if (handleSubmitRef.current) {
          handleSubmitRef.current(createFakeSubmitEvent());
        }
      }, UI_TIMEOUTS.NEXT_TASK_MS);
    },
    // `handleSubmitRef` 是父级回填的 ref 对象（身份稳定），列入依赖只为满足 exhaustive-deps。
    [addMessage, applyInputValue, handleSubmitRef],
  );

  const executeCommand = useCallback(
    async (command: SlashCommand, rawInput?: string) => {
      if (!command || !selectedProject) {
        return;
      }

      try {
        const effectiveInput = rawInput ?? input;
        const rawArgs = effectiveInput.startsWith(command.name)
          ? effectiveInput.slice(command.name.length).trimStart()
          : "";
        const args = rawArgs.trim() ? rawArgs.trim().split(/\s+/) : [];

        const context = {
          projectPath: selectedProject.fullPath || selectedProject.path,
          projectName: selectedProject.name,
          sessionId: currentSessionId,
          model,
          tokenUsage: tokenBudget,
        };

        const response = await authenticatedFetch("/api/commands/execute", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            commandName: command.name,
            commandPath: command.path,
            args,
            rawArgs,
            rawInput: effectiveInput,
            context,
          }),
        });

        if (!response.ok) {
          let errorMessage = `Failed to execute command (${response.status})`;
          try {
            const errorData = await response.json();
            errorMessage = errorData?.message || errorData?.error || errorMessage;
          } catch {
            // Ignore JSON parse failures and use fallback message.
          }
          throw new Error(errorMessage);
        }

        const result = (await response.json()) as CommandExecutionResult;
        if (result.type === "builtin") {
          await handleBuiltInCommand(result);
          applyInputValue("");
        } else if (result.type === "custom") {
          await handleCustomCommand(result);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        logError("Error executing command:", error);
        addMessage({
          type: "assistant",
          content: `Error executing command: ${message}`,
          timestamp: Date.now(),
        });
      }
    },
    [
      applyInputValue,
      model,
      currentSessionId,
      handleBuiltInCommand,
      handleCustomCommand,
      input,
      selectedProject,
      addMessage,
      tokenBudget,
    ],
  );

  // `handleBuiltInCommand` / `handleCustomCommand` 只被 `executeCommand` 调用，留在内部。
  return { executeCommand, skipSlashDetectionOnceRef };
}
