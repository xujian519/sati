/**
 * xlsx/ods 包的 XML 命名空间归一化。
 *
 * 交互预览用 ExcelJS 解析，而它按**字面前缀**取子节点：导出方自选的命名空间
 * 写法（自选前缀、默认命名空间）会让解析失败（如绘图部件的 anchors 读空）。
 * 这里把包内 XML 归一成 ExcelJS 认得的写法——SpreadsheetML 主命名空间去前缀，
 * 绘图部件统一成 `xdr:` 前缀。
 */

import fsPromises from "fs/promises";
import JSZip from "jszip";

const SPREADSHEET_MAIN_NAMESPACE = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const SPREADSHEET_DRAWING_NAMESPACE = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 把绘图部件（`xl/drawings/*.xml`）归一成规范的 `xdr:` 前缀。
 *
 * ExcelJS 解析 `<wsDr>` 时按字面前缀取子节点；导出方若用自选前缀或默认
 * 命名空间书写该部件，解析会以 "Cannot read properties of undefined
 * (reading 'anchors')" 失败。根元素已是 `xdr:` 时原样返回。
 */
function normalizeDrawingNamespace(xml) {
  const root = /<(?:(\w[\w.-]*):)?wsDr\b([^>]*)>/.exec(xml);
  if (!root) return xml;

  const prefix = root[1] || "";
  if (prefix === "xdr") return xml;

  const declaration = new RegExp(
    `\\bxmlns${prefix ? `:${escapeRegularExpression(prefix)}` : ""}\\s*=\\s*(["'])(.*?)\\1`,
    "g",
  );
  const rootDeclaration = declaration.exec(root[2]);
  if (!rootDeclaration || rootDeclaration[2] !== SPREADSHEET_DRAWING_NAMESPACE) return xml;

  // 同名声明在嵌套处指向别的命名空间时，整篇改前缀不再安全。
  declaration.lastIndex = 0;
  if ([...xml.matchAll(declaration)].some(match => match[2] !== SPREADSHEET_DRAWING_NAMESPACE)) {
    return xml;
  }
  const xdrDeclaration = /\bxmlns:xdr\s*=\s*(["'])(.*?)\1/g;
  if ([...xml.matchAll(xdrDeclaration)].some(match => match[2] !== SPREADSHEET_DRAWING_NAMESPACE)) {
    return xml;
  }

  const normalized = prefix
    ? xml.replace(new RegExp(`(<\\/?)(?:${escapeRegularExpression(prefix)}):`, "g"), "$1xdr:")
    : xml.replace(/(<\/?)([A-Za-z_][\w.-]*)(?=[\s/>])/g, "$1xdr:$2");
  if (/\bxmlns:xdr\s*=/.test(root[2])) return normalized;
  return normalized.replace("<xdr:wsDr", `<xdr:wsDr xmlns:xdr="${SPREADSHEET_DRAWING_NAMESPACE}"`);
}

export async function normalizeSpreadsheetPackage(filePath) {
  const zip = await JSZip.loadAsync(await fsPromises.readFile(filePath));
  let changed = false;

  for (const [entryName, entry] of Object.entries(zip.files)) {
    if (entry.dir || !entryName.endsWith(".xml")) continue;
    const xml = await entry.async("string");
    let normalized = /^xl\/drawings\/[^/]+\.xml$/i.test(entryName) ? normalizeDrawingNamespace(xml) : xml;
    const namespaceMatch = normalized.match(
      /xmlns:([A-Za-z_][\w.-]*)=(["'])http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main\2/,
    );
    if (namespaceMatch) {
      const prefix = escapeRegularExpression(namespaceMatch[1]);
      const quote = namespaceMatch[2];
      normalized = normalized.replace(new RegExp(`(<\\/?)(?:${prefix}):`, "g"), "$1");
      const defaultNamespace = `xmlns=${quote}${SPREADSHEET_MAIN_NAMESPACE}${quote}`;
      normalized = normalized.includes(defaultNamespace)
        ? normalized.replace(namespaceMatch[0], "")
        : normalized.replace(namespaceMatch[0], defaultNamespace);
    }

    if (normalized !== xml) {
      zip.file(entryName, normalized);
      changed = true;
    }
  }

  return changed ? zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }) : null;
}
