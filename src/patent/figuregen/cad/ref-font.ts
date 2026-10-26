/**
 * CAD 标号字号（纸面毫米）的**单一事实源**：渲染、V7 字高判据与落版页装配共用。
 *
 * 三个法域的条文下限不同：PCT Rule 11.13(h) 与 37 CFR 1.84(p)(3) 要求数字/字母不低于
 * 0.32cm；CNIPA 无附图专有的字高条文（指南一部一章 4.3 只要求缩至三分之二仍清晰），
 * 实践中 2.0mm 已可读。CNIPA 沿用既有 3.0mm 交付口径；有法定下限的法域取 3.5mm——
 * 比 3.2mm 留 0.3mm 余量（打印/扫描取整不把字压到线下），同时与图号注记同号。
 *
 * 字号与"字高"在本仓同一口径（同 `sourceCharHeightMm` 与 V7 的比较方式），故字号即
 * 判据输入；生成期与门禁都调本函数，避免一侧按 3.0mm 判、另一侧按 3.5mm 画。
 */

import { minCharHeight, profileForJurisdiction } from "../office-profile.js";
import type { Jurisdiction } from "../types.js";

/** CNIPA 交付口径的标号字号（毫米，纸面）。 */
export const CAD_REF_FONT_MM = 3.0;
/** 有 3.2mm 法定下限的法域所用标号字号（毫米，纸面；含余量并与图号注记同号）。 */
export const CAD_REF_FONT_STATUTORY_MM = 3.5;

/**
 * 该法域的 CAD 标号字号（毫米，纸面）。
 * @param jurisdiction - 工具/案卷声明的辖区；缺省按 CNIPA。
 * @returns 法定下限高于 CNIPA 口径时取 {@link CAD_REF_FONT_STATUTORY_MM}，否则取 {@link CAD_REF_FONT_MM}。
 */
export function cadRefFontMm(jurisdiction: Jurisdiction = "cn"): number {
  const minimum = minCharHeight(profileForJurisdiction(jurisdiction))?.mm;
  return minimum !== undefined && minimum > CAD_REF_FONT_MM ? CAD_REF_FONT_STATUTORY_MM : CAD_REF_FONT_MM;
}
