# Agent Note: 探针类路由的掩码密钥口径——统一「掩码 ⇒ 回落已存 key」

Status: implemented

## Problem

设置页读回配置时把已存的密钥**掩码化**（`MASKED_SECRET = "********"`），所以任何
「把表单原样回传服务端」的探针都会收到掩码。同一份 `ui/server/routes/config.js` 里，
三条探针对这个值的处理**已经分叉**（issue #416，复核见
`2026-09-17-ui-server-dead-surface-retirement.md` 复核 #9）：

| 探针 | 掩码处理 |
|---|---|
| `POST /models` | 掩码 ⇒ 回落到 `sati.yaml` 里该 provider 的 key，且组头时再滤一次掩码 |
| `POST /test-web-search` | 掩码 ⇒ 按**凭据作用域**判定后回落，作用域变了则 400 |
| `POST /test-connection` | **无任何判定** ⇒ `********` 直接进 `x-api-key` / `Authorization` |

后果不是「测试连接偶尔失败」，而是**唯一的用途失灵**：用户点「测试连接」看到的是
「连接失败」，而真实原因只是服务端没认出占位符——他会去重置一个本来就正确的密钥。
同一文件里三处同语义判断各写一份，第四处必然照抄错的那条。

## Decision

抽出**一个掩码判定**（`isMaskedSecret()`）与**一个 provider 探针解析入口**
（`resolveProviderProbeApiKey(providerId, requestedApiKey)`），`/models` 与
`/test-connection` 共用后者：

1. 请求里带了**真实** key（非掩码、非空）⇒ 原样使用（新输入的 key 永远优先）。
2. 掩码或空 ⇒ 回落到 `sati.yaml` 中该 provider 的 `apiKey`；已存值本身是掩码时视为无。
3. 取不到可用 key ⇒ 返回 `""`，由调用方**既有的**参数校验报错
   （`baseUrl, apiKey, and model are required`）——**掩码永不发往上游**。

`/test-web-search` 的掩码判定改走同一个谓词，但**保留自己的作用域逻辑**：它比的是
`tools.webSearch` 的 provider/endpoint/auth 作用域，与 `model.providers` 不是一个配置域，
把两者压进同一个入口会用一个函数表达两种语义（见 Alternatives）。

## Alternatives considered

- **只在 `/test-connection` 复制一份 `/models` 的回落代码** —— 落选：那正是本 issue 描述的
  漂移过程本身（「现在 `/models` 里那段是内联的，`/test-web-search` 又是另一份」），
  复制会让第四处也变成第五份。
- **三处合并成一个入口（含 web-search）** —— 落选：web-search 的判定依赖
  `webSearchCredentialScopeMatches()`（provider/endpoint/auth 三元组），模型 provider 没有
  对应概念。强行合并只能靠回调参数把作用域判定注入，收益是少一行调用、代价是一个
  「什么都做一点」的函数。
- **掩码且无已存 key 时返回 401/400 并附专用文案** —— 落选：会新增用户可见文案，
  而它要说的信息**既有校验已经在说**（缺 key）。让 `resolveProviderProbeApiKey` 返回 `""`
  复用那条文案，行为一样清楚且不引入新字符串。
- **保留「掩码原样发上游」但改进错误提示** —— 落选：那等于把上游 401 当成本地错误的提示源，
  掩码仍是发出去的密钥值；且与 `/models` 的行为继续不一致。
- **改前端不回传掩码** —— 落选：掩码回传是设置页的常规做法（`/models` 与
  `/test-web-search` 都是为它准备的），服务端识别占位符是这三条路由本就存在的契约。

## Consequences

- **行为变化**：`/test-connection` 收到掩码且该 provider 已存 key 时，现在用**已存 key**
  发请求并如实返回测试结果；掩码且无已存 key 时返回 400（此前会带掩码发出去，把
  「密钥没变」误报成「密钥不可用」）。
- **掩码的传播面收敛到零**：两条 provider 探针组头时不再需要「再滤一次掩码」，
  `effectiveApiKey` 的契约就是「要么是真实密钥，要么是空串」。
- **判据 4 例**（`ui/server/routes/config.test.js`）：掩码 ⇒ 用已存 key 发请求（断言上游收到的
  `Authorization`）、掩码且无已存 key ⇒ 400 且**未发起任何 fetch**、`/models` 与
  `/test-connection` 走同一入口、新输入的 key 优先于已存 key。
  **负控制 3 条逐条命中**：N1 掩码原样返回 → 3 例转红；N2 只回退 `/test-connection`
  （即恢复缺陷）→ 2 例转红；N3 只回退 `/models` → 1 例转红。还原后复绿。
- **未覆盖**：掩码判定仍分散在保存路径的 `containsMaskedValue()` /
  `validateMaskedWebSearchKeyReuse()` 等处（它们判定的是「配置里有没有残留掩码」，
  是另一个关注点），本次只统一「探针该用哪个 key」这一条语义。
