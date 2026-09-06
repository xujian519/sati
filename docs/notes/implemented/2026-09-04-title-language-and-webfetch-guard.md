# Agent Note: 会话标题语言跟随 + execute_code web_fetch 纳入开关

Status: implemented

## Problem

两项独立小修（同一 PR、两个 commit）：

1. **标题语言**：`SessionTitleGenerator` 用 EN/ZH 双 prompt 按 `hasCjk` 二分——含 CJK 汉字走中文 prompt、否则英文 prompt。日文/韩文（含汉字）输入产出中文标题，法语等其他语言输入产出英文标题，均违背用户语言。移植自 PilotDeck `desktop-v2026.09.02` #520。
2. **execute_code 绕过 web 禁令**：`tools.webSearch.enabled: false` 时 `web_search` 已从 execute_code 白名单/Python helper 移除，但 `web_fetch` 在 `EXECUTE_CODE_BASE_ALLOWED_TOOLS` 中无条件放行——脚本仍可 `sati_tools.web_fetch(...)` 联网，绕过全局禁令。移植自 PilotDeck `desktop-v2026.09.02` #518。

## Decision

1. 标题：合并为单一 prompt，语言跟随为最高优先级指令（标题语言 = 用户输入语言，不翻译；多语时跟随主要请求；产品名/代码标识符保持原样），附中英双语正例与法语反例；新增 `Fallback language` 行——显式 `systemLanguage` 选项优先（BCP-47 或英文名，`zh*` → Chinese），未传时按 `hasCjk` 推断（保持既有倾向）。`hasCjk` 角色从"prompt 选择器"降为"兜底语言推断"。`createSessionTitleGenerator` 增加 `systemLanguage` 可选项（向后兼容，默认行为同旧版兜底倾向）；上游接线（UI locale → systemLanguage）留待后续按需。

2. execute_code：`web_fetch` 与 `web_search` 同受 `webSearch` 开关控制，三处同步（该文件注释强调的"允许列表与 helper 列表不漂移"原则）：RPC 白名单（`resolveExecuteCodeAllowedTools`）、Python helper 定义（`generateSatiToolsModule` 条件拼接）、工具顶层 description 的 helper 列表。顶层 `web_fetch` 工具（独立注册）不受影响。

## Alternatives considered

- **标题：保留双 prompt，各加"跟随输入语言"指令** — 落选：两条 prompt 维护两份语义，且中文 prompt 本身就会诱导中文输出，指令与其载体语言冲突；单 prompt + 显式兜底行更可控。
- **标题：hasCjk 扩展假名/谚文识别** — 落选：兜底只需一个合理默认，语言跟随指令才是主判定；启发式扩得越大误判面越大（日文汉字本就应判中文兜底可接受）。
- **execute_code：新增独立 webFetch 开关** — 落选：现无该配置项，新增配置面收益低；`webSearch.enabled` 的语义即"禁用 agent 联网检索"，web_fetch 属同类能力。
