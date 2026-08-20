/**
 * 文书排版参数类型 —— 与后端 src/patent/document/types.ts 的 DocumentStyle 对齐。
 * 映射到 assets/templates/patent/tokens.css 的 --sati-doc-* 变量。
 */

/** 排版参数（结构化分组）—— 优先级高于 brand / theme.json。 */
export type DocumentStyle = {
  /** 字号（CSS 长度值，如 "12pt"）。 */
  fontSize?: {
    xs?: string; // 小五 9pt：页脚/免责小注
    sm?: string; // 五号 10.5pt：表格/元数据
    base?: string; // 小四 12pt：正文
    md?: string; // H4
    lg?: string; // H3
    xl?: string; // H2
    x2l?: string; // H1
  };
  /** 行距（倍数，如 "1.5"）。 */
  leading?: { body?: string; tight?: string };
  /** 页面布局（CSS 长度/尺寸值）。 */
  page?: { margin?: string; padding?: string; bodyMaxWidth?: string };
  /** 间距（CSS 长度值）。 */
  spacing?: { sectionGap?: string; sectionGapLg?: string };
  /** 字体族（CSS font-family 值）。 */
  font?: { serif?: string; sans?: string; mono?: string };
  /** 颜色（语义 token）。 */
  color?: {
    accent?: string;
    accentStrong?: string;
    body?: string;
    muted?: string;
    border?: string;
    headerBg?: string;
    surface?: string;
    zebra?: string;
    danger?: string;
    warning?: string;
    success?: string;
  };
  /** 机构与文案（需 CSS 引号）。 */
  brand?: { firm?: string; confidential?: string; disclaimer?: string };
};

/** document_style_panel 工具返回的面板数据（经 tool_call_finished payload 透传）。 */
export type StylePanelData = {
  kind: "document_style_panel";
  htmlPath: string;
  style?: DocumentStyle;
};

/** 面板状态：打开中/关闭。 */
export type StylePanelState = {
  open: boolean;
  htmlPath: string;
  style: DocumentStyle;
};
