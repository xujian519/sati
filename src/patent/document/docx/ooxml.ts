/**
 * OOXML（WordprocessingML）片段构建：把解析后的块结构渲染为 `w:body` 内可用的 XML。
 *
 * 设计原则：**样式全部来自模板**——本模块不定义字体、字号、行距、对齐，
 * 只负责结构（段落 / run / 表格 / 内联图片）与必要的 schema 合规。
 * 正文段落属性由调用方从模板里派生后传入（见 `applicationTemplate.ts`）。
 */

/** EMU / twip（1/20 pt）换算。 */
export const EMU_PER_TWIP = 635;

/** EMU / 像素（按 96 DPI）。 */
export const EMU_PER_PX = 9525;

/** 字符级格式。 */
export type TextFormat = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
};

/** 解析后的行内元素（图片尚未接线到 package）。 */
export type ParsedRun = ({ kind: "text"; text: string } & TextFormat) | { kind: "image"; src: string; alt?: string };

/** 已接线到 package 的行内元素（图片已分配 relId / media 名 / 尺寸）。 */
export type ReadyRun =
  | ({ kind: "text"; text: string } & TextFormat)
  | {
      kind: "image";
      /** media 文件名（如 `image1.png`），用于 docPr 可读名与包内路径。 */
      mediaName: string;
      relId: string;
      docPrId: number;
      widthEmu: number;
      heightEmu: number;
      alt?: string;
    };

/** 段落：role=title 套模板标题样式，role=body 套模板正文段落属性。 */
export type Para<R> = {
  kind: "paragraph";
  runs: R[];
  role: "title" | "body";
  align: "left" | "center";
  /** 列表嵌套层级；0 = 不缩进。 */
  indentLevel: number;
};

/** 表格：单元格内可再嵌块（含表格）。 */
export type Table<R> = {
  kind: "table";
  rows: { blocks: Block<R>[] }[][];
  /** 表头行数（来自 `<thead>`），渲染为加粗。 */
  headerRows: number;
};

export type Block<R> = Para<R> | Table<R>;

export type ParsedBlock = Block<ParsedRun>;
export type ReadyBlock = Block<ReadyRun>;

/** 渲染上下文：样式来自模板，本模块只拼结构。 */
export type OoxmlRenderContext = {
  /** 模板正文段落属性（`w:pPr` 的内层 XML，可为空串）。 */
  bodyPPrXml: string;
  /** 模板标题段落样式 id（styles.xml 中 `outlineLvl=0` 的段落样式）；空串表示模板未提供。 */
  titleStyleId: string;
  /** 版面可用宽度（EMU），用于表格列宽。 */
  contentWidthEmu: number;
};

/**
 * 转义 XML 文本内容，并剔除 XML 1.0 不允许的控制字符
 * （模板/LLM 产出的文本里偶有垂直制表符等，会让整份 docx 无法打开）。
 */
export function escapeXmlText(input: string): string {
  return stripIllegalXmlChars(input).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 转义 XML 属性值（额外处理引号与制表/换行）。 */
export function escapeXmlAttr(input: string): string {
  return stripIllegalXmlChars(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/[\t\n\r]/g, " ");
}

/** 删除 XML 1.0 非法的控制字符（保留 \t \n \r）。 */
function stripIllegalXmlChars(input: string): string {
  let out = "";
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    const illegal = code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
    if (!illegal && code !== 0x7f) out += ch;
  }
  return out;
}

/** 所有 run 的解析器：把 ParsedRun 接线为 ReadyRun。 */
export type RunResolver = (run: ParsedRun) => ReadyRun;

/** 递归把解析块转成可渲染块（表格单元格内的块一并处理）。 */
export function resolveBlocks(blocks: readonly ParsedBlock[], resolveRun: RunResolver): ReadyBlock[] {
  return blocks.map(block => {
    if (block.kind === "paragraph") return { ...block, runs: block.runs.map(resolveRun) };
    return {
      kind: "table" as const,
      headerRows: block.headerRows,
      rows: block.rows.map(row => row.map(cell => ({ blocks: resolveBlocks(cell.blocks, resolveRun) }))),
    };
  });
}

/** 去掉模板正文属性里的某个元素（同名元素不得在同一 `w:pPr` 内重复出现）。 */
function stripElement(pPrXml: string, element: string): string {
  return pPrXml.replace(new RegExp(`<w:${element}\\b[^>]*/>`, "g"), "");
}

/**
 * 在 `w:pPr` 里就位地放入 `w:ind` / `w:jc`。
 *
 * CT_PPr 是**有序**序列（… spacing, ind, …, jc, …, textAlignment, …, rPr, sectPr），
 * 直接追加到末尾会落在 `w:rPr` 之后 → schema 违规。`ind` 与 `jc` 都排在
 * `textAlignment` / `rPr` / `sectPr` 之前，故统一插到这三者中最早出现的位置。
 */
function placeParagraphProp(pPrXml: string, element: "ind" | "jc", xml: string): string {
  const withoutExisting = stripElement(pPrXml, element);
  const anchors = ["<w:textAlignment", "<w:rPr", "<w:sectPr"];
  let insertAt = withoutExisting.length;
  for (const anchor of anchors) {
    const index = withoutExisting.indexOf(anchor);
    if (index !== -1 && index < insertAt) insertAt = index;
  }
  return withoutExisting.slice(0, insertAt) + xml + withoutExisting.slice(insertAt);
}

/** 构造段落属性。 */
function buildParagraphProps(paragraph: Para<ReadyRun>, ctx: OoxmlRenderContext): string {
  if (paragraph.role === "title") {
    const parts: string[] = [];
    if (ctx.titleStyleId !== "") {
      parts.push(`<w:pStyle w:val="${escapeXmlAttr(ctx.titleStyleId)}"/>`);
    }
    // 标题样式基于模板正文样式，会继承两字符首行缩进；标题必须显式清零。
    // 无标题样式时退化为居中正文——仍不引入自定义字号字体。
    let props = `${parts.join("")}<w:ind w:firstLine="0" w:firstLineChars="0"/>`;
    if (ctx.titleStyleId === "") props += `<w:jc w:val="center"/>`;
    return props;
  }

  let props = ctx.bodyPPrXml;
  if (paragraph.indentLevel > 0) {
    props = placeParagraphProp(
      props,
      "ind",
      `<w:ind w:left="${420 * paragraph.indentLevel}" w:firstLine="0" w:firstLineChars="0"/>`,
    );
  }
  if (paragraph.align === "center") {
    // 两端对齐（模板正文为 jc=both）与居中互斥，必须覆盖继承来的对齐。
    props = placeParagraphProp(props, "jc", `<w:jc w:val="center"/>`);
  }
  return props;
}

/** 渲染一个文本 run（无格式时输出最小形态）。 */
function renderTextRun(run: Extract<ReadyRun, { kind: "text" }>): string {
  const props: string[] = [];
  if (run.bold === true) props.push("<w:b/>");
  if (run.italic === true) props.push("<w:i/>");
  if (run.underline === true) props.push('<w:u w:val="single"/>');
  const rPr = props.length > 0 ? `<w:rPr>${props.join("")}</w:rPr>` : "";
  // xml:space="preserve" 保留首尾空格（OOXML 默认会吃掉）。
  return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXmlText(run.text)}</w:t></w:r>`;
}

/** 渲染内联图片（`wp:inline`，随文本流排布）。 */
function renderImageRun(run: Extract<ReadyRun, { kind: "image" }>): string {
  const name = escapeXmlAttr(run.mediaName);
  const descr = run.alt === undefined || run.alt === "" ? "" : ` descr="${escapeXmlAttr(run.alt)}"`;
  return (
    '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
    `<wp:extent cx="${run.widthEmu}" cy="${run.heightEmu}"/>` +
    '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
    `<wp:docPr id="${run.docPrId}" name="${name}"${descr}/>` +
    "<wp:cNvGraphicFramePr><a:graphicFrameLocks " +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    `<pic:nvPicPr><pic:cNvPr id="${run.docPrId}" name="${name}"${descr}/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${escapeXmlAttr(run.relId)}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${run.widthEmu}" cy="${run.heightEmu}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
    "</pic:pic></a:graphicData></a:graphic>" +
    "</wp:inline></w:drawing></w:r>"
  );
}

/** 渲染单个段落。 */
export function renderParagraph(paragraph: Para<ReadyRun>, ctx: OoxmlRenderContext): string {
  const props = buildParagraphProps(paragraph, ctx);
  const pPr = props === "" ? "" : `<w:pPr>${props}</w:pPr>`;
  const runs = paragraph.runs.map(run => (run.kind === "text" ? renderTextRun(run) : renderImageRun(run))).join("");
  return `<w:p>${pPr}${runs}</w:p>`;
}

/** 表格边框（模板默认表格样式「Normal Table」无边框，专利文书表格需要可见线框）。 */
const TABLE_BORDERS = `<w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"]
  .map(side => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`)
  .join("")}</w:tblBorders>`;

const CELL_BORDERS = `<w:tcBorders>${["top", "left", "bottom", "right"]
  .map(side => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`)
  .join("")}</w:tcBorders>`;

/** 把 EMU 宽换算为 twip（表格列宽单位）。 */
function toTwips(emu: number): number {
  return Math.max(1, Math.round(emu / EMU_PER_TWIP));
}

/** 递归把块内所有文本 run 标为加粗（用于表头行）。 */
function asBold(block: ReadyBlock): ReadyBlock {
  if (block.kind === "table") {
    return {
      kind: "table",
      headerRows: block.headerRows,
      rows: block.rows.map(row => row.map(cell => ({ blocks: cell.blocks.map(asBold) }))),
    };
  }
  return { ...block, runs: block.runs.map(run => (run.kind === "text" ? { ...run, bold: true } : run)) };
}

/** 渲染单元格；`w:tc` 必须以 `w:p` 结尾，故表格结尾需补一个空段落。 */
function renderCell(blocks: readonly ReadyBlock[], ctx: OoxmlRenderContext, columnWidthEmu: number): string {
  let inner = renderBlocks(blocks, ctx);
  if (inner === "" || inner.endsWith("</w:tbl>")) inner += "<w:p/>";
  return `<w:tc><w:tcPr><w:tcW w:w="${toTwips(columnWidthEmu)}" w:type="dxa"/>${CELL_BORDERS}</w:tcPr>${inner}</w:tc>`;
}

/** 渲染表格；`headerRows` 内的段落整体加粗。 */
export function renderTable(table: Table<ReadyRun>, ctx: OoxmlRenderContext): string {
  const columnCount = table.rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (columnCount === 0) return "";
  const columnWidthEmu = Math.floor(ctx.contentWidthEmu / columnCount);
  const grid = `<w:tblGrid>${Array.from(
    { length: columnCount },
    () => `<w:gridCol w:w="${toTwips(columnWidthEmu)}"/>`,
  ).join("")}</w:tblGrid>`;
  const rows = table.rows
    .map((row, rowIndex) => {
      const isHeader = rowIndex < table.headerRows;
      const cells = row
        .map(cell => renderCell(isHeader ? cell.blocks.map(asBold) : cell.blocks, ctx, columnWidthEmu))
        .join("");
      return `<w:tr>${cells}</w:tr>`;
    })
    .join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${TABLE_BORDERS}</w:tblPr>${grid}${rows}</w:tbl>`;
}

/**
 * 渲染块序列为 `w:body`（或 `w:tc`）内可用的 XML。
 * 结尾若落在表格上，补一个空段落——OOXML 不允许 `w:tbl` 是容器的最后一个元素。
 */
export function renderBlocks(blocks: readonly ReadyBlock[], ctx: OoxmlRenderContext): string {
  let xml = blocks
    .map(block => (block.kind === "table" ? renderTable(block, ctx) : renderParagraph(block, ctx)))
    .join("");
  if (xml.endsWith("</w:tbl>")) xml += "<w:p/>";
  return xml;
}

/**
 * 按可用版面等比缩放图片（只缩不放）。
 * 返回 EMU 尺寸；宽高至少各 1 EMU，避免出现零尺寸的非法 `<wp:extent>`。
 */
export function fitImage(
  widthPx: number,
  heightPx: number,
  maxWidthEmu: number,
  maxHeightEmu: number,
): { widthEmu: number; heightEmu: number } {
  const scale = Math.min(1, maxWidthEmu / (widthPx * EMU_PER_PX), maxHeightEmu / (heightPx * EMU_PER_PX));
  return {
    widthEmu: Math.max(1, Math.round(widthPx * EMU_PER_PX * scale)),
    heightEmu: Math.max(1, Math.round(heightPx * EMU_PER_PX * scale)),
  };
}
