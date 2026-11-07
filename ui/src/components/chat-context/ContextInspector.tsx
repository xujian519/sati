import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { api } from "../../utils/api";
import { cn } from "../../lib/utils.js";

/**
 * 模型上下文检查器：展示模型实际收到的 system prompt / tools / messages。
 *
 * 数据来自按需读取的 transcript sidecar（`includeModelContext=true`）。
 * 组件只在打开时请求；关闭即丢弃，不缓存到全局状态。
 */
export type ModelContextRequest = {
  sessionId: string;
  projectName?: string;
  projectPath?: string;
  sessionKind?: string;
  parentSessionId?: string;
  relativeTranscriptPath?: string;
};

type ModelContextBreakdown = {
  systemPromptChars: number;
  toolsChars: number;
  messagesChars: number;
};

type SnapshotTool = {
  name: string;
  description?: string;
  inputSchema: unknown;
};

type ModelContextSnapshot = {
  version: 1;
  turnId: string;
  capturedAt: string;
  provider: string;
  model: string;
  systemPrompt: string;
  tools: SnapshotTool[];
  messages: unknown[];
  breakdown: ModelContextBreakdown;
  mediaOmitted: boolean;
};

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; snapshot?: ModelContextSnapshot; contextStatus: "available" | "missing" | "stale" };

type Section = "system" | "tools" | "messages";

function matches(value: unknown, query: string): boolean {
  if (!query) return true;
  return JSON.stringify(value).toLowerCase().includes(query);
}

function roleOf(message: unknown): string {
  if (message && typeof message === "object" && "role" in message) {
    const role = (message as { role?: unknown }).role;
    if (typeof role === "string") return role;
  }
  return "unknown";
}

export function ContextInspector({ request, onClose }: { request: ModelContextRequest; onClose: () => void }) {
  const { t } = useTranslation("chat");
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [section, setSection] = useState<Section>("system");
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setState({ status: "loading" });
    void (async () => {
      try {
        const response = await api.sessionModelContext(request.sessionId, {
          projectName: request.projectName,
          projectPath: request.projectPath,
          sessionKind: request.sessionKind,
          parentSessionId: request.parentSessionId,
          relativeTranscriptPath: request.relativeTranscriptPath,
          mode: "true",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json();
        if (cancelled) return;
        const contextStatus = data.modelContextStatus ?? "missing";
        setState({
          status: "loaded",
          snapshot: data.modelContext,
          contextStatus: contextStatus === "available" || contextStatus === "stale" ? contextStatus : "missing",
        });
      } catch {
        // 取消或网络失败统一落到错误态：错误详情由 HTTP 响应状态覆盖。
        if (!cancelled) setState({ status: "error" });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    request.sessionId,
    request.projectName,
    request.projectPath,
    request.sessionKind,
    request.parentSessionId,
    request.relativeTranscriptPath,
  ]);

  useEffect(() => {
    searchRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const snapshot = state.status === "loaded" ? state.snapshot : undefined;
  const normalizedQuery = query.trim().toLowerCase();

  const systemText = useMemo(() => {
    if (!snapshot) return "";
    if (!normalizedQuery) return snapshot.systemPrompt;
    return snapshot.systemPrompt
      .split("\n")
      .filter(line => line.toLowerCase().includes(normalizedQuery))
      .join("\n");
  }, [snapshot, normalizedQuery]);

  const filteredTools = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.tools.filter(tool =>
      matches({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }, normalizedQuery),
    );
  }, [snapshot, normalizedQuery]);

  const filteredMessages = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.messages.filter(message => matches(message, normalizedQuery));
  }, [snapshot, normalizedQuery]);

  const sectionLabels: Record<Section, string> = {
    system: t("contextInspector.sections.system", { defaultValue: "System prompt" }),
    tools: t("contextInspector.sections.tools", { defaultValue: "Tools" }),
    messages: t("contextInspector.sections.messages", { defaultValue: "Messages" }),
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
      onClick={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("contextInspector.title", { defaultValue: "Model context" })}
        className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-xl dark:border-neutral-800 dark:bg-neutral-900"
      >
        <div className="flex items-start justify-between gap-4 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              {t("contextInspector.title", { defaultValue: "Model context" })}
            </h2>
            <p className="mt-0.5 text-[12px] text-neutral-500 dark:text-neutral-400">
              {t("contextInspector.subtitle", {
                defaultValue: "What the model actually received on the last request.",
              })}
            </p>
            {snapshot ? (
              <p className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
                {t("contextInspector.meta", {
                  provider: snapshot.provider,
                  model: snapshot.model,
                  turnId: snapshot.turnId,
                  defaultValue: "{{provider}} / {{model}} · turn {{turnId}}",
                })}
                {" · "}
                {t("contextInspector.chars", {
                  count: snapshot.breakdown.systemPromptChars + snapshot.breakdown.toolsChars,
                  defaultValue: "{{count}} chars (prompt + tools)",
                })}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("contextInspector.close", { defaultValue: "Close" })}
            className="shrink-0 rounded-md p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {state.status === "loading" ? (
          <div className="px-4 py-8 text-center text-sm text-neutral-500 dark:text-neutral-400">
            {t("contextInspector.loading", { defaultValue: "Loading context…" })}
          </div>
        ) : null}

        {state.status === "error" ? (
          <div className="px-4 py-8 text-center text-sm text-red-600 dark:text-red-300">
            {t("contextInspector.status.error", { defaultValue: "Unable to load the context snapshot." })}
          </div>
        ) : null}

        {state.status === "loaded" && (!snapshot || state.contextStatus !== "available") ? (
          <div className="px-4 py-8 text-center text-sm text-neutral-500 dark:text-neutral-400">
            {state.contextStatus === "stale"
              ? t("contextInspector.status.stale", {
                  defaultValue: "This snapshot belongs to an earlier turn. Send a message to refresh it.",
                })
              : t("contextInspector.status.missing", {
                  defaultValue: "No snapshot yet. It becomes available after the next model request.",
                })}
          </div>
        ) : null}

        {state.status === "loaded" && snapshot && state.contextStatus === "available" ? (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
              <div role="tablist" className="flex gap-1">
                {(Object.keys(sectionLabels) as Section[]).map(key => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={section === key}
                    onClick={() => setSection(key)}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-[12px] font-medium",
                      section === key
                        ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                        : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800",
                    )}
                  >
                    {sectionLabels[key]}
                  </button>
                ))}
              </div>
              <input
                ref={searchRef}
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder={t("contextInspector.searchPlaceholder", { defaultValue: "Search context…" })}
                className="ml-auto w-48 rounded-md border border-neutral-200 bg-transparent px-2 py-1 text-[12px] text-neutral-800 outline-none focus:border-neutral-400 dark:border-neutral-700 dark:text-neutral-100"
              />
            </div>

            <div className="min-h-0 flex-1 overflow-auto px-4 py-3 text-[12px] leading-5">
              {section === "system" ? (
                systemText ? (
                  <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-neutral-800 dark:text-neutral-200">
                    {systemText}
                  </pre>
                ) : (
                  <Empty text={t("contextInspector.emptySearch", { defaultValue: "No matches." })} />
                )
              ) : null}

              {section === "tools" ? (
                filteredTools.length > 0 ? (
                  <ul className="space-y-2">
                    {filteredTools.map((tool, index) => (
                      <li
                        key={`${tool.name}-${index}`}
                        className="rounded-md border border-neutral-200 p-2 dark:border-neutral-800"
                      >
                        <div className="font-mono text-[12px] font-semibold text-neutral-900 dark:text-neutral-100">
                          {tool.name}
                        </div>
                        {tool.description ? (
                          <div className="mt-1 text-neutral-600 dark:text-neutral-300">{tool.description}</div>
                        ) : null}
                        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-neutral-700 dark:text-neutral-300">
                          {JSON.stringify(tool.inputSchema, null, 2)}
                        </pre>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty
                    text={t(normalizedQuery ? "contextInspector.emptySearch" : "contextInspector.status.toolsEmpty", {
                      defaultValue: normalizedQuery ? "No matches." : "No tools were sent.",
                    })}
                  />
                )
              ) : null}

              {section === "messages" ? (
                filteredMessages.length > 0 ? (
                  <ul className="space-y-2">
                    {filteredMessages.map((message, index) => (
                      <li key={index} className="rounded-md border border-neutral-200 dark:border-neutral-800">
                        <div className="border-b border-neutral-200 px-2 py-1 font-mono text-[11px] font-semibold text-neutral-700 dark:border-neutral-800 dark:text-neutral-300">
                          {roleOf(message)}
                        </div>
                        <pre className="overflow-x-auto whitespace-pre-wrap break-words px-2 py-1 font-mono text-[11px] text-neutral-700 dark:text-neutral-300">
                          {JSON.stringify(message, null, 2)}
                        </pre>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty
                    text={t(
                      normalizedQuery ? "contextInspector.emptySearch" : "contextInspector.status.messagesEmpty",
                      { defaultValue: normalizedQuery ? "No matches." : "No messages were sent." },
                    )}
                  />
                )
              ) : null}

              {snapshot.mediaOmitted ? (
                <p className="mt-3 text-[11px] text-amber-600 dark:text-amber-300">
                  {t("contextInspector.mediaOmitted", {
                    defaultValue: "Binary media payloads are omitted from this snapshot.",
                  })}
                </p>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

function Empty({ text }: { text: string }) {
  return <div className="py-6 text-center text-neutral-500 dark:text-neutral-400">{text}</div>;
}
