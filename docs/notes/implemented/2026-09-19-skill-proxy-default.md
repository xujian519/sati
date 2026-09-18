# Agent Note: 检索类 skill 的代理默认值改由环境变量链决定

Status: implemented

## Problem

同一个功能面（"出网要不要走代理"）在仓库里有多套独立判定，其中 `skills/google-patents-search/scripts/patent-search.py` 把默认代理**硬编码**为 `DEFAULT_PROXY = "http://127.0.0.1:9981"`，并同时作为 `PatentSearcher.__init__` 的默认值与 `--proxy` 的 argparse 默认值；`SKILL.md` 把该默认写成文档。

9981 是某个具体代理软件的混合端口，不是通用约定（Clash 常用 7890、v2rayN 10809）：换台机器即默认失败，且脚本侧没有 `src/cli/proxy.ts` 那样的 `ECONNREFUSED → 直连` 回退。9981 又是本地任意进程都能绑定的端口——被别的服务占用时请求会被静默发往非预期服务，而不是报错。

同时 `SKILL.md` 承诺了一项脚本从未实现的能力：文档写"也可通过环境变量配置 `PATENT_SEARCH_PROXY`"，但脚本只读 `PATENT_SEARCH_OUTPUT`，从不读任何代理环境变量。姊妹 skill `skills/patent-download/scripts/download_patent.py` 的 `--proxy` 默认是 `None`，两个 skill 的口径也不一致。

## Decision

**默认不再指定代理，取值改为环境变量链**（issue #448 第 ① 项，P1）。

`resolve_proxy(explicit)` 的取值顺序（`skills/google-patents-search/scripts/patent-search.py`）：

1. `--proxy <url>`（显式指定，最高优先）
2. `PATENT_SEARCH_PROXY`（本 skill 专用，把原文档承诺兑现）→ 3. `SATI_PROXY`（与 `src/cli/proxy.ts:getProxyUrl` 同一品牌变量，让 skill 与核心进程同口径）→ 4. `https_proxy` / `HTTPS_PROXY` / `http_proxy` / `HTTP_PROXY`（标准约定）
5. 链上都没有 → `None`：不向 Playwright 传 `proxy`，由 Chromium 自行决定（桌面端默认跟随系统代理设置）

`--no-proxy` 现在**先于**环境变量链生效（`None if args.no_proxy else resolve_proxy(args.proxy)`），并把语义如实写成"不指定代理（交由浏览器/系统决定）"——原先的实现只覆盖了 argparse 默认值，配上环境变量链后若不改这一行，`--no-proxy` 会被 `HTTPS_PROXY` 静默压过。

`DEFAULT_PROXY` 常量删除；`PatentSearcher.__init__` 的注解改为 `Optional[str] = None`。`SKILL.md` 的"代理配置"一节改为列出这条链并只给示例（不再声明任何默认值）。

验证（本机跑真实检索，非纯单测）：

| 场景 | 结果 |
|---|---|
| 清空所有代理环境变量 | ✅ 抓到结果（走系统代理） |
| `HTTPS_PROXY=http://127.0.0.1:1`（不可达） | ❌ `ERR_PROXY_CONNECTION_FAILED` —— 证明链真的被读 |
| 同上前提 + `--no-proxy` | ✅ 抓到结果 —— 证明 `--no-proxy` 能压过环境变量 |

`resolve_proxy` 的 8 个取值/边界用例（显式优先、各级优先序、空串与空白忽略、首尾空白裁剪）逐个核对过输出。

## Alternatives considered

- **保持 9981 硬编码，只在文档里提醒"换机器要改"** — 落选：这正是被登记为债的现状。硬编码让"换机即失败"成为默认路径，且占用一个任意进程可绑定的本地端口，失败形态是静默发往错误服务而非报错。
- **把默认值改成"探测系统代理"**（macOS 上跑 `scutil --proxy`，照 `vendor/nuo-patent` 的做法） — 落选：多一份平台相关的探测实现要维护，而 Playwright 驱动的 Chromium 本身就会读系统代理设置（本机实测：不传 `proxy` 时可达 Google Patents）。在宿主已经做这件事的地方再探测一遍，只会多出一处会漂移的口径。
- **把 `--no-proxy` 实现成真正绕过代理**（传 `--no-proxy-server` 或 `direct://`） — 落选：本机实测两条路都无效（`--no-proxy-server` 的出口 IP 仍与显式代理一致，`direct://` 直接报 `ERR_PROXY_CONNECTION_FAILED`），说明该网络是透明/隧道式代理，应用层无法绕过。承诺一个在本机不成立的语义不如如实写成"不指定代理"。
- **把代理链下沉到共享模块供各 skill 复用** — 落选（本轮）：本仓库的 skill 是自包含的 Python 脚本，跨 skill 共享需要在 `skills/` 引入公共包与安装路径约定，成本远超这一处单文件改动。这条债记在 issue #448 第 ④ 项（两份全局代理实现手工同步且已漂移）。
- **只删默认值、不加环境变量链** — 落选：`SKILL.md` 已经承诺 `PATENT_SEARCH_PROXY`，删掉默认值却不兑现文档，会把"文档说谎"从一处搬到另一处；标准 `HTTPS_PROXY` 支持也让非 9981 环境有一条零配置出路。
- **顺带处理 issue #448 的第 ②③④⑤ 项**（nuo-patent 自探测绕开全局 dispatcher、`networkFetch` 无直连回退、两份代理实现漂移、`ALL_PROXY` 口径） — 落选（本轮单独处理）：②③ 需要改模型请求与联网工具的失败路径，④ 是把两份实现合并的独立决策，都与本项（bundled skill 的默认值）不同面、不同风险。

## Consequences

- 换台机器不再默认失败：非 9981 环境要么由系统代理/隧道接住，要么通过 `PATENT_SEARCH_PROXY` / 标准 `HTTPS_PROXY` 显式指定。`SKILL.md` 里那条从未生效的 `PATENT_SEARCH_PROXY` 承诺现在是真的。
- skill 与核心进程在代理取值上**同口径**（都认 `SATI_PROXY` 与标准变量），但仍是两份实现——口径一致不等于防漂移，后续任一侧改了变量优先级仍会分叉（issue #448 第 ④⑤ 项的登记范围）。
- 代价一：`SATI_PROXY` 由"核心进程专用"变成"核心 + 该 skill 共用"。用 `SATI_PROXY` 指向本地代理的用户，该 skill 的行为从"走系统代理"变为"走 `SATI_PROXY`"——这是本改动想要的收敛方向，但它确实是一次行为变更。
- 代价二：`--proxy` 的帮助文本从"默认: http://127.0.0.1:9981"变成一条取值链描述，需要代理的用户首次使用时读文档的成本略增；`SKILL.md` 用示例补了这一点。
- 未处理：`skills/patent-download/SKILL.md` 与 `download_patent.py` 的示例文案仍以 `--proxy 9981` 举例（该脚本默认 `None`，本身没有硬编码缺陷）；这属于姊妹 skill 的示例口径，留待 issue #448 后续项一并清理。
