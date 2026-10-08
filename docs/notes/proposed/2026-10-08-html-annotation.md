# Agent Note: HTML 标注（沙箱内脚本 + 注入桥接快照锚定）

Status: proposed

## Problem

Sati 的 HTML 交付物（`skills/html-data-report`、`skills/html-finance-report` 的 Chart.js 图表；`skills/html-patent-briefing-deck` 的脚本）目前只能在预览里查看，不能像 SVG/图片那样标注。dsh-annotator 已有 HTML 标注，但它禁脚本、全拦外部资源；直接照搬会让图表空白，主要模板失去标注价值。放开脚本则必须正面回答两件事：dsh 的否决理由「协议可被文档伪造」，以及文档可读取凭据的外泄面（后者已由 [P0 凭据修复](../implemented/2026-10-08-preview-credential-and-csp.md) 收口）。

完整方案、裁定记录与实测数据见 [`docs/html-annotation-plan.md`](../../html-annotation-plan.md)（v2，H0 已完成）。

## Proposal

采用方案 A'：**沙箱内允许脚本（不加 `allow-same-origin`）+ 注入桥接生成快照；父页不信任桥接输出**。

- **不把桥接当安全边界**（对 dsh 否决理由的正面回应）：父页对消息只做 `source`/`nonce`/类型/长度校验；锚点以**源文件解析**为准——`selector` 只有在源解析 DOM（不执行脚本）中命中同一结构位置才输出；运行时节点标记 `origin` 且不输出 selector。快照伪造至多影响定位辅助，写入侧以源文件为准。
- **渲染**：固定 1024 宽（与 dsh 一致，坐标可互通）；D5-b 固定 1024×768 视口、超出部分框内滚动。H0 #3 实测：deck 恰好一屏、poster/报告类纵向可滚动、全模板无横向溢出、`100vh` = 768。
- **前提**（D0/D1）：预览凭据收窄 + CSP 沙箱先行（P0 已落地：`scope` 预览凭据、沙箱 CSP、`connect-src 'none'`、allowlist）；标注模式沙箱进一步收紧为仅 `allow-scripts`。
- **哈希**：只接受字节级 SHA-256，取自 raw 文件端点；非安全上下文不写侧车。H0 #4 对拍：dsh `fileDigest` = Node = 浏览器 `subtle`（普通/BOM/GBK 一致）；文本转码路径会破坏一致性。
- **互通**：v2 契约增加 `selector`；dsh→Sati 的 kind 推导（按 `mediaType`）必修；发布门控默认关闭（D6）。H0 #6 证实旧版 Sati 现在会静默覆盖 `kind:"html"` 侧车（两侧 sidecar 路径同一）。
- **相对资源（登录模式）**：H0 #1 实测当前不可用。候选 A = `SameSite=None; Secure` 的路径限定 cookie（可信源上顶层与 iframe 均验证通过，`document.cookie` 仍被沙箱阻断；非可信源不可用需降级提示）；候选 B = annotate 模式服务端内联相对资源。倾向 A，H2 定案。

## Alternatives considered

- **方案 B：禁脚本静态渲染（与 dsh 一致）** — 落选。Chart.js 图表空白，主要模板无法标注；安全收益已由 P0 + 沙箱取得，不必再牺牲可用性。
- **方案 C：父页 same-origin + `allow-scripts`** — 落选。脚本可直接读父页与应用存储，突破 dsh 红线，也让 P0 的凭据收窄失去意义。
- **方案 D：`srcdoc` / `blob:` 注入** — 落选。相对资源的 base 解析失效，且凭据问题仍需单独解决。
- **父页信任桥接输出** — 落选。文档可伪造协议；改为只校验不信任，安全边界放在源解析与源文件。
- **相对资源：凭据带进子资源 URL** — 落选。扩大泄露面，与「凭据不进文档 URL」的 P0 方向相反。
- **相对资源：`Lax` / `Partitioned` cookie** — 落选。H0 #1 实测：`Lax` 已存储但沙箱（opaque origin）下不携带；`Partitioned` 同样不携带。
- **相对资源：无认证静态路由** — 落选。等于把项目文件公开给本机任何进程与网页。
- **不做发布门控（D6 取否）** — 落选。旧版 Sati 读到 `kind:"html"` 会视为未标注并在保存时覆盖（H0 #6 证实）。
- **仅修 dsh 侧（Sati 读者不改）** — 落选。必修缺口都在 Sati 读取侧：dsh 写的 HTML 被误读为 SVG 面、`selector` 不进入类型与描述、旧读者覆盖新 kind；只改 dsh 无法让 Sati 正确打开 dsh 的 HTML 侧车。
- **哈希用非 SHA-256 指纹（FNV 等）** — 落选。dsh 以字节 SHA-256 为过期判据，会误报过期（H0 #4 已对拍口径）。

## Acceptance criteria

- 三个含脚本模板在标注模式下图表正常呈现；抽样 20 个可解析元素的 selector 在源文件命中同一结构位置（H0 #2 预验：57/57）；运行时节点不输出 selector。
- dsh 写的 HTML 侧车在 Sati 显示为 HTML 面（非 SVG）、锚点保留；Sati 写的侧车 dsh 可读，丢失项与 §4.6 清单一致。
- 发布门控关闭时旧版读者行为不变；开启前完成升级顺序确认。
- 查看模式的无参数预览正文与改动前逐字节一致；`pnpm check` 通过。

## Risks

- **沙箱 cookie 语义不稳定**：仅 `None+Secure` 组合受测可用，且只在可信源（localhost/HTTPS）成立；局域网 http 需降级提示。只依赖受测组合并加回归测试。
- **默认免登录模式 CORS 全放行 + 鉴权旁路**（既有面，与标注无关）：建议独立立项。
- **通用接口仍接受 query 会话 JWT**（`files/content`/SSE）：H0 跟踪，后续逐步收窄。
- **dsh 侧三处缺口**（id 转义、selector 400 截断、`targetFingerprint` 丢弃）：Sati 读取侧自行校验兜底；是否排期修 dsh 需用户确认（D4）。
- **运行时节点无法落笔**：源解析校验兜底；界面告知，不静默回退祖先。
