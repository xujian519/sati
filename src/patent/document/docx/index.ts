/**
 * src/patent/document/docx — 以 `.docx` 母版产出申请文件的渲染链路。
 *
 * 母版来自 `assets/templates/patent/<template>/assets/template.docx`（随仓库分发），
 * 提供版面与样式；本目录只负责内容注入与 OpenXML 结构拼装。
 */

export type { ApplicationPart, ApplicationPartId, SectionPlan, TemplateSection } from "./applicationTemplate.js";
export { APPLICATION_PARTS } from "./applicationTemplate.js";
export {
  buildApplicationBodyContent,
  deriveBodyParagraphProps,
  deriveTitleStyleId,
  extractSectionProperties,
  extractText,
  headerRelId,
  headerTargetsByRelId,
  maxRelationshipId,
  paragraphPropertiesXml,
  parseTemplateSections,
  planSections,
  readContentArea,
  splitDocumentBody,
  toPackagePath,
  topLevelElements,
} from "./applicationTemplate.js";
export { htmlToBlocks } from "./htmlToOoxml.js";
export { decodeDataUri, probeImage, type ImageProbe } from "./imageInfo.js";
export {
  EMU_PER_PX,
  EMU_PER_TWIP,
  escapeXmlAttr,
  escapeXmlText,
  fitImage,
  renderBlocks,
  renderParagraph,
  renderTable,
  resolveBlocks,
  type Block,
  type OoxmlRenderContext,
  type Para,
  type ParsedBlock,
  type ParsedRun,
  type ReadyBlock,
  type ReadyRun,
  type Table,
  type TextFormat,
} from "./ooxml.js";
export {
  APPLICATION_DOCX_PART_IDS,
  collectImageSources,
  renderApplicationDocx,
  type RenderApplicationDocxInput,
  type RenderApplicationDocxResult,
} from "./renderApplicationDocx.js";
export {
  verifyApplicationDocx,
  verifyApplicationDocxPackage,
  type DocxPackageReference,
  type DocxVerifyFinding,
  type DocxVerifyInfo,
  type DocxVerifyResult,
  type DocxVerifySectionInfo,
  type DocxVerifyTemplateInfo,
  type VerifyApplicationDocxPackageInput,
} from "./verifyApplicationDocx.js";
