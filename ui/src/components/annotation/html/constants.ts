/**
 * HTML 标注（H2）的共享常量。
 *
 * 与 `ui/server/services/htmlAnnotationBridge.js` 的同名常量必须一致。两端不得互相 import
 * （`src/` 不能依赖 `ui/server`），各自的测试钉住取值。
 */

/** 桥接与父页之间的消息频道。 */
export const HTML_ANNOTATION_CHANNEL = "sati-html-annotation";

/** 固定渲染宽度（D2，与 dsh 的 `RENDER_WIDTH` 一致：坐标可互通）。 */
export const HTML_ANNOTATION_RENDER_WIDTH = 1024;

/** 固定渲染高度（D5-b）：1024×768 视口，超出部分框内滚动。 */
export const HTML_ANNOTATION_RENDER_HEIGHT = 768;

/** 快照元素上限（叶子优先截断；与桥接端一致，父页验证同样封顶）。 */
export const HTML_ANNOTATION_MAX_ELEMENTS = 2000;

/** selector 字符上限（与 dsh 的读取截断一致；超长不输出）。 */
export const HTML_ANNOTATION_MAX_SELECTOR_CHARS = 400;

/** 锚点 `id` 字符上限（B6 转义前）。 */
export const HTML_ANNOTATION_MAX_ANCHOR_ID_CHARS = 200;

/** 锚点 `text` 字符上限（B6 转义前）。 */
export const HTML_ANNOTATION_MAX_ANCHOR_TEXT_CHARS = 80;

/** 快照单项 bbox 的合法上界（防御伪造的离谱数值）。 */
export const HTML_ANNOTATION_MAX_BBOX_PX = 1_000_000;

/** 快照 `height` 的合法上界。 */
export const HTML_ANNOTATION_MAX_HEIGHT_PX = 10_000_000;
