import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { normalizeInlineCodeFences } from '../../utils/chatFormatting';

type MarkdownProps = {
  children: React.ReactNode;
  className?: string;
  projectName?: string;
  isStreaming?: boolean;
};

const streamingPlugins = [remarkGfm];
const fullRemarkPlugins = [remarkGfm, remarkMath];
const fullRehypePlugins = [rehypeKatex];

export function Markdown({ children, className, isStreaming }: MarkdownProps) {
  const content = useMemo(
    () => normalizeInlineCodeFences(String(children ?? '')),
    [children],
  );

  return (
    <div className={`${className || ''} ${isStreaming ? 'streaming-fade-in' : ''}`.trim()}>
      <ReactMarkdown
        remarkPlugins={isStreaming ? streamingPlugins : fullRemarkPlugins}
        rehypePlugins={isStreaming ? undefined : fullRehypePlugins}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
