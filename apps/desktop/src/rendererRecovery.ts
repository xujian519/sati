import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from "electron";

type RecoveryOptions = {
  isQuitting: () => boolean;
  isChinese: () => boolean;
  showDialog: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;
  log: (event: string, details: Record<string, string | number>) => void;
};

/**
 * 渲染进程崩溃/无响应时的恢复提示（上游 #568 移植）。
 * 逻辑放主进程：界面卡死时渲染进程里的任何自愈代码都已经跑不动了。
 */
export function installRendererRecovery(window: BrowserWindow, options: RecoveryOptions) {
  let showingRecovery = false;
  const recover = async (crashed: boolean) => {
    if (showingRecovery || options.isQuitting() || window.isDestroyed()) return;
    showingRecovery = true;
    const zh = options.isChinese();
    try {
      const { response } = await options.showDialog({
        type: "warning",
        title: "Sati",
        message: zh
          ? crashed
            ? "界面意外关闭"
            : "界面暂时没有响应"
          : crashed
            ? "The interface closed unexpectedly"
            : "The interface is not responding",
        detail: zh
          ? "可以重新加载界面。后台任务不会因此停止，最近保存的草稿会保留。"
          : "You can reload the interface. Background tasks will continue and recently saved drafts will be retained.",
        buttons: zh
          ? ["重新加载界面", crashed ? "暂不处理" : "继续等待"]
          : ["Reload interface", crashed ? "Not now" : "Keep waiting"],
        defaultId: 1,
        cancelId: 1,
      });
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
  // F5 兜底：Electron 不像浏览器那样默认绑定功能键，这条只在应用菜单不可用时生效。
  // 不复刻上游的 Ctrl/Cmd+R —— 应用菜单已用 role: "reload" 绑定同一加速键，
  // 再拦一次会让一次按键触发两次重载。
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.isAutoRepeat || input.isComposing || input.alt) return;
    if (input.key === "F5") {
      event.preventDefault();
      window.webContents.reload();
    }
  });
}
