import { createContext } from "react";

/**
 * Markdown 原文（上游 #568）：供代码块/表格级复制读取源文本，
 * 使复制的表格 Markdown 不受渲染层改写影响。
 */
export const MarkdownSourceContext = createContext("");
