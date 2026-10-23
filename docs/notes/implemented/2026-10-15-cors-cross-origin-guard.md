# Agent Note: ui/server 跨站来源收窄（CORS + WebSocket Origin 拒止）

Status: implemented

> 后续变更（2026-10-23）：默认绑定改为 `127.0.0.1`，非环回 Host 须显式登记，见
> `2026-10-23-loopback-default-and-explicit-lan-trust.md`。

关联 Issue: #625

## Problem

默认「免登录单机模式」（`DISABLE_LOCAL_AUTH` 默认 `true`）下，`ui/server/index.js` 曾无条件
`app.use(cors({ exposedHeaders: ["X-Refreshed-Token"] }))`——`cors()` 缺省即 `Access-Control-Allow-Origin: *`。
于是**同机浏览器里任意第三方网页**（用户边写代码边浏览的恶意站点）都能带着自己的 Origin 跨域读取本机
API（项目文件、会话、配置、令牌……），无需任何凭据。

更深一层面：**WebSocket 握手不受浏览器 CORS 约束**——任意网页可直接 `new WebSocket("ws://127.0.0.1:PORT/ws?...")`
建连并收发消息，CORS 头对它完全无效，必须在服务端握手校验处拒止。

服务默认绑定 `0.0.0.0`，但桌面壳以 `http://127.0.0.1:PORT` 同源加载渲染层，攻击面主要是「同机其它网页」。

## Decision

把「来源是否可信」收敛为一个**纯判定** `isTrustedOrigin(origin, host, allowlist)`，由 HTTP 中间件
`corsPolicy` 与 WebSocket `verifyClient` 共用（`ui/server/middleware/corsPolicy.js`）。

可信判据（任一成立即放行）：

1. **无 `Origin`** —— 非浏览器来源（curl、本地工具、健康检查、服务器间调用）；
2. **同源** —— Origin 主机与请求 `Host` 一致（Web UI / Electron 渲染层命中 `http://127.0.0.1:PORT`）；
3. **环回主机** —— `localhost` / `127.0.0.1` / `::1`（任意端口，覆盖 Vite dev 代理等本机来源）；
4. **显式白名单** —— `SATI_ALLOWED_ORIGINS`（逗号/空格分隔，反向代理 / 容器 / 跨机部署须登记，支持 `"null"`）。

其余（含 `null`：`file://`、`data:`、沙箱 iframe；及畸形 Origin）一律拒绝。

- **HTTP 面**：`corsPolicy()` 替换 `cors()`，不可信跨站在抵达任何路由/副作用前拒绝（预检 `OPTIONS` 回 204 空体，实际请求回 403）；对「可信但跨源」请求**反射** Origin + `Allow-Credentials` + 暴露 `X-Refreshed-Token`，使白名单/环回跨机部署仍可用；`Vary: Origin` 防缓存串源。
- **WebSocket 面**：`chat.js` 的 `verifyClient` 在鉴权逻辑**之前**加 `isTrustedOrigin` 判定，不可信 Origin 直接拒握手。
- **清理死依赖**：`ui/package.json` 移除已无引用的 `cors` 包（本次修复是唯一使用者）。

## Alternatives considered

- **翻转 `DISABLE_LOCAL_AUTH` 默认为 `false`（要求登录）** —— 落选：这是**产品姿态变更**而非漏洞修复，会静默打断所有存量单机用户的「开箱即用」体验，属需产品拍板的取舍。本次只收窄**跨站**来源（同机本地进程/同源 UI 不受影响），把「默认免登录」这一残余风险显式登记：同机其它本地进程仍可访问本机 API，需登录保护应由产品另行决策。
- **完全去掉 CORS（不设任何头）** —— 落选：会把合法的非环回跨源部署（反向代理、容器网络、跨机访问）一并打断。改为「环回/同源默认放行 + 非环回须白名单 + 可信跨源反射头」，既收口攻击面又保留可部署性。
- **只修 HTTP、不碰 WebSocket** —— 落选：WebSocket 不受 CORS 约束，只修 HTTP 会留下 `new WebSocket` 直连的完整读写通道，等于没修。
- **依赖浏览器端 CORS 拦截** —— 落选：`ACAO: *` 本身就是被利用点，把安全寄托在「攻击网页不会主动发请求」上不成立（驱动用户访问恶意页面即可）。
- **按 Referer 判定** —— 落选：Referer 可被 `Referrer-Policy` 抹除、跨源被裁剪，不如 Origin 语义精确；Origin 缺失时按「非浏览器来源」放行更安全且覆盖 CLI/健康检查。

## Consequences

换来了：同机任意网页不再能跨域读取本机 API 或建立聊天 WebSocket；默认部署（桌面同源、Web 同源、
Vite dev 环回）零感知；非环回跨机部署有 `SATI_ALLOWED_ORIGINS` 显式逃生口；HTTP 与 WS 共用同一判定，
不会漂移。

付出了/残余：`DISABLE_LOCAL_AUTH` 仍默认 `true`——**同机其它本地进程**（本机任意程序）仍可无凭据访问，
这是「默认免登录单机」的既定产品姿态，非本 PR 收窄范围，若需对本地进程也设门槛须产品决策；
`SATI_ALLOWED_ORIGINS` 未登记时，用非环回主机名（如 `http://sati.lan`）直接访问 Web UI 会被拒，
需在部署环境显式声明来源（已在 config.js 注释与本 note 说明）。
