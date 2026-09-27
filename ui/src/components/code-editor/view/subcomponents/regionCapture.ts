/**
 * 区域选区截图的 html2canvas 选项。
 *
 * 单独成模块（而不是挂在组件文件里）：`react-refresh/only-export-components` 不允许组件文件
 * 导出非组件值；而这份选项需要被单测直接锁住。
 */

/** 截图选项。 */
export function regionCaptureOptions(devicePixelRatio: number) {
  return {
    backgroundColor: "#ffffff",
    logging: false,
    useCORS: true,
    scale: Math.min(2, Math.max(1, devicePixelRatio || 1)),
    /**
     * 让**浏览器**渲染克隆树（SVG foreignObject），而不是 html2canvas 自带的逐样式渲染器。
     *
     * 后者不认识 Tailwind CSS 4 输出的 `oklch()`：截图目标会继承祖先的 `color`（oklch），
     * 克隆树一解析颜色就抛 `unsupported color function "oklch"`，于是**任何在应用界面里的
     * 元素**都截不出来——四条区域引用通路（栅格图 / PDF / 表格 / 附图）同时失效（#576）。
     * 该模式下库还会一并打开 `inlineImages` 与 `copyStyles`。
     */
    foreignObjectRendering: true,
  };
}
