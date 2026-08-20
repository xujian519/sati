/**
 * 排版参数表单：六组（字号/行距/页面/间距/字体/颜色/落款）→ DocumentStyle。
 * 每个控件变更即时回调 onChange，宿主据此重渲染 iframe 预览。
 */

import { useTranslation } from "react-i18next";
import type { DocumentStyle } from "./types";

type StylePanelFormProps = {
  style: DocumentStyle;
  onChange: (style: DocumentStyle) => void;
};

const FONT_SIZE_OPTIONS = ["9pt", "10.5pt", "12pt", "14pt", "16pt", "18pt", "20pt"];

/** 字号字段（子键 → i18n key），与 COLOR_FIELDS 同为数据驱动渲染。 */
const FONT_SIZE_FIELDS: Array<[keyof NonNullable<DocumentStyle["fontSize"]>, string]> = [
  ["xs", "fontSize.xs"],
  ["sm", "fontSize.sm"],
  ["base", "fontSize.base"],
  ["md", "fontSize.md"],
  ["lg", "fontSize.lg"],
  ["xl", "fontSize.xl"],
  ["x2l", "fontSize.x2l"],
];

const COLOR_FIELDS: Array<[keyof NonNullable<DocumentStyle["color"]>, string]> = [
  ["accent", "color.accent"],
  ["accentStrong", "color.accentStrong"],
  ["body", "color.body"],
  ["muted", "color.muted"],
  ["border", "color.border"],
  ["headerBg", "color.headerBg"],
  ["surface", "color.surface"],
  ["zebra", "color.zebra"],
  ["danger", "color.danger"],
  ["warning", "color.warning"],
  ["success", "color.success"],
];

function updateGroup<T extends object>(
  style: DocumentStyle,
  group: keyof DocumentStyle,
  patch: Partial<T>,
): DocumentStyle {
  const current = (style[group] as T | undefined) ?? ({} as T);
  return { ...style, [group]: { ...current, ...patch } };
}

export default function StylePanelForm({ style, onChange }: StylePanelFormProps) {
  const { t } = useTranslation("stylePanel");

  const fontSize = style.fontSize ?? {};
  const leading = style.leading ?? {};
  const page = style.page ?? {};
  const spacing = style.spacing ?? {};
  const font = style.font ?? {};
  const color = style.color ?? {};
  const brand = style.brand ?? {};

  const labelClass = "text-[11px] font-medium text-neutral-500 dark:text-neutral-400";
  const inputClass =
    "h-7 w-full rounded-md border border-neutral-200 bg-white px-2 text-[12px] text-neutral-800 outline-none focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-neutral-500";

  const renderTextRow = (key: string, value: string | undefined, placeholder: string, onValue: (v: string) => void) => (
    <label key={key} className="flex min-w-0 flex-col gap-0.5">
      <span className={labelClass}>{t(key)}</span>
      <input
        className={inputClass}
        value={value ?? ""}
        placeholder={placeholder}
        onChange={e => onValue(e.target.value)}
      />
    </label>
  );

  const renderSelectRow = (
    key: string,
    value: string | undefined,
    placeholder: string,
    onValue: (v: string) => void,
  ) => (
    <label key={key} className="flex min-w-0 flex-col gap-0.5">
      <span className={labelClass}>{t(key)}</span>
      <select className={inputClass} value={value ?? ""} onChange={e => onValue(e.target.value)}>
        <option value="">{placeholder}</option>
        {FONT_SIZE_OPTIONS.map(option => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="flex flex-col gap-4 p-4 text-[12px]">
      {/* 字号 */}
      <section className="flex flex-col gap-1.5">
        <h3 className="text-[12px] font-semibold text-neutral-800 dark:text-neutral-100">{t("group.fontSize")}</h3>
        <div className="grid grid-cols-2 gap-2">
          {FONT_SIZE_FIELDS.map(([key, i18nKey]) =>
            renderSelectRow(i18nKey, fontSize[key], t("placeholder.default"), v =>
              onChange(updateGroup(style, "fontSize", { [key]: v })),
            ),
          )}
        </div>
      </section>

      {/* 行距 */}
      <section className="flex flex-col gap-1.5">
        <h3 className="text-[12px] font-semibold text-neutral-800 dark:text-neutral-100">{t("group.leading")}</h3>
        <div className="grid grid-cols-2 gap-2">
          {renderTextRow("leading.body", leading.body, "1.5", v =>
            onChange(updateGroup(style, "leading", { body: v })),
          )}
          {renderTextRow("leading.tight", leading.tight, "1.3", v =>
            onChange(updateGroup(style, "leading", { tight: v })),
          )}
        </div>
      </section>

      {/* 页面 */}
      <section className="flex flex-col gap-1.5">
        <h3 className="text-[12px] font-semibold text-neutral-800 dark:text-neutral-100">{t("group.page")}</h3>
        <div className="grid grid-cols-1 gap-2">
          {renderTextRow("page.margin", page.margin, "20mm 25mm 20mm 25mm", v =>
            onChange(updateGroup(style, "page", { margin: v })),
          )}
          {renderTextRow("page.padding", page.padding, "0 25mm", v =>
            onChange(updateGroup(style, "page", { padding: v })),
          )}
          {renderTextRow("page.bodyMaxWidth", page.bodyMaxWidth, "160mm", v =>
            onChange(updateGroup(style, "page", { bodyMaxWidth: v })),
          )}
        </div>
      </section>

      {/* 间距 */}
      <section className="flex flex-col gap-1.5">
        <h3 className="text-[12px] font-semibold text-neutral-800 dark:text-neutral-100">{t("group.spacing")}</h3>
        <div className="grid grid-cols-2 gap-2">
          {renderTextRow("spacing.sectionGap", spacing.sectionGap, "5mm", v =>
            onChange(updateGroup(style, "spacing", { sectionGap: v })),
          )}
          {renderTextRow("spacing.sectionGapLg", spacing.sectionGapLg, "6mm", v =>
            onChange(updateGroup(style, "spacing", { sectionGapLg: v })),
          )}
        </div>
      </section>

      {/* 字体 */}
      <section className="flex flex-col gap-1.5">
        <h3 className="text-[12px] font-semibold text-neutral-800 dark:text-neutral-100">{t("group.font")}</h3>
        <div className="grid grid-cols-1 gap-2">
          {renderTextRow("font.serif", font.serif, '"FangSong", "仿宋", serif', v =>
            onChange(updateGroup(style, "font", { serif: v })),
          )}
          {renderTextRow("font.sans", font.sans, '"Noto Sans CJK SC", "Heiti SC", sans-serif', v =>
            onChange(updateGroup(style, "font", { sans: v })),
          )}
          {renderTextRow("font.mono", font.mono, '"SF Mono", Consolas, monospace', v =>
            onChange(updateGroup(style, "font", { mono: v })),
          )}
        </div>
      </section>

      {/* 颜色 */}
      <section className="flex flex-col gap-1.5">
        <h3 className="text-[12px] font-semibold text-neutral-800 dark:text-neutral-100">{t("group.color")}</h3>
        <div className="grid grid-cols-2 gap-2">
          {COLOR_FIELDS.map(([key, i18nKey]) => (
            <label key={key} className="flex min-w-0 items-center gap-2">
              <input
                type="color"
                className="h-6 w-8 shrink-0 cursor-pointer rounded border border-neutral-200 bg-transparent p-0 dark:border-neutral-700"
                value={isValidHexColor(color[key]) ? (color[key] as string) : "#000000"}
                onChange={e => onChange(updateGroup(style, "color", { [key]: e.target.value }))}
              />
              <span className="truncate text-[11px] text-neutral-500 dark:text-neutral-400">{t(i18nKey)}</span>
            </label>
          ))}
        </div>
      </section>

      {/* 落款 */}
      <section className="flex flex-col gap-1.5">
        <h3 className="text-[12px] font-semibold text-neutral-800 dark:text-neutral-100">{t("group.brand")}</h3>
        <div className="flex flex-col gap-2">
          {renderTextRow("brand.firm", brand.firm, t("placeholder.firm"), v =>
            onChange(updateGroup(style, "brand", { firm: v })),
          )}
          {renderTextRow("brand.confidential", brand.confidential, t("placeholder.confidential"), v =>
            onChange(updateGroup(style, "brand", { confidential: v })),
          )}
          <label className="flex min-w-0 flex-col gap-0.5">
            <span className={labelClass}>{t("brand.disclaimer")}</span>
            <textarea
              className="min-h-[56px] w-full resize-y rounded-md border border-neutral-200 bg-white px-2 py-1 text-[12px] text-neutral-800 outline-none focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-neutral-500"
              value={brand.disclaimer ?? ""}
              placeholder={t("placeholder.disclaimer")}
              onChange={e => onChange(updateGroup(style, "brand", { disclaimer: e.target.value }))}
            />
          </label>
        </div>
      </section>
    </div>
  );
}

function isValidHexColor(value: string | undefined): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}
