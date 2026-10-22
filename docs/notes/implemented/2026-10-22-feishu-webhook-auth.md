# Agent Note: 飞书 webhook 强制鉴权与 Lark REST 域名

Status: implemented

## Problem

`src/adapters/channel/feishu/FeishuChannel.ts` 的 webhook 入口此前在多种配置下接受**未鉴权**请求：

- 未配置 `verifyToken` / `encryptKey` 时，任何 POST 都会被当作合法事件（可伪造消息触发 agent）。
- 配置了 `verifyToken` 但请求缺 token 时，`if (token && token !== ...)` 直接放行。
- `url_verification` 的 token 不匹配只打日志，仍返回 challenge。
- 配置了 `encryptKey` 但收到明文请求时，既不要求加密，也不校验 `x-lark-signature`。
- token 用普通 `!==` 比较，不是常量时间。

同文件所有 REST 调用（tenant token、发消息、改消息、上传、资源下载、表情）硬编码
`https://open.feishu.cn`，`domainName: lark` 只影响 WebSocket 连接与设置页探测；Lark 租户的
出站请求会打到错误的数据中心。

## Decision

按上游 #645 的口径收紧 webhook，并让 REST base 跟随 `domainName`：

1. **必须至少配置一种密钥**：`verifyToken` 与 `encryptKey` 都为空时，所有回调返回
   `401 { error: "invalid_feishu_webhook_auth" }`（fail closed），启动时打一条 error 指明配置项。
2. **token 必填且常量时间比较**：顶层 `token` 或 `header.token`，缺失/不匹配一律 401；
   `url_verification` 不再豁免。
3. **签名覆盖原始 body**：配置 `encryptKey` 时校验
   `sha256(timestamp + nonce + encryptKey + rawBody)` 与 `x-lark-signature`；加密请求先解密再校验。
   唯一例外是「加密的首次 `url_verification`」可无签名头——此时解密成功 + token 校验已足以
   认证这次握手，普通事件仍必须带签名。
4. **REST 域名**：常量改为 path，`openApiUrl()` 按 `domainName` 选择
   `open.feishu.cn` / `open.larksuite.com`。
5. **旧配置迁移**：设置页新增 Verification Token / Encrypt Key 输入与「未配置」警告；
   `/status` 只回布尔值（不回显密钥），保存时留空保持原值、填写即轮换。

## Alternatives considered

- **只在已配置密钥时校验（兼容旧配置）** —— 未配置密钥的部署仍可被任意伪造，等于保留原缺陷；
  且 Sati 已支持 `connectionMode: webhook`，没有理由让「显式启用公网回调」的路径默认无鉴权。
  选择 fail closed，并用启动 error + 设置页警告把迁移成本显性化。
- **仅校验 `verifyToken`，不实现签名** —— 飞书事件订阅推荐 Encrypt Key；只配 Encrypt Key 的
  租户将无法使用，且 token 在明文 body 中可被重放。签名覆盖原始 body，能同时约束完整性与密钥持有。
- **在解密后对重新序列化的 JSON 计算签名** —— 序列化不保证与飞书原文逐字节一致，会误拒；
  必须使用 HTTP 原始 body（`GatewayServer.readBody` 已保留字符串）。
- **保留 `url_verification` 的 token 警告后放行** —— 该端点会回显 challenge，是握手而非数据面，
  但 token 校验失败仍说明来源不可信；统一 401 更简单，也避免把「告警」当「通过」。
- **设置页只加字段、不做启动期 error** —— 用户升级后只会看到事件静默消失；启动 error 与首次
  拒绝日志能直接指向 `verifyToken` / `encryptKey` 配置项。

## Consequences

- **换来**：无密钥的 webhook 部署不再可被伪造；token/签名均为常量时间比较；Lark 租户的出站
  请求与 WebSocket 使用同一数据中心。判据为 `tests/adapters/feishu-webhook-auth.spec.ts`
  （9 例：无密钥、token 缺失/错误/大小写、顶层与 `header.token`、challenge、明文缺签名、
  签名覆盖原始 body、加密事件、加密 challenge 例外、Lark/Feishu 域名）与
  `ui/server/routes/gateway.test.js` 的密钥保留/轮换用例。
- **负控制**：分别移除「无密钥拒绝」、允许缺 token、跳过签名、把域名硬编码回 Feishu，
  对应用例分别转红（1 / 2 / 4 / 1 条），恢复后全绿。
- **付出**：已有 webhook 部署若从未配置 `verifyToken`/`encryptKey`，升级后回调会 401，必须先在
  飞书事件订阅页取一个密钥并在设置页保存（或改 `sati.yaml`）。`stream` 模式不受影响。
- **未验证**：未用真实飞书/Lark 租户发起回调（无法在单测中访问外部服务）；签名与 AES 解密
  用本地构造的等价报文验证。若真实握手字段与文档不符，表现为 401 而非放行。
