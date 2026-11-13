/**
 * src/patent/figuregen/cad — **视图计划**（部署级 env 打底 + per-call 入参优先）。
 *
 * 用途：决定"这一次投影要出哪些视图"与"要不要自动补件号"。
 *
 * **两层形态**：视图集既是**部署级**开关（同一套工具在不同交付场景下要不同的图，
 * 用 env 承载与既有 `SATI_FREECAD_CMD`（显式路径）、`SATI_FREECAD_*` 同族），也是
 * **per-call** 语义（本次调用要哪几个视图）。批次 B-1（重录窗口）把 per-call 形态
 * 接上：工具入参 `views[]` **优先于** env，env 未设置 ⇒ 维持单视图现状。
 *
 * **与 DSH 的对应关系**：DSH 的结构线稿工具把视图集放在**工具入参**里（`views` 数组），
 * 并允许"一次请求多视图"。本仓现在两者都支持，语义一致：一次 FreeCAD 运行产出全部
 * 视图（见 `freecad.ts` 的 `projectViews`）。
 *
 * **口径**：`patent_figure_project` 的既有 `view` 入参**始终优先**——它决定主视图
 * （第一个视图，也是唯一可能被剖切的视图）；env/入参里的视图追加在其后（去重、保序）。
 */

import { CAD_VIEWS, isCadView, type CadView } from "./types.js";

/** 多视图环境变量（逗号分隔的视图名，如 `front,top,right`）。 */
export const CAD_VIEWS_ENV = "SATI_CAD_VIEWS";
/** 自动锚点环境变量（`1`/`true`/`yes`/`on` 开启）：为没有显式锚点的零件按顺序自动补件号。 */
export const CAD_AUTO_ANCHORS_ENV = "SATI_CAD_AUTO_ANCHORS";

/** 视图计划（env 解析结果）。 */
export type CadViewPlan = {
  /** 请求的视图（顺序即输出顺序；第一个是主视图）。 */
  views: readonly CadView[];
  /** 是否为没有显式锚点的零件自动补件号。 */
  autoAnchors: boolean;
  /** 视图集来源说明（供报告与诊断）。 */
  source: string;
};

/**
 * 解析视图计划（纯函数；非法配置 fail-loud，不猜）。
 *
 * - `SATI_CAD_VIEWS` 未设置或为空 ⇒ 单视图（维持现状）；
 * - 视图名非法 ⇒ 抛错（部署配置写错时必须当场报出，而不是悄悄少画一个视图）；
 * - `view` 入参（主视图）始终排在最前，env 里的同名视图被去重。
 *
 * @param override **per-call 视图集**（工具入参形态）：给出时优先于 env
 *   （env 是部署级默认值，入参是本次调用的显式选择）。override 里的非法视图名同样
 *   fail-loud；`view` 主视图依旧排在最前。
 */
export function resolveCadViewPlan(
  env: NodeJS.ProcessEnv,
  primaryView: CadView,
  override?: readonly string[],
): CadViewPlan {
  const raw = (env[CAD_VIEWS_ENV] ?? "").trim();
  const autoAnchors = parseBooleanEnv(env[CAD_AUTO_ANCHORS_ENV], CAD_AUTO_ANCHORS_ENV);
  const overrideNames = (override ?? []).map(item => item.trim()).filter(item => item.length > 0);
  const names: string[] =
    overrideNames.length > 0
      ? overrideNames
      : raw.length === 0
        ? []
        : raw
            .split(",")
            .map(item => item.trim())
            .filter(item => item.length > 0);
  const views: CadView[] = [primaryView];
  for (const name of names) {
    if (!isCadView(name)) {
      throw new TypeError(
        `${overrideNames.length > 0 ? "入参 views" : CAD_VIEWS_ENV} 含非法视图名 "${name}"` +
          `（可用: ${CAD_VIEWS.join(", ")}）——部署配置或调用入参写错时必须当场报出`,
      );
    }
    if (!views.includes(name)) views.push(name);
  }
  return {
    views,
    autoAnchors,
    source:
      names.length === 0
        ? "单视图（未设置 SATI_CAD_VIEWS）"
        : overrideNames.length > 0
          ? `入参 views=${names.join(",")}（主视图 ${primaryView} 仍优先）`
          : `${CAD_VIEWS_ENV}=${raw}（主视图 ${primaryView} 仍优先）`,
  };
}

/** 布尔型 env 解析（宽松取值、严格报错：写错的部署配置必须当场报出）。 */
export function parseBooleanEnv(raw: string | undefined, name: string): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  if (value.length === 0) return false;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new TypeError(`${name} 的取值非法："${raw}"（可用: 1/true/yes/on 与 0/false/no/off）`);
}
