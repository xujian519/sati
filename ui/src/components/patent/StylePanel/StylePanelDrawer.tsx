/**
 * 右侧滑出抽屉：左栏参数表单 + 右栏 iframe 实时预览 + 底部动作栏。
 * 动作闭环：
 *   · 导出 HTML —— 本地 Blob 下载当前 srcdoc（所见即所得）
 *   · 保存预设 / 导出 PDF —— 经 sati-command 交给 agent 执行后端工具
 *     （document_style_preset / render_patent_document），保持工具契约与审计
 */

import { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Check, ClipboardCopy, Download, FileDown, Loader2, RotateCcw, Save, X } from "lucide-react";
import type { SessionProvider } from "../../../types/app";
import { useStylePanel } from "./StylePanelContext";
import StylePanelForm from "./StylePanelForm";
import StylePanelPreview from "./StylePanelPreview";
import { useDocumentSource } from "./utils/useDocumentSource";

type StylePanelDrawerProps = {
  sendMessage: (message: Record<string, unknown>) => void;
  projectName: string;
  projectPath: string;
  sessionId: string | null;
  provider: SessionProvider;
};

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? "document.html";
}

export default function StylePanelDrawer({
  sendMessage,
  projectName,
  projectPath,
  sessionId,
  provider,
}: StylePanelDrawerProps) {
  const { t } = useTranslation("stylePanel");
  const { state, closePanel, updateStyle, resetStyle } = useStylePanel();
  const [presetName, setPresetName] = useState("");
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState<null | "preset" | "export">(null);

  const { srcdoc, loadError, reload } = useDocumentSource({
    htmlPath: state.htmlPath,
    style: state.style,
    projectName,
  });

  const styleJson = useMemo(() => JSON.stringify(state.style, null, 2), [state.style]);

  const close = useCallback(() => {
    closePanel();
    setPresetName("");
    setCopied(false);
    setSending(null);
  }, [closePanel]);

  const exportHtml = useCallback(() => {
    if (srcdoc === "") return;
    const blob = new Blob([srcdoc], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = basename(state.htmlPath);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, [srcdoc, state.htmlPath]);

  const sendAgentCommand = useCallback(
    (kind: "preset" | "export", command: string) => {
      setSending(kind);
      sendMessage({
        type: "sati-command",
        command,
        options: {
          sessionId,
          projectPath,
          providerHint: provider,
          userVisibleInput: command,
        },
      });
    },
    [sendMessage, sessionId, projectPath, provider],
  );

  const savePreset = useCallback(() => {
    const name = presetName.trim();
    if (!name) return;
    sendAgentCommand(
      "preset",
      `请将以下排版参数保存为文书样式预设「${name}」（使用 document_style_preset 工具，action=save）：\n${styleJson}`,
    );
  }, [presetName, sendAgentCommand, styleJson]);

  const exportPdf = useCallback(() => {
    sendAgentCommand(
      "export",
      `请使用以下排版参数重新渲染文书并导出 HTML/PDF（render_patent_document：template 与 sections 保持原样，style 使用下述参数，输出覆盖原文件）：\nHTML 文件：${state.htmlPath}\n排版参数：\n${styleJson}`,
    );
  }, [sendAgentCommand, state.htmlPath, styleJson]);

  const copyStyle = useCallback(() => {
    navigator.clipboard
      .writeText(styleJson)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        // 剪贴板不可用时忽略（隐私模式等场景）
      });
  }, [styleJson]);

  if (!state.open) return null;

  const actionButtonClass =
    "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors";

  return createPortal(
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label={t("panel.title")}>
      {/* overlay */}
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[1px]" onClick={close} aria-hidden="true" />
      {/* 右侧抽屉 */}
      <div className="absolute inset-y-0 right-0 flex w-[min(94vw,960px)] flex-col border-l border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-950">
        {/* 头部 */}
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-200 px-4 dark:border-neutral-800">
          <h2 className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-neutral-900 dark:text-neutral-100">
            <FileDown className="h-4 w-4 shrink-0 text-neutral-400" />
            <span className="truncate">{t("panel.title")}</span>
            <span className="ml-1 truncate font-mono text-[11px] font-normal text-neutral-400">
              {basename(state.htmlPath)}
            </span>
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label={t("panel.close")}
            className="rounded-md p-1.5 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <X className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </header>

        {/* 主体：左表单 / 右预览 */}
        <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)]">
          <div className="min-h-0 overflow-y-auto border-r border-neutral-200 dark:border-neutral-800">
            <StylePanelForm style={state.style} onChange={updateStyle} />
          </div>
          <div className="min-h-0 bg-neutral-100 dark:bg-neutral-900">
            <StylePanelPreview srcdoc={srcdoc} loadError={loadError} onRetry={reload} />
          </div>
        </div>

        {/* 底部动作栏 */}
        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-neutral-200 px-4 py-2.5 dark:border-neutral-800">
          <button
            type="button"
            onClick={exportHtml}
            disabled={srcdoc === ""}
            className={`${actionButtonClass} bg-neutral-900 text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white`}
          >
            <Download className="h-3.5 w-3.5" />
            {t("actions.exportHtml")}
          </button>

          <div className="flex min-w-0 items-center gap-1.5 rounded-md border border-neutral-200 px-2 py-1 dark:border-neutral-700">
            <input
              className="min-w-0 w-36 bg-transparent text-[12px] text-neutral-800 outline-none placeholder:text-neutral-400 dark:text-neutral-100"
              value={presetName}
              placeholder={t("actions.presetPlaceholder")}
              onChange={e => setPresetName(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") savePreset();
              }}
            />
            <button
              type="button"
              onClick={savePreset}
              disabled={sending === "preset" || presetName.trim() === ""}
              className={`${actionButtonClass} border border-neutral-200 text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800`}
            >
              {sending === "preset" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              {t("actions.savePreset")}
            </button>
          </div>

          <button
            type="button"
            onClick={exportPdf}
            disabled={sending === "export"}
            className={`${actionButtonClass} border border-neutral-200 text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800`}
          >
            {sending === "export" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FileDown className="h-3.5 w-3.5" />
            )}
            {t("actions.exportPdf")}
          </button>

          <button
            type="button"
            onClick={copyStyle}
            className={`${actionButtonClass} border border-neutral-200 text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800`}
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <ClipboardCopy className="h-3.5 w-3.5" />}
            {copied ? t("actions.copied") : t("actions.copyStyle")}
          </button>

          <button
            type="button"
            onClick={resetStyle}
            className={`${actionButtonClass} border border-neutral-200 text-neutral-500 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800`}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t("actions.reset")}
          </button>

          <span className="ml-auto hidden text-[11px] text-neutral-400 sm:inline dark:text-neutral-500">
            {t("panel.exportHint")}
          </span>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
