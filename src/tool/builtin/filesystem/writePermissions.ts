import { statSync } from "node:fs";
import path from "node:path";
import type { PermissionResult, PermissionRule } from "../../../permission/index.js";
import type { SatiToolRuntimeContext } from "../../protocol/types.js";
import { isSymlinkEscapeError, resolveRealWritePath, resolveSatiWorkspacePath } from "./pathSafety.js";
import { hardlinkTargetMessage, isLexicallyInsideWorkspace } from "./writeTarget.js";

export function checkFilesystemWritePermission(
  toolName: "write_file" | "edit_file",
  inputPath: string,
  context: SatiToolRuntimeContext,
): PermissionResult {
  const workspaceResolved = resolveSatiWorkspacePath(inputPath, context, { forWrite: true });
  if (workspaceResolved.ok) {
    // 硬链接不体现在 realpath 里：工作区里的一个硬链接会让写入同步改到工作区外的
    // 同名 inode。这里先按权限拒绝（执行层还会用 fstat 再核一次，含窗口内新建的链接）。
    const hardlinkDenial = checkHardlinkedTarget(workspaceResolved.absolutePath, context);
    if (hardlinkDenial) {
      return hardlinkDenial;
    }
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

/**
 * 工作区内已存在且 nlink > 1 的写目标：拒绝。硬链接不体现在 realpath 里，
 * 另一个链接可能就在工作区外；「有多个链接」无法告诉我们链接在哪，因此一律拒绝。
 * `bypassPermissions` 是用户显式选择「全都批准」，与软链闸一致不介入。
 */
function checkHardlinkedTarget(absolutePath: string, context: SatiToolRuntimeContext): PermissionResult | undefined {
  if (context.permissionMode === "bypassPermissions") {
    return undefined;
  }
  if (!isLexicallyInsideWorkspace(absolutePath, context)) {
    return undefined;
  }
  const realPath = resolveRealWritePath(absolutePath);
  if (!realPath) {
    return undefined;
  }
  let nlink: number;
  try {
    const targetStat = statSync(realPath);
    if (!targetStat.isFile()) {
      return undefined;
    }
    nlink = targetStat.nlink;
  } catch {
    // 目标尚不存在（新建/悬空链）：没有已存在的硬链接可判，交给执行层。
    return undefined;
  }
  if (nlink <= 1) {
    return undefined;
  }
  const message = hardlinkTargetMessage(absolutePath, nlink);
  return { type: "deny", reason: { type: "safety", message }, message };
}
