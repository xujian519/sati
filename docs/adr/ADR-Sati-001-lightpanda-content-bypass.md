# ADR-Sati-001: Lightpanda 仅 content 可选旁路 / 永不默认盖过 ego

**Date:** 2026-11-09  
**Status:** Accepted

## Context
Sati 浏览器级联：`ego → browseros-neo → browser-use → playwright`，外加 `web_fetch`；专利登录态/反爬/PDF 依赖 ego（及 neo）。Lightpanda 为自研无图形 headless（Zig+V8，CDP/MCP），省内存/时延，但无真 layout、截图非像素、非用户 Chrome 登录态。宿主 Lightpanda MCP ≠ 产品内置。

产品切分 **`v2026-11-09-b`** 与验收 **`AC-Lightpanda-B-2026-11-09`** 已批：可选 content 旁路；永不默认盖过 ego；Out 含登录/PDF/反爬/真截图/混会话。

## Decision
采用试点 **B**：Lightpanda 仅作 **可选 content 旁路**（cold 静态/半静态 HTML→MD/结构化 extract，或独立 tool 面）。**永不**作为默认浏览器后端盖过 `ego → browseros-neo → browser-use → playwright`。失败回落现有级联。

硬约束：
- 禁止用于 login / 反爬主路径 / 专利 PDF 下载 / 真截图（像素级）
- 禁止与 ego/neo（或其它后端）会话/cookie 混用
- 版本 pin；telemetry **默认关**（显式 opt-in）
- Win 原生不做（WSL/Docker 另议，不进本期默认可交付）

## Alternatives
- **A 全面引入**（级联前置/替换 Playwright）：否决为本期——fidelity/反爬缺口会误伤专利主路径。
- **C 暂缓**（产品零依赖）：后置；试点失败可退回 C。

## Consequences
- Positive：轻量抓取成本可控；与级联解耦；AGPL 同族；可逆。
- Negative：+1 运维面；CDP 客户端需 pin；目标站通过率须抽样。
- Neutral：宿主 MCP 与产品旁路进程/会话分离。

## How we verify（对齐 AC-Lightpanda-B-2026-11-09）
1. 需 loginState / antiBot / PDF / 真截图的任务不进入 Lightpanda。
2. 旁路失败回落级联；无会话 cookie 泄漏到 ego。
3. 抽样静态/半静态站通过率与内存/时延留证。
4. 未 Accepted 前无合并实现。（已 Accepted；实现须仍满足 1–3。）

## References
- 切分 `v2026-11-09-b` · 验收 `AC-Lightpanda-B-2026-11-09`
- https://lightpanda.io · https://github.com/lightpanda-io/browser · https://lightpanda.io/blog/posts/lightpanda-1-0 · LICENSING.md
- Sati：`src/browser/backend/`、`docs/ego-lite-integration.md`、`docs/browser-backend-poc.md`
- 落盘：`docs/adr/ADR-Sati-001-lightpanda-content-bypass.md`
