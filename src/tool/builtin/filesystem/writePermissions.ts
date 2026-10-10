import path from "node:path";
import type { PermissionResult, PermissionRule } from "../../../permission/index.js";
import type { SatiToolRuntimeContext } from "../../protocol/types.js";
import { isSymlinkEscapeError, resolveSatiWorkspacePath } from "./pathSafety.js";

export function checkFilesystemWritePermission(
  toolName: "write_file" | "edit_file",
  inputPath: string,
  context: SatiToolRuntimeContext,
): PermissionResult {
  const workspaceResolved = resolveSatiWorkspacePath(inputPath, context, { forWrite: true });
  if (workspaceResolved.ok) {
    return { type: "passthrough" };
  }

  // 工作区里的软链把真实落点引到 root 外：不给审批入口。审批授予的是「某个文件夹」，
  // 这类路径的词法落点只是假象、真实落点不在任何 root 内，批准了执行层那道落点闸
  // （不得被 allow 短路）也会拒——问一次再拒一次只会误导。要写那个真实位置，直接写
  // 真实路径即可（走正常的外部目录审批）。
  if (isSymlinkEscapeError(workspaceResolved.error)) {
    const escapeMessage = workspaceResolved.error.message;
    return { type: "deny", reason: { type: "safety", message: escapeMessage }, message: escapeMessage };
  }

  const outsideResolved = resolveSatiWorkspacePath(inputPath, context, {
    forWrite: true,
    allowOutsideWorkspace: true,
  });
  if (!outsideResolved.ok) {
    return {
      type: "deny",
      reason: { type: "safety", message: outsideResolved.error.message },
      message: outsideResolved.error.message,
    };
  }

  const rule = buildRecursiveFileWriteRule(toolName, outsideResolved.absolutePath);
  const reason = {
    type: "tool" as const,
    toolName,
    message: `${toolName} targets a path outside the workspace.`,
  };
  return {
    type: "ask",
    reason,
    request: {
      toolCallId: "",
      toolName,
      inputSummary: JSON.stringify({ file_path: outsideResolved.absolutePath }),
      reason,
      options: [
        { id: "allow_once", label: "Allow once" },
        { id: "allow_session", label: "Allow this folder for this session", rules: [rule] },
        { id: "deny", label: "Deny" },
        { id: "cancel", label: "Cancel" },
      ],
      metadata: {
        externalPath: outsideResolved.absolutePath,
        allowedDirectory: path.dirname(outsideResolved.absolutePath),
        pattern: rule.pattern,
      },
    },
  };
}

function buildRecursiveFileWriteRule(toolName: "write_file" | "edit_file", absolutePath: string): PermissionRule {
  return {
    source: "session",
    behavior: "allow",
    toolName,
    pattern: path.join(path.dirname(absolutePath), "*"),
  };
}
