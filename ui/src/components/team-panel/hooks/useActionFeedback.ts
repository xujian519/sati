import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PanelActionResult } from "../types";

export type ActionFeedback = { kind: "ok" | "error"; text: string } | null;

/**
 * 面板操作反馈样板（精简 C2 提取）：busy + feedback 双 state 与 ok/error/异常三路结果收敛。
 * TeamOverview/MemberGrid/TaskBoard 原各 ~25 行重复样板收敛为一行；成功路径的副作用
 * （清空输入等）经 onSuccess 回调注入（调用方保持对局部 state 的控制）。
 * 失败反馈优先展示后端契约 message（不走 i18n），异常路径展示运行时消息。
 */
export function useActionFeedback() {
  const { t } = useTranslation("teamPanel");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<ActionFeedback>(null);

  const runAction = async (action: () => Promise<PanelActionResult>, onSuccess?: () => void): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const result = await action();
      if (result.ok) {
        onSuccess?.();
        setFeedback({ kind: "ok", text: t("opSucceeded") });
      } else {
        // 后端契约错误（如 team_not_captain / team_already_exists）：具体 message 直接展示，不走 i18n
        setFeedback({ kind: "error", text: result.error.message });
      }
    } catch (err) {
      // 网络失败等异常：运行时错误消息直接展示（与 useTeamPanel 的 error 语义一致，不走 i18n）
      setFeedback({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return { busy, feedback, runAction };
}
