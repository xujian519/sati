/**
 * 模板解析：定位 assets/templates/patent/<template>/assets/template.html。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SatiDocumentInputError } from "./errors.js";
import type { DocumentTemplateId } from "./types.js";

/** 模板系统根目录（随仓库分发）。 */
export function getTemplateRoot(): string {
  // 在 dist/ 运行时，本文件位于 dist/src/patent/document/；
  // 开发时位于 src/patent/document/。assets/templates/patent 与 src 同级。
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "..", "assets", "templates", "patent"),
    join(here, "..", "..", "..", "..", "assets", "templates", "patent"),
  ];
  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (existsSync(join(resolved, "manifest.json"))) return resolved;
  }
  return resolve(candidates[0] ?? "");
}

/** manifest.json 结构。 */
type TemplateManifest = {
  templates?: string[];
  renders?: { default?: string; supported?: string[] };
  page?: { size?: string; margins?: Record<string, string> };
};

let manifestCache: TemplateManifest | undefined;
let manifestCachePath: string | undefined;

export function readTemplateManifest(): TemplateManifest {
  const root = getTemplateRoot();
  const path = join(root, "manifest.json");
  if (manifestCache !== undefined && manifestCachePath === path) return manifestCache;
  const raw = readFileSync(path, "utf8");
  manifestCache = JSON.parse(raw) as TemplateManifest;
  manifestCachePath = path;
  return manifestCache;
}

/** 验证并定位模板 HTML 文件。 */
export function resolveTemplate(template: DocumentTemplateId): { root: string; htmlPath: string } {
  const root = getTemplateRoot();
  const manifest = readTemplateManifest();
  const available = manifest.templates ?? [];
  if (!available.includes(template)) {
    throw new SatiDocumentInputError(`未知模板 "${template}"（可用: ${available.join(", ") || "无"}）`);
  }
  const htmlPath = join(root, template, "assets", "template.html");
  if (!existsSync(htmlPath)) {
    throw new Error(`模板 HTML 缺失: ${htmlPath}`);
  }
  return { root, htmlPath };
}

/** 读取模板原始 HTML。 */
export function readTemplateHtml(template: DocumentTemplateId): string {
  const { htmlPath } = resolveTemplate(template);
  return readFileSync(htmlPath, "utf8");
}

/**
 * 模板的 docx 母版路径（`assets/template.docx`，与 `assets/template.html` 同构）。
 * 并非每个模板都提供 docx 母版——申请文件类模板才有，此时返回 `undefined`。
 */
export function resolveTemplateDocxPath(template: DocumentTemplateId): string | undefined {
  const path = join(getTemplateRoot(), template, "assets", "template.docx");
  return existsSync(path) ? path : undefined;
}

/** 当前支持 docx 输出的模板 id（由「是否随模板分发了 docx 母版」决定，不写死清单）。 */
export function listDocxTemplates(): DocumentTemplateId[] {
  const available = readTemplateManifest().templates ?? [];
  return available.filter(
    id => resolveTemplateDocxPath(id as DocumentTemplateId) !== undefined,
  ) as DocumentTemplateId[];
}
