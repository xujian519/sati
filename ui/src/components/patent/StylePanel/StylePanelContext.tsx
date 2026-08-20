/* eslint-disable react-refresh/only-export-components -- context + hook 捆绑导出 */
/**
 * StylePanel 全局状态：抽屉开关 + 当前文书路径 + 排版参数。
 * 由 StylePanelHost 订阅 tool_call_finished 的 payload（document_style_panel）
 * 自动打开；组件经 useStylePanel 读写。
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { DocumentStyle, StylePanelState } from "./types";

type StylePanelContextValue = {
  /** 当前面板状态（open=false 时其余字段为占位）。 */
  state: StylePanelState;
  openPanel: (htmlPath: string, style?: DocumentStyle) => void;
  closePanel: () => void;
  /** 更新排版参数（预览实时联动）。 */
  updateStyle: (style: DocumentStyle) => void;
  /** 重置为初始参数。 */
  resetStyle: () => void;
};

const EMPTY_STATE: StylePanelState = { open: false, htmlPath: "", style: {} };

const StylePanelContext = createContext<StylePanelContextValue | null>(null);

export function StylePanelProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StylePanelState>(EMPTY_STATE);
  const [initialStyle, setInitialStyle] = useState<DocumentStyle>({});

  const openPanel = useCallback((htmlPath: string, style?: DocumentStyle) => {
    const initial = style ?? {};
    setInitialStyle(initial);
    setState({ open: true, htmlPath, style: initial });
  }, []);

  const closePanel = useCallback(() => {
    setState(prev => (prev.open ? EMPTY_STATE : prev));
  }, []);

  const updateStyle = useCallback((style: DocumentStyle) => {
    setState(prev => (prev.open ? { ...prev, style } : prev));
  }, []);

  const resetStyle = useCallback(() => {
    setState(prev => (prev.open ? { ...prev, style: initialStyle } : prev));
  }, [initialStyle]);

  const value = useMemo(
    () => ({ state, openPanel, closePanel, updateStyle, resetStyle }),
    [state, openPanel, closePanel, updateStyle, resetStyle],
  );

  return <StylePanelContext.Provider value={value}>{children}</StylePanelContext.Provider>;
}

export function useStylePanel(): StylePanelContextValue {
  const context = useContext(StylePanelContext);
  if (context === null) {
    throw new Error("useStylePanel must be used within a StylePanelProvider");
  }
  return context;
}
