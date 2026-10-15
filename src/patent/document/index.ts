export type {
  DocumentBrand,
  DocumentStyle,
  StylePreset,
  DocumentRenderInput,
  DocumentRenderResult,
  DocumentTemplateId,
  RenderFormat,
} from "./types.js";

export { SatiDocumentInputError } from "./errors.js";
export { renderPatentDocument } from "./renderPatentDocument.js";
export { renderPdf, findChrome } from "./pdfRenderer.js";
export { buildBrandStyle, loadBrandFromPath, mergeBrand, BRAND_KEY_TO_CSS_VAR } from "./brandInjector.js";
export { flattenDocumentStyle, buildStyleOverrides, mergeDocumentStyle, DOCUMENT_STYLE_JSON_SCHEMA } from "./style.js";
export {
  resolvePresetDirFromBrandPath,
  saveStylePreset,
  listStylePresets,
  loadStylePreset,
  deleteStylePreset,
} from "./stylePreset.js";
export { readTemplateManifest, resolveTemplate, readTemplateHtml, getTemplateRoot } from "./templateResolver.js";
export { resolveTemplateDocxPath, listDocxTemplates } from "./templateResolver.js";

// docx 申请文件渲染链路（以随模板分发的母版为版面）。
export { renderApplicationDocx, APPLICATION_DOCX_PART_IDS } from "./docx/index.js";
export type {
  ParsedRun,
  ReadyRun,
  ParsedBlock,
  ReadyBlock,
  OoxmlRenderContext,
  ImageProbe,
} from "./docx/index.js";
export { htmlToBlocks, probeImage, resolveBlocks, renderBlocks, fitImage } from "./docx/index.js";
export {
  APPLICATION_PARTS,
  parseTemplateSections,
  planSections,
  buildApplicationBodyContent,
  deriveBodyParagraphProps,
  deriveTitleStyleId,
  readContentArea,
  splitDocumentBody,
} from "./docx/index.js";
