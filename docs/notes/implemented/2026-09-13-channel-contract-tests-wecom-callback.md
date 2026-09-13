# Agent Note: 企微回调渠道契约测试（P3 第一卡）

Status: implemented

## Problem

P4c（三大渠道类按 `protocol/state/handlers/render` 切分）的前置是"先表征后重构"。但在这之前
`tests/adapters/` 里没有任何一个 spec 走渠道的**入站回调 → 解密 → gateway → 出站回复**闭环：
已有的 5 个 spec 分别盯附件登记、渲染、飞书权限回复、IM 权限助手与 api-server content 对象，
而 wecom(1763)/weixin(1496)/feishu(1336) 三个传输重负载渠道类的分发路径完全没有行为锚。

其中**企微回调模式**（`WeComCallbackChannel`，349 行）是三个渠道里最适合先做的：它自带真实
`node:http` 服务器、企微 AES-256-CBC 加解密与 sha1 签名校验，全部可离线驱动，不依赖扫码登录或
长轮询。

## Decision

新增 `tests/adapters/wecom-callback-contract.spec.ts`，四个用例**通过真实 HTTP 打渠道自己起的服务器**：

1. `GET` 回调 URL 验证：按企微规范现场加密 `echostr` + 计算 `msg_signature` → 200 且回写解密明文；坏签名 → 403。
2. `POST` 入站文本：签名有效 → 200 `success` → `gateway.submitTurn()` 收到 `{sessionKey, channelKey:"wecom_callback", message}` → 出站经 `message/send` 发回原会话（断言 `touser`/`agentid`/`text.content`）。
3. 坏签名 `POST`：403，且**不进入 gateway、不产生任何出站请求**（防伪造回调）。
4. 缺 `<Encrypt>`：400（协议不符，不进入解密路径）。

三处测试写法上的决定：

| 决定 | 理由 |
|---|---|
| 用同一份 `EncodingAESKey` **现场加密**构造请求，不放密文 fixture | 企微密文含 16 字节随机前缀，每次不同；现场加密才验证"解密正确"而非"回放常量" |
| 出站方向 stub `globalThis.fetch`（仅放行 `gettoken` / `message/send`，其余直接抛错） | qyapi 基址是源码常量、无法指到本地假服务器；stub fetch 是仓库既有约定（`tests/model/embedding/client.spec.ts`） |
| 测试自身打渠道的请求走启动前存下的 `realFetch` | 否则会被自己的 stub 截走（第一版就是这么红的，见 Consequences） |
| 端口在测试内探测（`net` 绑 0 取端口后关闭） | 渠道对 `port<=0` 有"回落 8780"的兜底语义，测试不能直接用 ephemeral 绑定 |

## Alternatives considered

- **直接调私有方法（`onHttp` / `dispatchInboundXml`，像 `wecom-attachments.spec.ts` 那样 `as unknown as` 取私有）** — 落选：私有方法签名不是契约，且会绕过真实 HTTP 路径（body 读取、状态码、响应体、Content-Type），而 P4c 要拆的正是这些边界。
- **改 `src` 支持 `port: 0` 并暴露实际端口，好让测试用 ephemeral 绑定** — 落选：`port > 0` 才生效是**有意的配置兜底**（避免配置写坏时静默监听随机端口）；为测试放宽这条语义不划算，探端口方案同样稳。
- **出站方向起一个本地假 HTTP 服务器** — 落选：`QYAPI` 基址在源码里是常量，没有 base-url seam；要支持得先给渠道加注入点，那是另一个关注点（可归 TD-ADAPTERS-N04 的 clientFactory seam）。
- **硬编码密文/签名的 fixture** — 落选：随机前缀使同一明文每次密文不同，回放常量只会测出"字符串相等"，且改坏加解密逻辑后可能仍绿（假绿）。
- **不 stub fetch，只断言 gateway 收到消息** — 落选：那样"出站回复"这条最容易回归的路径（字段名/agentid 类型/access_token 刷新）完全没锚。

## Consequences

- `tests/adapters/` 5 → 6 个 spec；企微回调模式的四类边界（验证、闭环、伪造、协议不符）被锁定。
- 任何改坏签名校验、AES 解密、`success` 应答时序或出站 body 形状的改动都会立刻变红——这正是 P4c 拆分 `WeComCallbackChannel` 前需要的安全网。
- 过程记录（诚实版）：第一版把测试自身的 `fetch` 与 stub 混用，4 个用例红了 3 个（`契约测试未预期的出站请求：http://127.0.0.1:<port>/...`）——stub 把测试打渠道的请求也截走了；改为测试侧一律用 `realFetch` 后 4/4 绿。这条写进注释，避免后人重踩。
- 余额：Weixin 与 Feishu 各 ≥2 个契约测试（微信侧 `pollLoop`/媒体 AES-ECB、飞书侧 webhook 事件），以及 `sendVideo` / `deliverCronResult` 的纯函数层抽取（为 P4c 铺路）。对应技术债条目 TD-ADAPTERS-N04 更新为部分完成。
