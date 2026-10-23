# Agent Note: HTML 标注发布门控开启（默认写入 enabled）

Status: implemented

## Problem

[HTML 标注](./2026-10-08-html-annotation.md)的侧车写入受 D6 发布门控保护：`VITE_ENABLE_HTML_ANNOTATION` 未开启时 `saveAnnotation` 拒绝写 `kind:"html"`。门控默认关闭是为了防止旧版 Sati（< H1 契约层）把未知 kind 视为「从未标注」并在保存时静默覆盖。代价是：门控长期关闭会让 HTML 标注对用户不可用——可以打开、可以画，但保存必然失败（[#624](https://github.com/xujian519/sati/issues/624)）。

## Decision

自 2026-10-23 起门控**默认开启**，保留显式关闭开关：`VITE_ENABLE_HTML_ANNOTATION=false`（或 `0`）时拒绝写 `kind:"html"`；其余取值（含未设置）允许写入。

开启前核对的前置条件：

- **工作区读者**：本机在用的 Sati 桌面端为 v0.3.7（≥ v0.3.6，含 H1 契约层，可识别 `kind:"html"`）；`/Users/xujian/projects` 下无既有 `*.html.annot.json`，没有历史侧车暴露在旧读者面前。
- **dsh 互通**：dsh 读取 Sati v2 HTML 侧车时保留标注、按 `mediaType` 往返（H0 #5 实测）；[dsh-annotator#5](https://github.com/xujian519/dsh-annotator/issues/5) 的三处缺口（id 转义、selector 400 截断、`targetFingerprint` 丢弃）影响往返保真度，不会把侧车读成「从未标注」。
- **默认开启而非常量开启**：保留 opt-out，供仍有多版本 Sati 共存的环境关闭写入。

实现落点是 `ui/src/constants/config.ts` 的 `isHtmlAnnotationKindWriteEnabled()`（单一判定点）。`saveAnnotation` 的强制拦截逻辑不变。

## Alternatives considered

- **保持默认关闭，把 `VITE_ENABLE_HTML_ANNOTATION=true` 写进各构建入口** — 落选。UI 至少有四条构建/运行路径（`vite` dev、`ui` 的 build 脚本、`apps/desktop/scripts/release.sh`、`build-win.bat`），逐处设置漏掉一条就会让功能在该发行形态下静默不可用，正是本议题要消除的风险。
- **写进根 `.env`** — 落选。`.env` 被 `.gitignore` 忽略且不入库，新克隆与 CI 打包都会回到关闭状态。
- **移除门控（恒为 true）** — 落选。旧版 Sati 的静默覆盖缺陷仍存在，保留显式关闭开关成本极低。
- **把默认值注入 `vite.config.js` 的 `define`** — 落选。静态替换会让测试里的 `vi.stubEnv` 失效，也把判定逻辑拆成两处。

## Consequences

- HTML 标注可正常保存；`target.kind:"html"`、`anchor.selector` 与既有验收链路一致。
- 多版本共存环境若误开，旧版 Sati（< v0.3.6）仍会静默覆盖侧车——需要时显式设 `VITE_ENABLE_HTML_ANNOTATION=false`。
- dsh 往返的三处保真度缺口仍在 dsh-annotator#5 跟踪；Sati 读取侧继续兜底。
