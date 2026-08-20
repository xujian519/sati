/**
 * src/patent/document — 专利律师交付物 HTML/PDF 渲染管线类型。
 */

/** 受 manifest.json 支持的模板 id。 */
export type DocumentTemplateId =
  | "patentability-opinion"
  | "search-report"
  | "oa-response"
  | "claims-spec"
  | "invalidation-opinion";

/** 渲染输出格式。 */
export type RenderFormat = "html" | "pdf" | "both";

/** 品牌覆盖：键名对应 assets/templates/patent/tokens.css 中的 --sati-doc-* 变量。 */
export type DocumentBrand = Partial<Record<string, string>>;

/**
 * 排版参数（结构化分组）—— 映射到 tokens.css 的 --sati-doc-* 变量。
 * 供「生成后实时调整」与「事务所样式预设持久化」使用；优先级高于 brand / theme.json。
 */
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

/** 样式预设：可复用的排版参数 + 元数据，持久化于 products/<产品>/brand/style-presets/<name>.json。 */
export type StylePreset = {
  /** 预设名（作为文件名，需通过安全名校验）。 */
  name: string;
  /** 可读说明。 */
  description?: string;
  /** 最后更新时间（ISO 字符串）。 */
  updatedAt?: string;
  /** 排版参数。 */
  style: DocumentStyle;
};

/** 渲染请求输入。 */
export type DocumentRenderInput = {
  /** 模板 id（需存在于 assets/templates/patent/manifest.json）。 */
  template: DocumentTemplateId;
  /** 输出文件名主干（不含扩展名）。 */
  outputName: string;
  /** 案卷 id；提供时结果落盘 data/cases/<caseId>/outputs/。 */
  caseId?: string;
  /** 显式输出目录（覆盖默认目录）。 */
  outputDir?: string;
  /** 输出格式：html / pdf / both（默认 both）。 */
  format?: RenderFormat;
  /** 按元素 id 注入的 HTML 内容（innerHTML）。 */
  sections: Record<string, string>;
  /** 内联品牌覆盖（优先级高于 brandPath / 默认 theme.json）。 */
  brand?: DocumentBrand;
  /** 指向 theme.json 的显式路径；缺省时尝试 products/_example/brand/theme.json。 */
  brandPath?: string;
  /** 排版参数覆盖（结构化；优先级高于 brand / theme.json）。 */
  style?: DocumentStyle;
  /** 样式预设名（加载 products/<产品>/brand/style-presets/<name>.json；显式 style 覆盖预设）。 */
  stylePreset?: string;
};

/** 渲染结果。 */
export type DocumentRenderResult = {
  /** 生成的 HTML 文件绝对路径。 */
  htmlPath: string;
  /** 生成的 PDF 文件绝对路径（format=html 时不生成）。 */
  pdfPath?: string;
  /** PDF 生成失败原因（HTML 已生成时的降级提示）。 */
  pdfError?: string;
  /** 非致命告警（未命中的 section id、品牌配置缺失等）。 */
  warnings?: string[];
};
