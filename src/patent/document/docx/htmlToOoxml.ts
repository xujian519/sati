/**
 * HTML 片段 → OOXML 块结构。
 *
 * `sections` 的既有语义是 HTML（见 `types.ts`），docx 侧沿用同一份输入：
 * 这里把常见富文本子集（标题、段落、列表、表格、加粗/斜体/下划线、换行、图片）
 * 映射为块结构，具体样式一律由模板决定（见 `ooxml.ts`）。
 *
 * 无标签的纯文本按换行拆段——LLM 常常直接给纯文本，这条捷径让两种输入都合理。
 */

import { parseFragment } from "parse5";
import type { ParsedBlock, ParsedRun, TextFormat } from "./ooxml.js";

/** parse5 节点的结构化视图（避免依赖其内部树适配器类型）。 */
type HtmlNode = {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: HtmlNode[];
};

/**
 * parse5 的树适配器类型与本地最小视图（`HtmlNode`）不共享声明，无法直接赋值。
 * 收窄**只在此处做一次**：解析入口是唯一的类型边界，之后全文按 `HtmlNode` 处理，
 * 断言不散落到各遍历点。
 */
function asHtmlNode(node: unknown): HtmlNode {
  return node as HtmlNode;
}

/** 行内内容解析的中间形态：`break` 表示此处应断开为新段落。 */
type InlinePiece = ParsedRun | { kind: "break" };

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/** 容器型块标签：自身不产生语义，只影响内部块的排布。 */
const CONTAINER_TAGS = new Set([
  "div",
  "section",
  "article",
  "main",
  "header",
  "footer",
  "figure",
  "figcaption",
  "dl",
  "dd",
  "dt",
]);

const PARAGRAPH_TAGS = new Set(["p", "blockquote", "address"]);

/** 不进入文档的标签（脚本/样式/元数据）。 */
const SKIP_TAGS = new Set(["script", "style", "head", "title", "template", "meta", "link", "noscript"]);

/** 每个列表层级的左缩进（twip）。 */
const LIST_INDENT_TWIPS = 420;

/** 输入是否含真实标签（`a < b` 这类裸小于号不算）。 */
const HAS_TAG = /<[a-zA-Z!/]/;

function attr(node: HtmlNode, name: string): string | undefined {
  return node.attrs?.find(a => a.name.toLowerCase() === name.toLowerCase())?.value;
}

function children(node: HtmlNode): HtmlNode[] {
  return node.childNodes ?? [];
}

/**
 * 归一化文本空白：折叠为单空格；**位于两个中日韩字符之间的空白直接删除**。
 * 后者是中文文档的必要处理——源 HTML 里的折行不应在汉字间留下空格。
 */
function normalizeText(input: string): string {
  const collapsed = input.replace(/\s+/g, " ");
  return collapsed.replace(
    /([\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef])\s+(?=[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef])/g,
    "$1",
  );
}

/**
 * 收集**单个**节点的行内内容。
 * 单独抽出来是必需的：`<li>` 的文本可能直接是 `#text` 子节点，而
 * 「遍历子节点」式的实现会把它整段丢掉（只留下序号）。
 */
function collectInlineNode(node: HtmlNode, format: TextFormat, out: InlinePiece[]): void {
  if (node.nodeName === "#text") {
    const text = normalizeText(node.value ?? "");
    if (text !== "") out.push({ kind: "text", text, ...format });
    return;
  }
  const tag = (node.tagName ?? "").toLowerCase();
  if (tag === "" || SKIP_TAGS.has(tag)) return;
  if (tag === "br") {
    out.push({ kind: "break" });
    return;
  }
  if (tag === "img") {
    const src = attr(node, "src");
    if (src !== undefined && src !== "") out.push({ kind: "image", src, alt: attr(node, "alt") });
    return;
  }
  if (tag === "strong" || tag === "b") {
    collectInline(node, { ...format, bold: true }, out);
    return;
  }
  if (tag === "em" || tag === "i") {
    collectInline(node, { ...format, italic: true }, out);
    return;
  }
  if (tag === "u" || tag === "ins") {
    collectInline(node, { ...format, underline: true }, out);
    return;
  }
  // a / span / code / sup / sub / mark / 未知内联：透传格式继续下钻。
  collectInline(node, format, out);
}

/** 递归收集某个元素下的行内内容。 */
function collectInline(node: HtmlNode, format: TextFormat, out: InlinePiece[]): void {
  for (const child of children(node)) collectInlineNode(child, format, out);
}

type ParagraphStyleHint = {
  role: "title" | "body";
  align: "left" | "center";
  indentLevel: number;
  marker?: string;
};

/** 把行内片段按 `break` 切段，每段落成一个段落块。 */
function piecesToParagraphs(pieces: readonly InlinePiece[], hint: ParagraphStyleHint): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  let group: ParsedRun[] = [];
  let first = true;

  const flush = (): void => {
    const runs = [...group];
    if (first && hint.marker !== undefined && hint.marker !== "") {
      runs.unshift({ kind: "text", text: hint.marker });
    }
    // 全空段落只保留第一段（原文里的空行占位），其余丢弃。
    const isEmpty = runs.every(run => run.kind === "image" || (run.kind === "text" && run.text.trim() === ""));
    if (!(isEmpty && !first)) {
      blocks.push({
        kind: "paragraph",
        runs,
        role: hint.role,
        align: hint.align,
        indentLevel: hint.indentLevel,
      });
    }
    group = [];
    first = false;
  };

  for (const piece of pieces) {
    if (piece.kind === "break") {
      flush();
      continue;
    }
    group.push(piece);
  }
  flush();
  return blocks;
}

function isEmptyGroup(blocks: readonly ParsedBlock[]): boolean {
  return blocks.length === 0;
}

/** 解析块级节点序列。 */
function walkBlocks(nodes: readonly HtmlNode[], hint: ParagraphStyleHint): ParsedBlock[] {
  const out: ParsedBlock[] = [];
  for (const node of nodes) {
    if (node.nodeName === "#text") {
      const text = normalizeText(node.value ?? "");
      if (text !== "") {
        out.push(...piecesToParagraphs([{ kind: "text", text }], hint));
      }
      continue;
    }
    const tag = (node.tagName ?? "").toLowerCase();
    if (tag === "" || SKIP_TAGS.has(tag) || tag === "hr") continue;

    if (HEADING_TAGS.has(tag)) {
      const pieces: InlinePiece[] = [];
      collectInline(node, {}, pieces);
      out.push(
        ...piecesToParagraphs(pieces, {
          ...hint,
          role: tag === "h1" ? "title" : "body",
          align: "left",
        }),
      );
      continue;
    }

    if (PARAGRAPH_TAGS.has(tag) || tag === "pre") {
      const pieces: InlinePiece[] = [];
      collectInline(node, {}, pieces);
      if (tag === "pre") {
        // pre 内的换行按段落切分（docx 单段落内不保留软换行语义）。
        for (let i = 0; i < pieces.length; i += 1) {
          const piece = pieces[i];
          if (piece?.kind === "text") pieces[i] = { ...piece, text: piece.text.replace(/ /g, " ") };
        }
      }
      out.push(...piecesToParagraphs(pieces, { ...hint, role: "body", align: "left" }));
      continue;
    }

    if (tag === "ul" || tag === "ol") {
      out.push(...listBlocks(node, tag === "ol", (hint.indentLevel ?? 0) + 1));
      continue;
    }

    if (tag === "table") {
      const table = tableBlock(node, hint);
      if (table !== undefined) out.push(table);
      continue;
    }

    if (tag === "img") {
      const src = attr(node, "src");
      if (src !== undefined && src !== "") {
        out.push({
          kind: "paragraph",
          runs: [{ kind: "image", src, alt: attr(node, "alt") }],
          role: "body",
          align: "center",
          indentLevel: 0,
        });
      }
      continue;
    }

    if (CONTAINER_TAGS.has(tag) || tag === "body" || tag === "html") {
      out.push(...walkBlocks(children(node), hint));
      continue;
    }

    // 未知块标签：透传下钻，其行内内容仍会落地。
    const nested = walkBlocks(children(node), hint);
    if (isEmptyGroup(nested)) {
      const pieces: InlinePiece[] = [];
      collectInline(node, {}, pieces);
      out.push(...piecesToParagraphs(pieces, { ...hint, role: "body", align: "left" }));
    } else {
      out.push(...nested);
    }
  }
  return out;
}

/** 列表：每个 `li` 落成一个带序号的段落，嵌套列表递归缩进。 */
function listBlocks(list: HtmlNode, ordered: boolean, indentLevel: number): ParsedBlock[] {
  const out: ParsedBlock[] = [];
  let index = 0;
  for (const item of children(list)) {
    const tag = (item.tagName ?? "").toLowerCase();
    if (tag !== "li") continue;
    index += 1;
    const marker = ordered ? `${index}. ` : "• ";
    const pieces: InlinePiece[] = [];
    const nestedLists: HtmlNode[] = [];
    for (const child of children(item)) {
      const childTag = (child.tagName ?? "").toLowerCase();
      if (childTag === "ul" || childTag === "ol") {
        nestedLists.push(child);
        continue;
      }
      // 逐节点收集（`<li>` 文本可能是裸 `#text` 子节点）。
      collectInlineNode(child, {}, pieces);
    }
    out.push(...piecesToParagraphs(pieces, { role: "body", align: "left", indentLevel, marker }));
    for (const nested of nestedLists) {
      out.push(...listBlocks(nested, (nested.tagName ?? "").toLowerCase() === "ol", indentLevel + 1));
    }
  }
  return out;
}

/** 表格：`thead` 内的行与「整行都是 `th`」的行计为表头。 */
function tableBlock(table: HtmlNode, hint: ParagraphStyleHint): ParsedBlock | undefined {
  const rows: { blocks: ParsedBlock[] }[][] = [];
  let headerRows = 0;

  const collectRows = (container: HtmlNode, isHeaderSection: boolean): void => {
    for (const row of children(container)) {
      const rowTag = (row.tagName ?? "").toLowerCase();
      if (rowTag === "thead" || rowTag === "tbody" || rowTag === "tfoot") {
        collectRows(row, rowTag === "thead");
        continue;
      }
      if (rowTag !== "tr") continue;
      const cells: { blocks: ParsedBlock[] }[] = [];
      let allHeaderCells = true;
      for (const cell of children(row)) {
        const cellTag = (cell.tagName ?? "").toLowerCase();
        if (cellTag !== "td" && cellTag !== "th") continue;
        if (cellTag !== "th") allHeaderCells = false;
        cells.push({ blocks: walkBlocks(children(cell), { ...hint, role: "body", align: "left", marker: undefined }) });
      }
      if (cells.length === 0) continue;
      if (isHeaderSection || (allHeaderCells && rows.length === headerRows)) headerRows = rows.length + 1;
      rows.push(cells);
    }
  };

  collectRows(table, false);
  if (rows.length === 0) return undefined;
  return { kind: "table", rows, headerRows };
}

/**
 * HTML 片段（或纯文本）→ 块结构。
 *
 * - 含标签：按 HTML 解析；
 * - 无标签：按 `\n` 拆段（LLM 常直接给纯文本）。
 */
export function htmlToBlocks(input: string): ParsedBlock[] {
  if (input.trim() === "") return [];
  if (!HAS_TAG.test(input)) {
    return input
      .split(/\r?\n/)
      .map(line => normalizeText(line))
      .filter(line => line !== "")
      .map<ParsedBlock>(line => ({
        kind: "paragraph",
        runs: [{ kind: "text", text: line }],
        role: "body",
        align: "left",
        indentLevel: 0,
      }));
  }

  const fragment = asHtmlNode(parseFragment(input));
  return walkBlocks(children(fragment), { role: "body", align: "left", indentLevel: 0 });
}

/** 数字列表缩进用：导出给判据复用（层级 → twip）。 */
export function listIndentTwips(level: number): number {
  return level * LIST_INDENT_TWIPS;
}
