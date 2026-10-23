# Agent Note: 默认绑定环回与非环回 Host 的显式信任

Status: implemented

## Problem

#625 收窄了跨站来源（`corsPolicy` + WebSocket Origin 拒止），但关闭时登记了两项存余风险
（`2026-10-15-cors-cross-origin-guard.md`）：

1. **默认免登录**：`DISABLE_LOCAL_AUTH` 仍默认 `true`，本机任意进程可无凭据访问 API。
2. **默认监听全网卡**：`ui/server/services/server-boot.js` 的 `HOST` 默认 `0.0.0.0`，而
   `localOriginGuard` 把私有地址字面量与 `os.hostname()` 视为「本机可达」——同网段主机可直连
   且无需凭据。桌面壳已显式绑 `127.0.0.1`，缺口在 CLI / `pnpm server` / `pnpm dev` 路径。

两项叠在一起，「默认配置」并不是「只对运行它的本机开放」。翻转 `DISABLE_LOCAL_AUTH` 会打断
存量免登录用户，属产品姿态变更；用绑定面与 Host 判据收窄是成本更低、可解释的安全默认。

## Decision

- **默认只绑环回**：`webui.runtime.host`（`buildDefaultSatiConfig`）、`buildRuntimeEnv` 的兜底、
  `server-boot.js` 的 `HOST` 兜底统一改为 `127.0.0.1`；Vite dev server 的默认 host 同步改为
  `127.0.0.1`。局域网访问须显式 `HOST=0.0.0.0`（或具体网卡地址）。
- **非环回 Host 须显式登记**：`localOriginGuard` 的判据从「回环 + 私有地址 + 本机主机名 +
  `SATI_TRUSTED_HOSTS`」收窄为「回环 + `SATI_TRUSTED_HOSTS`」。私有地址、`.local`、自定义域名
  不再隐式可信；`os.hostname()` 也不再是隐式逃生口。
- **HTTP 与 WebSocket 共用同一份名单**：`constants/config.js` 新增 `TRUSTED_HOSTS`，
  `index.js` 与 `websocket/chat.js` 都从它取；此前 WS 侧调 `isTrustedRequestSource` 时没传
  `trustedHosts`，白名单实际只对 HTTP 生效。
- **启动提示**：免登录且绑定非环回地址时，启动日志明确说明「非环回请求会被 403 / 拒握手」，
  并给出 `SATI_TRUSTED_HOSTS` 与 `HOST=127.0.0.1` 两条处置。不 fail-fast——显式绑定网卡的部署
  仍需能用 `SATI_TRUSTED_HOSTS` 打开访问。
- **`DISABLE_LOCAL_AUTH` 默认值保持不变**：本机进程级信任仍是「默认免登录单机」的既定姿态；
  本变更只收窄非环回来源与浏览器跨站面。

## Alternatives considered

- **翻转 `DISABLE_LOCAL_AUTH` 默认为 `false`** —— 落选：这是产品姿态变更，会静默打断所有存量
  单机用户的免登录体验；本变更用绑定面 + Host 判据达到「默认只开环回」，不动认证默认值。
- **非环回绑定直接 fail-fast** —— 落选：显式设置 `HOST=192.168.1.5` 的部署会直接起不来，
  而用户尚未有机会配置 `SATI_TRUSTED_HOSTS`；启动警告 + 请求层 403 保留可修复窗口。
- **自动信任显式 `HOST` 的值** —— 落选：`HOST` 是绑定面，不是信任面；把两者合并会让
  `HOST=0.0.0.0` 的存量配置继续隐式开放局域网。两个轴分开表达，白名单才是访问许可。
- **保留私有地址隐式信任、只改默认绑定** —— 落选：存量 `sati.yaml` 里已有 `host: 0.0.0.0`
  的用户仍会暴露；且「私有地址=本机」在办公室/咖啡馆等共享网络不成立。
- **加 per-install 本地令牌** —— 暂缓：能同时收窄本机进程面，但需要 UI 启动链路与 CLI 同步改造，
  成本明显高于绑定面收窄；留给后续按需推进。

## Consequences

- **换来**：默认 `pnpm server` / `pnpm dev` 只监听 `127.0.0.1`，同网段主机无法直连；即使显式
  `HOST=0.0.0.0`，未登记的 `Host` 也会在路由前 403 / WS 拒握手。桌面端（已 `127.0.0.1`）零感知。
- **付出**：局域网 / 反代 / 自定义域名部署须同时配置访问名：`SATI_TRUSTED_HOSTS=<ip-or-hostname>`；
  Vite dev 从局域网访问时还需 `SATI_ALLOWED_ORIGINS=http://<lan-ip>:<vite-port>`（`corsPolicy`
  的来源轴）。两轴语义见 `2026-10-15-local-api-request-origin-and-route-closure.md`。
- **存量行为变化**：`sati.yaml` 里已写 `webui.runtime.host: 0.0.0.0` 的部署，绑定不变但局域网
  请求会 403，须补 `SATI_TRUSTED_HOSTS`；这是有意的显式确认。
- **未覆盖（明示）**：本机其它进程仍可无凭据直连 `127.0.0.1`——`DISABLE_LOCAL_AUTH` 的既定
  姿态未变；Windows 的 `Host` 形态（IPv4-mapped IPv6、UNC 主机名）未实测。
