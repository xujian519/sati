/**
 * 退出确认（上游 #606 移植）。
 *
 * 正念智能体是常驻应用：关掉主窗口只是隐藏，本地服务与后台任务继续跑；而
 * "退出"会停掉 gateway / server 子进程与正在运行的后台任务。因此用户主动退出
 * 前给一次确认，默认按钮是"取消"——误触的代价远大于多点一次。
 *
 * 本模块刻意不依赖 `electron` 类型：这里只有判定与文案，接线留在 main.ts，
 * 这样判定表与两种语言的文案都能直接单测。
 */

/** 退出前该做什么。 */
export type QuitAction = "ignore" | "confirm" | "shutdown";

export type QuitGateState = {
  /** 关停已经开始：重复的退出请求必须忽略，否则会把子进程杀到一半就退出。 */
  shutdownStarted: boolean;
  /** 确认框正开着：期间的再次退出（连按 Cmd+Q）不再叠一个框。 */
  promptOpen: boolean;
  /** 用户已确认过退出。 */
  confirmed: boolean;
  /** 程序化退出（启动失败、无托盘兜底）不弹确认。 */
  skipConfirmation: boolean;
};

/**
 * 退出请求的判定表：已开始关停或确认框已开着 → 忽略；已确认或程序化退出 →
 * 直接关停；否则先确认。
 */
export function resolveQuitAction(state: QuitGateState): QuitAction {
  if (state.shutdownStarted || state.promptOpen) return "ignore";
  if (state.confirmed || state.skipConfirmation) return "shutdown";
  return "confirm";
}

/** 结构上等价于 Electron 的 MessageBoxOptions，可直接交给 dialog.showMessageBox。 */
export type QuitPrompt = {
  type: "question";
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
};

export function buildQuitPrompt(zh: boolean): QuitPrompt {
  if (zh) {
    return {
      type: "question",
      title: "Sati",
      message: "退出正念智能体？",
      detail:
        "退出会停止常驻的本地服务与正在运行的后台任务。如果只是想暂时离开，关闭主窗口即可——服务会继续在后台运行。",
      buttons: ["退出", "取消"],
      defaultId: 1,
      cancelId: 1,
    };
  }
  return {
    type: "question",
    title: "Sati",
    message: "Quit Sati?",
    detail:
      "Quitting stops the always-on local service and any running background tasks. To step away, close the main window instead — the service keeps running.",
    buttons: ["Quit", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  };
}
