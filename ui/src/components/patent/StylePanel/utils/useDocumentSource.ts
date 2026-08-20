/**
 * 读文书 HTML + 注入 style 覆盖 → srcdoc。供预览与「导出 HTML」共用，
 * 保证所见即所得：下载的 HTML 与 iframe 渲染的是同一份。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../../../utils/api";
import type { DocumentStyle } from "../types";
import { buildStyleOverridesCss, injectStyleCssIntoHtml } from "./documentStyle";

type UseDocumentSourceOptions = {
  htmlPath: string;
  style: DocumentStyle;
  projectName: string;
};

export function useDocumentSource({ htmlPath, style, projectName }: UseDocumentSourceOptions) {
  const [sourceHtml, setSourceHtml] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSourceHtml(null);
    setLoadError(null);
    if (!projectName || !htmlPath) {
      setLoadError("no_project");
      return;
    }
    api
      .readFile(projectName, htmlPath)
      .then(async (response: { ok: boolean; status: number; json: () => Promise<unknown> }) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as { content?: string; error?: string };
        if (cancelled) return;
        if (typeof data.content !== "string") {
          setLoadError(data.error ?? "read_failed");
          return;
        }
        setSourceHtml(data.content);
      })
      .catch(() => {
        if (!cancelled) setLoadError("read_failed");
      });
    return () => {
      cancelled = true;
    };
  }, [projectName, htmlPath, reloadKey]);

  const srcdoc = useMemo(() => {
    if (sourceHtml === null) return "";
    return injectStyleCssIntoHtml(sourceHtml, buildStyleOverridesCss(style));
  }, [sourceHtml, style]);

  const reload = useCallback(() => setReloadKey(key => key + 1), []);

  return { sourceHtml, srcdoc, loadError, reload };
}
