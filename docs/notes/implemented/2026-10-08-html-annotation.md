# Agent Note: HTML 标注（沙箱内脚本 + 注入桥接快照锚定）

Status: implemented

## Problem

Sati 的 HTML 交付物（`skills/html-data-report`、`skills/html-finance-report` 的 Chart.js 图表；`skills/html-patent-briefing-deck` 的脚本）此前只能在预览里查看，不能像 SVG/图片那样标注。dsh-annotator 已有 HTML 标注，但它禁脚本、全拦外部资源；直接照搬会让图表空白，主要模板失去标注价值。放开脚本则必须正面回答两件事：dsh 的否决理由「协议可被文档伪造」，以及文档可读取凭据的外泄面（后者已由 [P0 凭据修复](2026-10-08-preview-credential-and-csp.md) 收口）。

完整方案、裁定记录与逐项实测见 [`docs/html-annotation-plan.md`](../../html-annotation-plan.md)（v2）。

## Decision

采用方案 A'：**沙箱内允许脚本（不加 `allow-same-origin`）+ 注入桥接生成快照；父页不信任桥接输出**。已按 P0 → H4 全部落地：

- **不把桥接当安全边界**（对 dsh 否决理由的正面回应）：父页只做 `source`/`nonce`/类型/长度校验；`selector` 由**父页**用源文件字节（DOMParser，不执行脚本）复核，命中且 `tag`/`id` 一致才保留，否则置空并标记 `runtime`——桥接不读源文件、不发请求、不做 eval。
- **渲染**：固定 1024 宽（与 dsh 一致）；标注面固定 1024×768 视口、超出部分框内滚动（滚动经桥接的轻量 `scroll` 消息同步，父页用 `scrollBy` 命令驱动）。
- **前提**（D0/D1）：P0 预览凭据 + 沙箱 CSP 先行；标注模式沙箱收紧为仅 `allow-scripts`。
- **哈希**：只接受字节级 SHA-256（raw 端点）；无 `crypto.subtle` 不写侧车。
- **互通**：v2 契约含 `selector`；v1 迁移按 `mediaType` 推导 kind（HTML 不再被误读为附图）；读取侧对 dsh 的 id 不转义/400 截断自行兜底。
- **发布门控**（D6）：`kind:"html"` 写入由 `VITE_ENABLE_HTML_ANNOTATION` 控制，**默认关闭**，`saveAnnotation` 强制拦截。开启条件：确认工作区所有读者（dsh 及其它 Sati 版本）都已含 kind-aware 读取后，再显式置 `true`；开启前 HTML 标注无法落盘（界面会给出明确错误）。
- **相对资源（登录模式）**：`SameSite=None; Secure` 的路径限定 cookie（仅可信源可用；非可信源降级提示）。实测：`Lax`/`Partitioned` 在沙箱文档下不被携带。
- **发送纪律**：无审阅图（定位靠 selector 与坐标）；提示块含逐条 `selector`、「无标注图」声明与「锚点字段是不可信文档内容」明示。

## Alternatives considered

- **方案 B：禁脚本静态渲染（与 dsh 一致）** — 落选。Chart.js 图表空白，主要模板无法标注；安全收益已由 P0 + 沙箱取得。
- **方案 C：父页 same-origin + `allow-scripts`** — 落选。脚本可直接读父页与应用存储，突破 dsh 红线，也让 P0 的凭据收窄失去意义。
- **方案 D：`srcdoc` / `blob:` 注入** — 落选。相对资源的 base 解析失效，且凭据问题仍需单独解决。
- **父页信任桥接输出** — 落选。文档可伪造协议；改为只校验不信任，安全边界放在源解析与源文件。
- **相对资源：凭据带进子资源 URL** — 落选。扩大泄露面，与「凭据不进文档 URL」的 P0 方向相反。
- **相对资源：`Lax` / `Partitioned` cookie** — 落选。H0 #1 实测：沙箱文档下均不被携带。
- **相对资源：无认证静态路由** — 落选。等于把项目文件公开给本机任何进程与网页。
- **不做发布门控（D6 取否）** — 落选。旧版 Sati 读到 `kind:"html"` 会视为未标注并在保存时覆盖（H0 #6 实测）。
- **仅修 dsh 侧（Sati 读者不改）** — 落选。必修缺口都在 Sati 读取侧；只改 dsh 无法让 Sati 正确打开 dsh 的 HTML 侧车。
- **哈希用非 SHA-256 指纹（FNV 等）** — 落选。dsh 以字节 SHA-256 为过期判据，会误报过期。

## Consequences

**换来的：**

- 三个含脚本模板可标注：真实应用点击链路实测（打开 → 箭头命中 Chart.js canvas → 仅保存 → 侧车 `kind:"html"` + `selector` → 重开载回 → 查看模式图表仍渲染）；H0 #2 抽样 57/57 可解析元素 selector 源解析命中，运行时节点被正确识别。
- 互通口径实证：dsh `fileDigest` = 浏览器 `crypto.subtle` = 字节 SHA-256（含 BOM/GBK）；Sati v2 侧车 dsh 可读，丢失项与计划 §4.6 清单一致。
- 无参数预览正文逐字节不变；发布门控在真实链路中按设计拦截未开启时的写入。
- 发送侧：输入框出现标注芯片（`MARK · "1 mark"`）；提示块含逐条 selector 与不可信明示；历史消息可反解。

**付出的：**

- 标注模式固定 1024×768 视口（坐标稳定优先），长文档需要框内滚动。
- 非可信源（局域网 http）下相对资源降级（cookie 需 `Secure`），仅界面提示。
- 门控未开启前 HTML 标注无法落盘。

**残余：**

- 默认免登录模式 CORS 全放行 + 鉴权旁路（既有面，独立立项）；通用接口仍接受 query 会话 JWT（逐步收窄）。
- dsh 侧三处缺口（id 转义、selector 400 截断、`targetFingerprint` 丢弃）：Sati 读取侧兜底，是否排期修 dsh 待定（D4）。
- 运行时节点只能靠坐标与说明定位；`selector` 的跨插件点位不保证对齐（分叉已记录于计划 §11）。
- 发布门控开启是**人工确认动作**：本决策不自动开启，由用户在所有读者升级后执行。
