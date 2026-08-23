import path from "node:path";
import type { PermissionResult, PermissionRule } from "../../../permission/index.js";
import type { SatiToolRuntimeContext } from "../../protocol/types.js";
import { resolveSatiWorkspacePath } from "./pathSafety.js";

/**
 * read_file / send_attachment 共用的只读类权限检查：workspace 内（或已登记
 * 的附件路径）直接 passthrough；workspace 外先 deny 非 path_not_allowed 错误，
 * 再以 ask + 会话级目录 allow 规则请求用户授权。
 */
export function checkReadonlyPathPermission(
  toolName: string,
  inputPath: string,
  context: SatiToolRuntimeContext,
): PermissionResult {
  const workspaceResolved = resolveSatiWorkspacePath(inputPath, context, {
    mustExist: true,
    allowRegisteredReadFiles: true,
  });
  if (workspaceResolved.ok) {
    return { type: "passthrough" };
  }
  if (workspaceResolved.error.code !== "path_not_allowed") {
    return {
      type: "deny",
      reason: { type: "safety", message: workspaceResolved.error.message },
      message: workspaceResolved.error.message,
    };
  }

  const outsideResolved = resolveSatiWorkspacePath(inputPath, context, {
    mustExist: true,
    allowOutsideWorkspace: true,
  });
  if (!outsideResolved.ok) {
    return {
      type: "deny",
      reason: { type: "safety", message: outsideResolved.error.message },
      message: outsideResolved.error.message,
    };
  }

  const rule: PermissionRule = {
    source: "session",
    behavior: "allow",
    toolName,
    pattern: path.join(path.dirname(outsideResolved.absolutePath), "*"),
  };
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
