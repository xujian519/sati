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
