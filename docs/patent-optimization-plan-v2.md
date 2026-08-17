# 专利搜索与下载模块 — 优化方案 v2

> **版本说明**：v2 是对 v1 方案审阅结论的修订版。修正了 4 处任务落点问题：
> 1. **TASK-P1-02** 保留现有“输出到任意绝对路径/自定义目录”能力，不再默认限制 workspace 内；
> 2. **TASK-P2-01** 保留 `--keyword` 现有“标题/摘要关键词匹配”语义，不再静默切换全文索引；
> 3. **TASK-P2-03** 在断点续传前先统一 TS/Python 产物契约，明确续传 key；
> 4. **TASK-P2-05** 修正 pilot config 实施点（types.ts / loadPilotConfig.ts / parse*.ts），并上调工时。
>
> **审阅修订（2026-08-17）**：P2-06 降级为基号分桶（hits 无 application_number 字段）、174 基线改为实测、风险表 P0-01 预案修正、P2-05 补注入通道设计、P2-07 明确 TS 超集版为唯一事实源 + grep 门禁修正、P2-03 补 MANIFEST 加载去重、SKILL.md 行号/阈值/术语/R2 小瑕疵修正。

---

## 第一部分：任务池总览

| 优先级 | 数量 | 说明 |
|--------|------|------|
| **P0（阻断级）** | 2 | 不修复严禁进入生产环境 |
| **P1（强烈建议）** | 2 | 安全与功能闭环缺口 |
| **P2（建议）** | 7 | 功能补强 / 性能优化 / 体验提升 |
| **P3（可延期）** | 5 | 可维护性 / 长期演进 / 埋点建设 |
| **合计** | **16** | - |

---

## 第二部分：逐项任务详情（含 DoD、影响文件、工时、风险）

### 🔴 P0 阻断级（必须完成，Sprint 1 目标）

#### 【TASK-P0-01】修复 patent_search.sh SQL 注入漏洞

| 项 | 内容 |
|----|------|
| **问题描述** | 所有用户输入（KEYWORD/APPLICANT/INVENTOR/IPC/FULLTEXT/DETAIL/DATE_START/DATE_END/YEAR）直接字符串插值拼入 SQL，无转义无参数化 |
| **优化方案** | 方案 A（快）：改用 `psql -v var=value` 预定义变量 + `ILIKE '%' || :var || '%'` 拼接表达式；方案 B（彻底）：用 `pg` npm 包重写为 TS CLI，享受类型系统和参数化查询。**选方案 A**（半天可落地，后续迭代换方案 B） |
| **验收标准（DoD）** | ① 对载荷 `--keyword "x'; DROP TABLE patents; --"` 执行时 SQL 执行报错（而非静默删表）；② 对正常关键词 `"人工智能"` 返回结果与改造前完全一致（比对 SQL EXPLAIN 输出与结果条数）；③ 所有参数类型均做白名单校验：YEAR/limit 必为正整数，IPC 必匹配 `^[A-H][0-9]{2}[A-Z]?[0-9]*`，日期必匹配 `^\d{4}-\d{2}-\d{2}$`；④ 新增对应单元测试 |
| **影响文件** | 主改：[patent_search.sh](file:///Users/xujian/projects/Sati/skills/patent-search/scripts/patent_search.sh)；新增：`tests/patent/scripts/patent_search_sql_injection.spec.ts` |
| **预估工时** | 0.5 人天（方案 A）；1 人天（方案 B） |
| **风险等级** | 改造本身 🟡 中（可能引入参数引用错误导致 LIKE 匹配失效）；不改造风险 🔴 严重 |
| **关联任务** | 依赖：无；被依赖：TASK-P2-01 |

#### 【TASK-P0-02】修复下载脚本 SSL 证书校验被禁用

| 项 | 内容 |
|----|------|
| **问题描述** | [download_patent_ego.py#L176-L178](file:///Users/xujian/projects/Sati/skills/patent-download/scripts/download_patent_ego.py#L176-L178) 显式设置 `check_hostname=False` + `verify_mode=CERT_NONE`，CDN 下载完全不校验证书链 |
| **优化方案** | 删除三行 SSL 禁用代码，使用 `ssl.create_default_context()` 默认行为。若遇到证书链不完整问题，加 `capath` 指向系统 CA bundle（macOS：`/etc/ssl/cert.pem`），而非全关闭 |
| **验收标准（DoD）** | ① 代码中 `CERT_NONE` / `check_hostname = False` 字符串 grep 结果为零；② 对 CDN 真实 URL 执行一次 `urllib.request.urlopen(..., context=default_ctx)` 成功，响应 `Content-Type` 含 `application/pdf`；③ 故意传入自签证书域名能抛出 `SSLCertVerificationError`，证明校验确实生效；④ 脚本成功下载一篇真实专利 PDF 并通过魔数校验 |
| **影响文件** | [download_patent_ego.py](file:///Users/xujian/projects/Sati/skills/patent-download/scripts/download_patent_ego.py)（仅 L176-178 区域） |
| **预估工时** | ≤ 1 小时 |
| **风险等级** | 本身 🟢 低（Google CDN 证书链完整）；不改造风险 🔴 高危 |

---

### 🟡 P1 强烈建议（Sprint 1 同步完成）

#### 【TASK-P1-01】内置工具 fetch 兜底增加 PDF 魔数校验 + 原子写盘

| 项 | 内容 |
|----|------|
| **问题描述** | [patentPdfDownload.ts#L457-L466](file:///Users/xujian/projects/Sati/src/tool/builtin/patentPdfDownload.ts#L457-L466) 的 `fetchPdfFallback` 把 response 整个 Buffer 直接 `writeFile(target)`，未校验内容类型。若 Google CDN 返回 403 HTML 页面，也会被保存为 `<patent>.pdf` 且文件关联打开报错 |
| **优化方案** | 写入前：① `buffer.slice(0, 5).toString()` === `'%PDF-'`（PDF 以 `%PDF-x.y` 开头，取 5 字节更稳）；② `buffer.length < 500` 判定为错误页不落盘（与 Python 侧阈值统一为 500，Python 现有 100 同步上调）；③ 改为 `writeFile(target + '.tmp')` → `fs.rename(tmp, target)` 原子替换（避免进程中断留下半写文件）；④ 新增响应头预检查（宽松策略：Content-Type 存在且为 `text/html` 时拒绝，`application/octet-stream` 等不误杀） |
| **验收标准（DoD）** | ① 构造 mock fetch 返回 `<html>403</html>`，函数返回 `status=failed` 且 workspace 无 .pdf 生成；② mock 返回真实 PDF 头部，成功落盘；③ 构造 50% 中断场景（半写），下一次重跑目标文件应不存在或等于完整文件（无残缺）；④ 新增的单元测试覆盖两条分支（沿用 `fetchImpl` 测试缝，无需 nock） |
| **影响文件** | 主改：[patentPdfDownload.ts](file:///Users/xujian/projects/Sati/src/tool/builtin/patentPdfDownload.ts) 函数 `fetchPdfFallback`；新增：`tests/patent/tool/patentPdfDownload-fallback.spec.ts`；依赖：`npm i nock --save-dev`（如未装） |
| **预估工时** | 2 小时（含测试） |
| **风险等级** | 🟢 低 |
| **关联任务** | 被依赖：无；可并行：TASK-P1-02 |

#### 【TASK-P1-02】下载路径安全：保留自定义目录能力 + 越界写入提示（修订 v2）

| 项 | 内容 |
|----|------|
| **问题描述** | 现有能力已明确支持 `outputDir` 传入“绝对路径 / 相对工作空间的路径”，技能文档也给出 `-o ~/Downloads/patents` 示例（见 [SKILL.md#L36](file:///Users/xujian/projects/Sati/skills/patent-download/SKILL.md#L36)，行号经核实修正）。v1 方案默认把输出限制到 workspace 内会**回退该已文档化能力**。真正需要防御的是：路径穿越、目录不存在导致的异常、以及绕过权限提示。 |
| **优化方案（v2 修订）** | 1）**保留** `resolve(cwd, outputDir)` 的绝对路径解析能力，不改默认行为；2）仅对“解析后路径在 workspace 之外”的场景，在 `checkPermissions` 的 ask 弹窗中**追加越界写入提示**（`"The output directory is outside the current workspace."`），由用户决定放行或拒绝，而不是静默拒绝；3）对专利号做路径穿越防御：normalized 后仍断言不含 `/`、`\`、`..`；4）`session.ensureDir(outputDir)` 已创建目录，异常时给出明确报错。 |
| **验收标准（DoD）** | ① `-o ~/Downloads/patents` 在非交互环境下仍可正常写入（不回归）；② `outputDir` 指向 workspace 外时，ask 弹窗文案包含“outside the current workspace”提示；③ 专利号 `CN../evil` 被剔除并 warning；④ 新增输入校验单测 5 条全部通过；⑤ 与 v1 行为 diff：仅增加权限提示，不改变可写路径集合 |
| **影响文件** | [patentPdfDownload.ts](file:///Users/xujian/projects/Sati/src/tool/builtin/patentPdfDownload.ts)：`validateInput` + `checkPermissions` + `resolveOutputDir` 周边；[download_patent_ego.py](file:///Users/xujian/projects/Sati/skills/patent-download/scripts/download_patent_ego.py)：`-o` 路径校验同步（仅路径穿越检查，不限制绝对路径） |
| **预估工时** | 2 小时（TS 1h + Python 1h） |
| **风险等级** | 🟢 低（保留现有能力，仅增强提示与防御） |

---

### 🟠 P2 建议级（Sprint 2 目标：功能补强 + 性能体验）

#### 【TASK-P2-01】PG 关键词检索性能：保持语义 + 可选索引路径（修订 v2）

| 项 | 内容 |
|----|------|
| **问题描述** | `--keyword` 走 `ILIKE '%keyword%'` 是 7520 万行全表扫描，执行时间不可控且不可取消。**v1 方案直接把它换成全文索引会改变产品语义**（见 [patent_search.sh#L145-L160](file:///Users/xujian/projects/Sati/skills/patent-search/scripts/patent_search.sh#L145-L160) 与 [#L249-L263](file:///Users/xujian/projects/Sati/skills/patent-search/scripts/patent_search.sh#L249-L263) 的语义差异），不可静默替换。 |
| **优化方案（v2 修订）** | 1）**保留** `--keyword` 现有语义（标题/摘要关键词匹配）；2）新增**显式** `--keyword-indexed`（或 `--fast-keyword`）选项走 `search_vector` 全文索引路径，帮助文案明确标注“语义为全文检索、非子串匹配”；3）统一在脚本最开头 `SET statement_timeout = '5s'` 会话级超时；4）对 `--limit` 与 `ORDER BY` 组合做保护，避免超大数据集失控。 |
| **验收标准（DoD）** | ① `--keyword "人工智能"` 与 v1 前返回结果**完全一致**（不改默认语义）；② `--keyword-indexed "人工智能"` 的 `EXPLAIN ANALYZE` 走 **Bitmap Index Scan on search_vector_idx**；③ `pg_sleep(10)` 同会话 5 秒内被 `canceling statement due to statement timeout` 中断；④ 帮助文本同时描述两种模式 |
| **影响文件** | [patent_search.sh](file:///Users/xujian/projects/Sati/skills/patent-search/scripts/patent_search.sh)：`execute_query()` 函数体开头 + 新增 `--keyword-indexed` 分支 |
| **预估工时** | 3 小时（含 EXPLAIN 验证 + 新增参数文档） |
| **风险等级** | 🟢 低（默认语义不变；新选项为增量能力） |
| **前置依赖** | 完成 TASK-P0-01（SQL 参数化）后统一改造 SQL 语句 |

#### 【TASK-P2-02】下载失败指数退避重试（3 次）

| 项 | 内容 |
|----|------|
| **问题描述** | 单次 CDN 请求遇到 5xx / 429 / ETIMEDOUT 即永久标记 failed，批量成功率被瞬时网络抖动拉低 |
| **优化方案** | `fetchPdfFallback` 封装 `asyncRetry(fn, { retries: 3, factor: 2, minDelay: 1000 })`：HTTP 429、5xx、`ECONNRESET`/`ETIMEDOUT` 走重试；HTTP 404 / 403 / 魔数错误**立即失败不重试**；Python 版 `download_pdf_from_url` 同步增加重试循环 |
| **验收标准（DoD）** | ① mock 首次 502 + 二次 200：最终成功且 `retry_count=2`（埋点验证）；② mock 首次 404：立即失败不重试；③ 三次都超时：最终失败日志含"retries exhausted after 3 attempts"；④ nock 可注入 count 断言 |
| **影响文件** | TS：[patentPdfDownload.ts](file:///Users/xujian/projects/Sati/src/tool/builtin/patentPdfDownload.ts) `fetchPdfFallback`；Py：[download_patent_ego.py](file:///Users/xujian/projects/Sati/skills/patent-download/scripts/download_patent_ego.py) `download_pdf_from_url` |
| **预估工时** | 2 小时 |
| **风险等级** | 🟢 低 |

#### 【TASK-P2-03】批量下载断点续传 MANIFEST（先统一产物契约，v2 修订）

| 项 | 内容 |
|----|------|
| **问题描述** | v1 方案直接让 TS/Python 共用 MANIFEST，但两条链路**产物命名不一致**：TS 为 `<patent>.pdf`（[patentPdfDownload.ts#L511-L518](file:///Users/xujian/projects/Sati/src/tool/builtin/patentPdfDownload.ts#L511-L518)），Python 为 `<patent>_<title>.pdf` 并以该文件已存在作为跳过条件（[download_patent_ego.py#L222-L230](file:///Users/xujian/projects/Sati/skills/patent-download/scripts/download_patent_ego.py#L222-L230)）。若直接共用 MANIFEST，会出现重复下载或跳过失效。 |
| **优化方案（v2 修订）** | 1）**先统一产物契约**：定义 `artifact key = <normalizedPatentNumber>`，两条链路落盘文件统一为 `<outputDir>/<patent>.pdf`（Python 侧去掉标题后缀，或提供 `--with-title` 兼容开关）；2）再实现 MANIFEST：首次执行创建 `<outputDir>/.MANIFEST.jsonl`，每行 `{"patent":"CNxxx","status":"ok","path":"...","size":12345,"sha1":"...","ts":169...}`；3）下次启动前扫描 MANIFEST，命中 `status=ok` 且文件大小匹配的**直接跳过**，不打开 Google Patents 页；4）提供 `--force` 标志可清空 MANIFEST 强制重跑；5）旧命名文件迁移：检测到 `<patent>_<title>.pdf` 旧产物，提示用户（不自动删除）；6）**加载去重（v2 补充）**：MANIFEST 为 append 追加式，加载时按 `patent` 键去重（最后一条 wins），避免重复运行积累重复行导致跳过判断退化。 |
| **验收标准（DoD）** | ① 半批次中断场景：重跑成功跳过已完成，总耗时减少；② 手动修改已下载 PDF 大小，重跑检测到 size 不匹配 → 重新下载；③ `--force` 运行时所有专利都被视为未下载；④ TS 与 Python 对同一目录的 MANIFEST 互相识别（产物命名已统一）；⑤ 旧命名文件不自动删除，仅提示 |
| **影响文件** | TS：[patentPdfDownload.ts](file:///Users/xujian/projects/Sati/src/tool/builtin/patentPdfDownload.ts) 新增 `loadManifest/saveManifest`；Py：[download_patent_ego.py](file:///Users/xujian/projects/Sati/skills/patent-download/scripts/download_patent_ego.py) 主流程 + `download_one` 命名规则 |
| **预估工时** | 4 小时（含契约统一 + 旧文件兼容提示） |
| **风险等级** | 🟡 中（命名规则变更对已有用户属 breaking；通过 `--with-title` 兼容开关缓解） |

#### 【TASK-P2-04】fetch 兜底改为流式写盘（降内存）

| 项 | 内容 |
|----|------|
| **问题描述** | 当前 `Buffer.from(await res.arrayBuffer())` 全量读入内存。20MB PDF × 并发 N = 内存占用 GB 级 |
| **优化方案** | 使用 Node `stream/web` + `fs.createWriteStream`：`const body = Readable.fromWeb(res.body); await pipeline(body, createWriteStream(tmpPath)); ... rename`。保留**先读 5 字节校验魔数，再 pipe 剩余流**的组合 |
| **验收标准（DoD）** | ① 同一份 20MB PDF，改造前后 RSS 内存峰值差异 ≥ 15MB；② 落盘文件 SHA-1 与源文件完全一致；③ 与 TASK-P1-01 魔数校验组合有效 |
| **影响文件** | [patentPdfDownload.ts](file:///Users/xujian/projects/Sati/src/tool/builtin/patentPdfDownload.ts#L457-L466)：重写 fetchPdfFallback |
| **预估工时** | 2 小时 |
| **风险等级** | 🟡 中（流处理错误传播路径需格外小心：魔数不匹配要能及时 `destroy()` 流） |

#### 【TASK-P2-05】sati config 增加全局下载目录配置项（实施点修正，v2 修订）

| 项 | 内容 |
|----|------|
| **问题描述** | v1 方案把实施点写成 `src/pilot/config/schema.ts`，但**当前仓库没有这个文件**。pilot 配置是 `types.ts`（类型定义）+ `loadPilotConfig.ts`（组装/分发）+ 各 `parse*.ts`（解析校验）体系。直接指向 `schema.ts` 会导致实施点判断不准、工时偏乐观。 |
| **优化方案（v2 修订）** | 在现有 pilot 配置体系内新增 `patents.downloadDir`：1）在 [types.ts](file:///Users/xujian/projects/Sati/src/pilot/config/types.ts) 中新增 `PilotPatentsConfig` 类型，并挂到 `PilotRawConfig`；2）新增/扩展 `parsePatentsConfig.ts` 解析校验（字段可选，值必须是非空字符串）；3）在 [loadPilotConfig.ts](file:///Users/xujian/projects/Sati/src/pilot/config/loadPilotConfig.ts) 接线到整体配置；4）`resolveOutputDir` 读取优先级：`入参 outputDir` > `config.patents.downloadDir` > 旧规则 `<cwd>/专利原文/YYYY-MM-DD`；5）同步更新 `redact.ts`/`hash.ts`（如涉及敏感字段）；6）补 `PilotConfigChangeClass` 分类（该字段为 `runtime-live`——工具每次执行时经注入通道读取）。**注入通道（v2 补充）**：`SatiToolRuntimeContext` 不携带 pilot config，故经 `CreatePatentPdfDownloadToolOptions` 扩展 `patentsConfigProvider`（`resolveOutputDir` 加 config 参数），注册处 [createBuiltinRegistry.ts](file:///Users/xujian/projects/Sati/src/tool/registry/createBuiltinRegistry.ts) 已有 `options?.patentPdfDownload` 通道可接线。 |
| **验收标准（DoD）** | ① `sati config set patents.downloadDir ~/Patents` 生效，不传 `-o` 也写到该目录（仍追加日期子目录）；② 删除配置后自动回退旧规则；③ schema 类型校验：字段不存在时合法，存在必须是非空字符串；④ `typecheck` 全绿；⑤ 配置变更分类已定义 |
| **影响文件** | [types.ts](file:///Users/xujian/projects/Sati/src/pilot/config/types.ts) + [loadPilotConfig.ts](file:///Users/xujian/projects/Sati/src/pilot/config/loadPilotConfig.ts) + 新增 `parsePatentsConfig.ts`；[patentPdfDownload.ts](file:///Users/xujian/projects/Sati/src/tool/builtin/patentPdfDownload.ts) `resolveOutputDir` 签名加 config 注入 |
| **预估工时** | **3.5 小时**（v2 上调：类型定义 + 解析器 + 接线 + 变更分类 + 测试） |
| **风险等级** | 🟢 低 |

#### 【TASK-P2-06】搜索结果按 patent family 去重（v2 修订：降级为基号分桶）

| 项 | 内容 |
|----|------|
| **问题描述** | Google Patents / nuo-patent 常返回同申请的公开（A）、授权（B）、分案（C）多篇高度相似文本，用户浏览冗余 |
| **优化方案（v2 修订）** | 核实 `PatentSearchHit` 类型（vendor/nuo-patent dist/index.d.ts）**不含 `application_number` 字段**（检索 hits 只有 patent/title/assignee/publicationDate/priorityDate/abstract/url），无法按申请号分桶。降级方案：按 patent 号**去 kind code 取基号**分桶（`CN115690481A`→`CN115690481`，确定性正则，覆盖同申请 A/B/C 变体；跨号分案不识别，属已知边界）。同基号保留 `publicationDate` 最新一篇，合并统计写入 `warnings` 字符串（不改 outputSchema strict 结构，见 `additionalProperties: false`） |
| **验收标准（DoD）** | ① mock 3 条 hits：同基号 A/B/C 三版，最终仅 B（最新日期）展示；② `warnings` 新增 family 合并统计字符串；③ 真实世界执行 1 次 "华为 5G" 检索目测去重有效 |
| **影响文件** | [patentSearch.ts](file:///Users/xujian/projects/Sati/src/tool/builtin/patentSearch.ts) `execute` 后段，`hits.map(toItem)` → 新增 `dedupeByFamily(hits)` 步骤 |
| **预估工时** | 2 小时（v2 上调：去重 + warnings 统计） |
| **风险等级** | 🟢 低（跨号 family 不识别为已知边界，文档注明） |

#### 【TASK-P2-07】统一 PDF 链接提取 JS 为单一事实源（去重复代码）

| 项 | 内容 |
|----|------|
| **问题描述** | 选择器逻辑在 TS 和 Python 各一份，Google Patents DOM 变更要双处修 |
| **优化方案（v2 修订）** | 新建 `assets/patent/pdf-link-extract.js`（纯字符串，首行注释带 `PDF_LINK_EXTRACT_VERSION=1`）+ 版本号；TS 端执行时 `readFile` 注入（热加载）；Python 端启动时读取同一路径内容，`json.dumps` 安全嵌入。**以 TS 超集版（[patentPdfDownload.ts#L45-L57](file:///Users/xujian/projects/Sati/src/tool/builtin/patentPdfDownload.ts#L45-L57)，含 `allLinks` 兜底扫描）为唯一事实源**，Python 侧引用后行为与 TS 完全一致，不回退 |
| **验收标准（DoD）** | ① 全仓 grep `a\[href\*="\.pdf"\]`（含 Python 源码转义变体 `\"`）命中数 = 1（资源文件本身）；② 两端对同一份 Google Patents HTML fixture 提取结果完全一致；③ 版本号 bump 后两端均能热加载新版 |
| **影响文件** | 新增：`assets/patent/pdf-link-extract.js`；改动：[patentPdfDownload.ts](file:///Users/xujian/projects/Sati/src/tool/builtin/patentPdfDownload.ts#L45-L57) + [download_patent_ego.py](file:///Users/xujian/projects/Sati/skills/patent-download/scripts/download_patent_ego.py#L83-L96) |
| **预估工时** | 2 小时 |
| **风险等级** | 🟢 低 |

---

### 🟢 P3 可延期（Sprint 3：可维护性 + 长期演进）

#### 【TASK-P3-01】缓存 TTL 分层策略（稳定/易变/零命中三档）
- **工时** 1h：[patentCache.ts](file:///Users/xujian/projects/Sati/src/patent/data/nuo/patentCache.ts) `cachedSearchPatents` 增加按 `isSearchResultCacheable` 之外的命中数分类；零命中 TTL=1min、法律状态关键词 TTL=5min、其余 TTL=2h
- **DoD**：新增单测覆盖三类 TTL 分别在各自到期后触发重拉

#### 【TASK-P3-02】结构化下载成功率埋点（Telemetry JSONL）
- **工时** 1.5h：每次批次结束追加一行 `~/Library/Application Support/Sati/patent-download-log.jsonl`：`{ts, total, ok, failed, perPatent: [{num, status, method, durationMs, errorCode}], clientVersion}`
- **DoD**：跑 1 次后读文件校验 JSONL 合法；可离线用 jq 统计 P95 延迟

#### 【TASK-P3-03】nuo-patent vendor 校验与 checksum 审计
- **工时** 1h：为 `vendor/nuo-patent/dist/*` 生成 SHA-256 manifest，`postinstall` 校验不通过即安装失败。同时放 `SOURCE_COMMIT` 文本记录上游哈希。
- **DoD**：手动改 dist 任一文件 1 字节，`pnpm i` 抛 checksum mismatch

#### 【TASK-P3-04】e2e 测试覆盖下载通道分支（nock + mock EgoSession）
- **工时** 3h：用 `CreatePatentPdfDownloadToolOptions.session` 注入 mock EgoBrowserSession，依次模拟：ok / fallback + fetch 成功 / fallback + fetch 失败 / 魔数错误 4 条主路径
- **DoD**：`tests/patent/tool/patentPdfDownload-e2e.spec.ts` 4 用例全绿 + 覆盖率报告 `fetchPdfFallback` 分支覆盖 ≥ 95%

#### 【TASK-P3-05】Shell 脚本全面迁移为 TS CLI（M5 方案）
- **工时** 2 天：新建 `src/scripts/patent-search.ts` 用 `pg` 包，功能与 `patent_search.sh` 100% 对齐，bin 入口 `sati patent-search`。Shell 版保留 6 个月 deprecation。
- **DoD**：相同参数对比产出逐行相同（PG 结果一致）；`sati patent-search --keyword "人工智能"` 成功；Shell 脚本入口输出 deprecation notice。

---

## 第三部分：3 Sprint 推进节奏

### Sprint 1 — 安全修复周（准入生产门槛）
**主题**：消除 P0/P1 高危 + 冒烟回归
**目标**：生产就绪度判定从 ⚠️ 不满足 → ✅ 满足
**工期预估**：1.5 人天

| 序号 | 任务 ID | 依赖 | 半天窗口安排 | 交付物 |
|------|---------|------|-------------|--------|
| 1 | TASK-P0-01 SQL 注入修复 | 无 | Day 1 上午 | patch 文件 + 注入载荷测试脚本 + 结果截图 |
| 2 | TASK-P0-02 SSL 修复 | 无 | Day 1 下午 | 真实专利 PDF 下载成功 + badssl 拒绝证书验证截图 |
| 3 | TASK-P1-01 PDF 魔数校验 | 无 | Day 2 上午 | nock 单测 4 条全绿 |
| 4 | TASK-P1-02 路径安全（v2：保留绝对路径 + 越界提示） | 无 | Day 2 下午 | validateInput 单测 + 越界提示确认 |
| 5 | 全回归：`node --test tests/patent/` 基线 + 专利搜索/下载 Smoke Test | 1-4 全部完成 | Day 3 上午（0.5d） | `node --test` 全绿 + 手动 Dry-run 日志 |

**Sprint 1 出口门禁**：
- ✅ 代码中 grep 不到 `CERT_NONE` / `ILIKE '%\${` 字符串
- ✅ 新增 15+ 条安全测试全部通过
- ✅ 真实小批量（5 篇专利）Dry-run 下载成功率 100%
- ✅ `-o ~/Downloads/patents` 绝对路径写入能力未回归（v2 新增门禁）

---

### Sprint 2 — 功能补强 + 性能体验（核心优化）
**主题**：Sprint 1 安全底座稳定 → 补 P2 功能/性能
**目标**：搜索性能 + 下载成功率 + 内存效率三项核心指标提升
**工期预估**：2.5-3 人天

| 序号 | 任务 ID | 依赖 | 顺序 | 交付物 |
|------|---------|------|------|--------|
| 1 | TASK-P2-01 关键词性能（v2：保留语义 + 新增索引选项） | TASK-P0-01 | 先做 | EXPLAIN 截图 + 新旧模式耗时对比表 |
| 2 | TASK-P2-02 失败重试 3 次 | TASK-P1-01 | 并行可行 | nock 重试用例 + 批量下载成功率统计对比 |
| 3 | TASK-P2-03 断点续传（v2：先统一产物契约） | TASK-P2-02 | 之后 | 契约统一 diff + 半批次中断-重跑演示 |
| 4 | TASK-P2-04 流式写盘 | TASK-P1-01 | 并行可行 | RSS 内存前后对比 |
| 5 | TASK-P2-05 全局 config 目录（v2：修正实施点） | 无 | 任意位置 | `sati config set` 演示 + 类型接线 diff |
| 6 | TASK-P2-06 结果去重 | 无 | 任意位置 | 真实 "华为 5G" 检索前后 hits 数量对比 |
| 7 | TASK-P2-07 去重复代码 | TASK-P1-01 + TASK-P0-02 | 最后 | 资源文件创建 + 两端引用改造 |

**Sprint 2 出口门禁**：
- ✅ P2-01：默认 `--keyword` 结果与改前一致；`--keyword-indexed` P95 ≤ 1s
- ✅ P2-02+03：模拟 20% 瞬时故障，最终成功率 ≥ 98%
- ✅ P2-04：20MB PDF 单篇内存占用从 ≥ 20MB → ≤ 1MB
- ✅ P2-03：TS 与 Python 对同一 MANIFEST 互相识别
- ✅ 全仓 grep `a\[href\*="\.pdf"\]`（含 Python 源码转义变体 `\"`）命中数 = 1（资源文件本身）

---

### Sprint 3 — 可维护性 + 长期演进
**主题**：埋点/CI/长期债务
**目标**：可观测 + 可审计 + 技术债削减
**工期预估**：2-3 人天（可拆分穿插到日常）

| 任务 | 工时 | 交付物 |
|------|------|--------|
| TASK-P3-01 TTL 分层 | 1h | unit test 绿 |
| TASK-P3-02 成功率 JSONL 埋点 | 1.5h | 日志文件 + jq 聚合脚本 |
| TASK-P3-03 vendor 校验 | 1h | SOURCE_COMMIT + 安装失败演示 |
| TASK-P3-04 e2e nock 全覆盖 | 3h | 覆盖率报告分支 95%+ |
| TASK-P3-05 Shell→TS 迁移 | 2d | `sati patent-search --help` 正常输出 + Shell 标记 deprecated |

---

## 第四部分：逐项检查清单（Checklist）

### ✅ 执行前检查（Before Any Change）

- [ ] **C1** 当前工作区干净：`git status` 无未提交修改，分支命名为 `feat/patent-optim-sprint-N`
- [ ] **C2** 基线保存：`node --test --test-reporter=json tests/patent/ > baseline_before.jsonl` 存档
- [ ] **C3** 依赖齐备：`pnpm install` 确认依赖锁一致；`python3 --version` ≥ 3.9；`which psql` 命中
- [ ] **C4** 注入安全载荷备份（TASK-P0-01）：SQL 注入测试前，对本地 `patent_db` 做 `pg_dump` 快照到 `/tmp/patent_db_bad.sql` 或使用独立测试库实例
- [ ] **C5** 权限申请：涉及改动 pilot config 体系（P2-05）/ 新增 npm 包（nock 等）的相关配置权限已获批
- [ ] **C6** ego-browser 可用：`ego-browser nodejs --version` ≥ 1.2.6 以保证下载拦截 API 可用
- [ ] **C7（v2 新增）** 记录当前“输出到工作空间外绝对路径”的实际用例（如 `-o ~/Downloads/patents`），作为 P1-02 回归基线

### 🔄 执行中检查（Per-Task DoD Gate）

每个任务完成**立即**执行以下检查，不通过不进入下一任务：

- [ ] **D1 静态检查**：`pnpm run typecheck && pnpm run lint` 零新增 error/warning
- [ ] **D2 测试覆盖**：新增单测覆盖率阈值：改动行数 × 0.8 以上被单测触达；用 `node --test --experimental-test-coverage`（Node 22+）验证
- [ ] **D3 安全扫描**：
  - SQL 修复（P0-01）：`grep -n "ILIKE.*\\\$\\{" skills/patent-search/scripts/patent_search.sh | wc -l` = 0
  - SSL 修复（P0-02）：`grep -n "CERT_NONE\|check_hostname.*False" skills/patent-download/scripts/*.py | wc -l` = 0
  - 路径安全（P1-02 v2）：`git diff` 可见 resolveOutputDir 未改变可写路径集合，仅 checkPermissions 追加越界提示
- [ ] **D4 真实冒烟（Dry Run on Real Data）**：
  - 搜索：真实执行 `cd skills/patent-search && bash scripts/patent_search.sh --keyword "人工智能" --limit 3` 与改造前结果条数一致
  - 下载：真实跑 `python3 skills/patent-download/scripts/download_patent_ego.py CN115690481A -o /tmp/patent-test` 校验文件魔数 `head -c 5 /tmp/patent-test/*.pdf` = `%PDF-`
  - 绝对路径（v2）：`python3 skills/patent-download/scripts/download_patent_ego.py CN115690481A -o ~/Downloads/patent-test` 写入成功
- [ ] **D5 日志可追溯**：每处新增 warning/error 输出均含**任务编号前缀**（如 `[P1-01] Invalid PDF magic: xxx`）

### 🎯 执行后检查（Sprint 出口 & 回归）

每个 Sprint 完成后**统一执行**：

- [ ] **R1 全量单元测试**：`node --test tests/patent/` 全绿；执行前实测基线（当前 61 个 spec 文件）并写入基线文件，通过率 ≥ 基线且不允许回退
- [ ] **R2 跨平台验证（至少双环境）**：
  - macOS 本地（已测）
  - 若有 Linux 容器：`docker run --rm node:22 node -e "import('./dist/src/tool/builtin/patentPdfDownload.js').then(m => m.createPatentPdfDownloadTool)"` 无 SyntaxError（动态 import，避免 require(esm) 依赖）
- [ ] **R3 性能基线**：
  - 搜索：`--keyword-indexed` 查询总耗时 ≤ 1s；默认 `--keyword` 结果与改前一致
  - 下载：10 篇 PDF 批量总耗时 ≤ 改前 0.8× 且无内存 OOM
- [ ] **R4 安全回归（专项）**：
  ```bash
  # SQL 注入专项
  cd skills/patent-search
  bash scripts/patent_search.sh --keyword "x'; DROP TABLE patents_test; SELECT '" 2>&1 | grep -c "syntax error"  # 应为 >0

  # SSL 专项
  python3 -c "
  import urllib.request, ssl
  ctx = ssl.create_default_context()
  try:
      urllib.request.urlopen('https://self-signed.badssl.com/', context=ctx, timeout=5)
  except ssl.SSLCertVerificationError:
      print('OK: self-signed rejected')
  "
  # 应输出 OK

  # 路径能力回归（v2 新增）
  python3 skills/patent-download/scripts/download_patent_ego.py CN115690481A -o ~/Downloads/patent-test  # 应成功
  ```
- [ ] **R5 变更说明齐**：git commit message 遵循 `check-commit-msg.mjs` 校验（如 `feat(patent-search): fix SQL injection in patent_search.sh [P0-01]`）
- [ ] **R6 兼容性报告**：整理 Breaking Change 清单（如 P2-03 Python 文件名统一 → release note 说明 + `--with-title` 迁移指引；P2-01 新增选项 → 使用说明）

---

## 第五部分：风险预案

| 风险 | 触发条件 | 概率 | 影响 | 预案 |
|------|---------|------|------|------|
| **P0-01 SQL 参数化导致检索结果偏离** | `psql -v` 的 `:'var'` 引号语义与直接插值不一致（如空串/含引号值的 LIKE 匹配失效） | 🟡 中 | 用户抱怨"搜不到老结果" | DoD ② 改造前后结果集逐条比对（EXPLAIN + 结果条数）+ `:'var'` 引号语义专项单测 |
| **P0-02 SSL 恢复后部分公司内网 MITM 代理拦截失败** | 企业内网网关用自签证书 | 🟡 中 | 企业用户集体无法下载 | ① 新增 `--no-verify-ssl` 显式 opt-in 开关（仅在报错引导用户显式启用，**不再默认禁用**）；② 同时提供 `REQUESTS_CA_BUNDLE` 指引用户导入网关 CA |
| **P1-02 越界提示被误判为功能移除** | 用户看到 ask 弹窗以为是拒绝 | 🟢 低 | 用户困惑 | v2：弹窗提供“允许一次性/总是允许”选项，保留绝对路径能力；文档明确说明 |
| **P2-03 命名统一引发旧用户 break** | 用户依赖 `<patent>_<title>.pdf` 文件名 | 🟡 中 | 旧脚本断链 | `--with-title` 兼容开关保留旧命名；MANIFEST 以 patent 为 key 双重兼容 |
| **P2-04 流式处理在 Node 版本不一致时 API 差异** | Node < 22 时 `Readable.fromWeb` 缺失 | 🟢 低 | 部分用户启动报错 | `engines.node` 已锁 `>=22.13.0`，不额外兼容；CI 中 `node --version` 门禁校验 |
| **ego-browser 升级导致下载拦截 API 破坏** | 用户升级 ego lite 到不兼容版本 | 🟡 中 | 所有浏览器拦截路径失败 → 全走 fetch fallback | 在 `checkAvailability` 阶段做能力探测（typeof `page.waitForEvent`），失败时提前警告 |
| **P2-05 配置接线影响现有配置加载** | 新增 parsePatentsConfig 与现有 load 链路冲突 | 🟢 低 | 配置解析报错 | 字段可选 + 默认 undefined；新增配置单测覆盖“未配置/配置/非法类型”三态 |
| **MANIFEST 文件损坏引发死循环** | 用户手改 MANIFEST.jsonl 写成非法 JSON | 🟢 低 | 启动崩溃 | 解析时 try/catch + JSONL 逐行校验；损坏则重命名为 `*.bak` 并从 0 开始（日志提示） |
| **P3-05 Shell→TS 迁移引发 CLI 参数不兼容** | 用户脚本写死调用 `patent_search.sh` | 🟡 中 | 自动化流水线中断 | 保留 Shell 脚本入口 6 个月，内部直接 exec 到新 TS CLI；stderr 输出 deprecation notice 含切换指引 |

---

## 第六部分：总工时汇总

| 优先级 | 任务数 | 总工时（人天） | 主要人力投入 |
|--------|--------|---------------|-------------|
| P0 阻断 | 2 | 1.0 | 后端安全工程师 / 主程 |
| P1 强烈 | 2 | 0.5 | 全栈工程师 |
| P2 建议 | 7 | 3.0（v2 上调 P2-03/P2-05） | 全栈 + Python 脚本各半 |
| P3 可延 | 5 | 3.0 | 可拆分日常 |
| **合计** | **16** | **~7.5 人天** | 单人专注 2 周；2 人并行 1 周交付 |

### 🔥 最小必选集（先上线再迭代）= **Sprint 1 仅 1.5 人天**
**完成即可判定满足完整可运行的生产要求**，剩余 P2/P3 纳入后续迭代窗口。

---

## 附录：v1 → v2 变更点对照

| 任务 | v1 内容 | v2 修订 | 变更原因 |
|------|---------|---------|----------|
| TASK-P1-02 | 限制 outputDir 到 workspace 内 | 保留绝对路径能力 + 越界写入仅追加权限提示 | 会回退已文档化的“输出到自定义目录”能力 |
| TASK-P2-01 | `--keyword` 直接替换为全文索引 | 保留原语义 + 新增 `--keyword-indexed` 可选索引路径 | 静默替换会改变产品检索语义 |
| TASK-P2-03 | 直接共用 MANIFEST | 先统一产物命名契约（artifact key = patent 号），再实现 MANIFEST | TS/Python 产物命名不一致会导致续传规则分叉 |
| TASK-P2-05 | 实施点 `src/pilot/config/schema.ts` | 改为 `types.ts` + `parsePatentsConfig.ts` + `loadPilotConfig.ts` 接线，工时 2h→3.5h | 仓库不存在 `schema.ts`，实施点不准 |
| Sprint 1 门禁 | - | 新增 C7 / R4 绝对路径回归用例 | 保障 P1-02 修订不回退现有能力 |
