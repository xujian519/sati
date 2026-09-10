import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from "electron";

type RecoveryOptions = {
  isQuitting: () => boolean;
  isChinese: () => boolean;
  showDialog: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;
  log: (event: string, details: Record<string, string | number>) => void;
};

/** 恢复对话框文案：崩溃 / 无响应 × 中文 / 英文（上游 #568）。 */
function buildPrompt(crashed: boolean, zh: boolean): MessageBoxOptions {
  const detail = zh
    ? "可以重新加载界面。后台任务不会因此停止，最近保存的草稿会保留。"
    : "You can reload the interface. Background tasks will continue and recently saved drafts will be retained.";
  if (zh) {
    return {
      type: "warning",
      title: "Sati",
      message: crashed ? "界面意外关闭" : "界面暂时没有响应",
      detail,
      buttons: crashed ? ["重新加载界面", "暂不处理"] : ["重新加载界面", "继续等待"],
      defaultId: 1,
      cancelId: 1,
    };
  }
  return {
    type: "warning",
    title: "Sati",
    message: crashed ? "The interface closed unexpectedly" : "The interface is not responding",
    detail,
    buttons: crashed ? ["Reload interface", "Not now"] : ["Reload interface", "Keep waiting"],
    defaultId: 1,
    cancelId: 1,
  };
}

/**
 * 渲染进程崩溃/无响应时的恢复提示（上游 #568 移植）。
 * 逻辑放主进程：界面卡死时渲染进程里的任何自愈代码都已经跑不动了。
 */
export function installRendererRecovery(window: BrowserWindow, options: RecoveryOptions) {
  let showingRecovery = false;

  const recover = async (crashed: boolean) => {
    if (showingRecovery || options.isQuitting() || window.isDestroyed()) return;
    showingRecovery = true;
    try {
      const { response } = await options.showDialog(buildPrompt(crashed, options.isChinese()));
      if (response === 0 && !options.isQuitting() && !window.isDestroyed()) {
        window.webContents.reload();
      }
    } finally {
      showingRecovery = false;
    }
  };

  window.webContents.on("render-process-gone", (_event, details) => {
    if (options.isQuitting() || details.reason === "clean-exit") return;
    options.log("render-process-gone", { reason: details.reason, exitCode: details.exitCode });
    void recover(true).catch(() => {});
  });
  window.on("unresponsive", () => {
    options.log("unresponsive", {});
    void recover(false).catch(() => {});
  });
  // F5 兜底：Electron 不把功能键绑到 reload（应用菜单里 reload 的默认加速键是
  // CmdOrCtrl+R），浏览器式的 F5 刷新在这里没有人接。
  // Cmd/Ctrl+R 不在此重复绑定：加速键的定义留在应用菜单一处，避免两处各持一份
  // 快捷键定义后各自漂移。
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.isAutoRepeat || input.isComposing || input.alt) return;
    if (input.key === "F5") {
      event.preventDefault();
      window.webContents.reload();
    }
  });
}
