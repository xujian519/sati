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
