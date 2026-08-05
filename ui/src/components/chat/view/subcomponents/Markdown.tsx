import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { Components, Options as ReactMarkdownOptions } from "react-markdown";
import remarkGfm from "remark-gfm";
import { normalizeInlineCodeFences } from "../../utils/chatFormatting";
import { resolveMarkdownFileHref } from "../../utils/resolveMarkdownFileHref";

type MarkdownProps = {
  children: React.ReactNode;
  className?: string;
  projectName?: string;
  isStreaming?: boolean;
  onFileOpen?: (filePath: string) => void;
};

type PluggableList = NonNullable<ReactMarkdownOptions["remarkPlugins"]>;

type MathPlugins = { remark: PluggableList; rehype: PluggableList };

const streamingPlugins: PluggableList = [remarkGfm];

const linkClassName = "text-brand-600 hover:underline dark:text-brand-400";

// 公式检测：内容含 `$` 即按需加载 math/katex（宽松判定避免漏渲染；
// 含 $ 的代码类消息多加载一次 chunk，远小于所有消息都携带 katex 家族 431KB 的成本）。
function contentMayContainMath(text: string): boolean {
  return text.includes("$");
}

function createMarkdownComponents(onFileOpen?: (filePath: string) => void): Components {
  return {
    a: ({ href, children, ...props }) => {
      const filePath = resolveMarkdownFileHref(href);
      if (filePath && onFileOpen) {
        return (
          <a
            href={href}
            className={`${linkClassName} cursor-pointer`}
            onClick={event => {
              event.preventDefault();
              onFileOpen(filePath);
            }}
            {...props}
          >
            {children}
          </a>
        );
      }

      const isExternal = Boolean(href && /^https?:\/\//i.test(href));
      return (
        <a
          href={href}
          className={linkClassName}
          {...(isExternal ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          {...props}
        >
          {children}
        </a>
      );
    },
  };
}

export function Markdown({ children, className, isStreaming, onFileOpen }: MarkdownProps) {
  const content = useMemo(() => normalizeInlineCodeFences(String(children ?? "")), [children]);

  const components = useMemo(() => (onFileOpen ? createMarkdownComponents(onFileOpen) : undefined), [onFileOpen]);

  // Only apply streaming-fade-in on the initial mount while streaming.
  // Once streaming ends, never re-apply it — prevents old content from
  // briefly re-animating when sibling messages cause a re-render.
  const wasStreamingRef = useRef(!!isStreaming);
  if (!isStreaming) wasStreamingRef.current = false;
  const showFadeIn = isStreaming && wasStreamingRef.current;

  // math/katex 按需加载：非流式且内容含公式标记时才动态 import
  // （remark-math + rehype-katex + katex.min.css 约 431KB + 69 字体文件，
  // 从首屏同步加载改为独立 chunk 按需注入）。
  const [mathPlugins, setMathPlugins] = useState<MathPlugins | null>(null);
  useEffect(() => {
    if (mathPlugins || isStreaming) return;
    if (!contentMayContainMath(content)) return;
    let cancelled = false;
    void Promise.all([import("remark-math"), import("rehype-katex"), import("katex/dist/katex.min.css")]).then(
      ([remarkMathMod, rehypeKatexMod]) => {
        if (cancelled) return;
        setMathPlugins({
          remark: [remarkMathMod.default as PluggableList[number]],
          rehype: [rehypeKatexMod.default as PluggableList[number]],
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [content, isStreaming, mathPlugins]);

  const remarkPlugins: PluggableList | undefined = isStreaming
    ? streamingPlugins
    : mathPlugins
      ? [remarkGfm, ...mathPlugins.remark]
      : streamingPlugins;
  const rehypePlugins: PluggableList | undefined = isStreaming ? undefined : mathPlugins?.rehype;

  return (
    <div className={`${className || ""} ${showFadeIn ? "streaming-fade-in" : ""}`.trim()}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
