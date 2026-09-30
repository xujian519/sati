# Agent Note: CAD 投影链路的失败诊断（issue #595 / #596）

Status: implemented

## Problem

`figuregen/cad/` 的投影链路在**失败时给不出真因**，两个独立根因：

1. **脚本侧（#595）**：`buildProjectionScript` 用 `raise SystemExit('…')` 报错，共 7 处。
   本机实测（FreeCAD 1.1.3 / `freecadcmd`）：

   | 脚本失败形态 | 退出码 | 消息可见性 |
   |---|---|---|
   | `raise SystemExit(3)` | 3 | ❌ stderr 为空（`SystemExit` 的 str 被吞） |
   | `sys.exit(1)`（先写 stderr） | 1 | ✅ stderr 完整 |
   | `raise RuntimeError("BOOM")` | **0** | ⚠️ stderr 有 `Exception while processing file: … [BOOM]` |
   | `try/except` + stderr + `sys.exit(1)` | 1 | ✅ stderr 完整 |

   后果实测（端到端调 `projectStep`，step 指向 `Part.export([裸 Shape])` 产出的空壳 STEP）：

   ```
   freecadcmd 投影失败（退出码 1）：FreeCAD 1.1.3, Libs: 1.1.3R20260725 (Git shallow)
   | (C) 2001-2026 FreeCAD contributors | FreeCAD is free and open-source software …
   ```

   用户看到的是**版本横幅**——七处失败文案一条都到不了调用方。主流程（`shape.read` /
   `shape.common` / `TechDraw.project`）也没有顶层兜底，故 FreeCAD 侧异常会走「退出码 0」那一栏。

2. **消费侧（#596）**：`projectStep` 只在 `code !== 0` 时读 stderr，`code === 0` 便直接
   `parseProjectionOutput(stdout)`。而 freecadcmd 对未捕获的 Python 异常**退出码就是 0**
   （上表第 3 行）⇒ 真因只在 stderr，却被整条丢弃。后果实测（`step_path` 指向不存在的文件）：

   ```
   投影输出缺少定界标记（SATI_CAD_JSON_BEGIN/SATI_CAD_JSON_END）——无法定位边表
   ```

   真因是 `OSError: File to load not existing or not readable`；「文件不存在」这类最常见的
   用户输入错误被报成了一句与它无关的解析错误。

## Decision

**① 脚本侧：以「消息 + 非零退出码」为契约，收口到单一失败出口。**

- 新增 `_fail(message)`：写 stderr（前缀为常量 `CAD_ERROR_MARKER = "SATI_CAD_ERROR:"`）+
  `sys.exit(1)`；7 处 `raise SystemExit('…')` 全部改用它。
- STEP 读入口显式区分两种失败，并给可执行提示：文件不可读（`OSError`，带路径）与
  「已解析但几何为空（无 B-rep）」——后者直指 `exportStep` vs `Part.export([shape], path)` 的
  空壳陷阱（本机 1.1.3 实测该 API 会静默写出 1.6 KB / 20 实体 / 零 B-rep 的 STEP）。
- 主流程收进 `_main()`，顶层 `try/except Exception → _fail(...)` 兜底 ⇒ 契约外的异常也不再
  返回 0。生成物仍按「数组拼 Python 源码」的既有形态产出（`helpers` / `mainFlow` 两段，
  后者按行缩进一级），不改该形态本身。

**② 消费侧：退出码不是成功的充分条件。**

- 新增导出的纯函数 `describeCadFailure(stdout, stderr)`：取值优先级为
  **脚本标记行 → stderr 尾部 → stdout 尾部**（后者如实标注「stderr 为空」，不把版本横幅当真因）。
- `projectStep` 的**两条**失败路径共用它：`code !== 0`，以及**输出不可解析**
  （错误信息写成「退出码 0，输出不可解析：<解析错误>）：<真因>」）。边数上限检查留在
  try 之外，避免把「超过上限」这种明确的拒绝误包成解析失败。

标记常量为脚本侧与消费侧**共用同一个导出常量**（脚本里由 TS 侧插值写入），使「脚本报了错」
与「Sati 认得出这个错」在结构上不可能漂移；并有单测把「脚本写出的那一行」喂给
`describeCadFailure` 做绑定。

## Alternatives considered

- **只改消费侧（在 `code === 0` 时也读 stderr），不动脚本** — 落选：那样「退出码 0 也可能是
  失败」这条**反直觉契约**会永久留在链路上，任何只看退出码的调用方/复核脚本都会被骗。脚本侧
  修好之后，「非零退出码 ⇔ 失败」重新成立，消费侧那条只是防御（换 FreeCAD 版本、脚本被改动、
  `code === null` 等）。
- **只改脚本侧，不碰 `projectStep`** — 落选：修完脚本后仍存在一条会误诊的路径（契约被破坏时），
  且本次两个 issue 的复现里第 2 条正是靠消费侧才闭合。两者是同一失败面的必要条件。
- **用 `raise SystemExit('msg')` 但把消息也 `print` 到 stdout** — 落选：stdout 混有版本横幅与
  统计，解析侧已经要按定界标记截取；把错误塞进 stdout 会让「输出可解析」这一判据含混。
  stderr 是错误文本的既有通道，且实测 `sys.exit(1)` 不会被 freecadcmd 报成异常（stderr 干净）。
- **依赖 freecadcmd 自己的报错格式**（`Exception while processing file: <script> [<msg>]`）—
  落选（作为主通道）：那是私有、未承诺的实现细节，且会把临时脚本路径泄漏进用户可见文案。
  它仍作为**兜底**存在（标记行缺失时取 stderr 尾部），只是不作为契约。
- **把整个脚本包进 `exec(...)` 字符串做 try/except（避免缩进）** — 落选：`exec` 会让脚本
  无法在编辑器/`py_compile` 里静态检查，也失去行号意义。改用「两段数组 + 按行缩进」，
  生成物仍是可读、可编译的真 Python。
- **在 Python 侧把失败 JSON 化（结构化错误码）** — 落选：当前只有一条消费路径，错误码没有
  第二消费者；等出现「按原因分流重试/降级」的需求再谈（与 `dumpWidget`-类结构化输出的取舍一致）。
- **顺带引入 `shape.exportStep` 的写侧校验（Sati 内置 STEP 导出）** — 明确不做：Sati 是 STEP 的
  **消费者**（不产几何、不写 STEP，`src/` 里零 `exportStep`/`Part.export` 引用）。空壳陷阱在
  FreeCAD 侧，Sati 能做的只有「读入口显性化 + 文案可执行」，已落到 ①。

## Consequences

**换来**：失败时用户拿到的是可照做的真因（含路径、含 exportStep 提示），而不是版本横幅或
与真因无关的解析错误；「非零退出码 ⇔ 失败」重新成为可依赖的契约。

**付出**：

- 生成脚本多一层函数与一个顶层 `try`（+19 行生成物），`buildProjectionScript` 由 160 行增至
  约 180 行——该函数本就在 `TD-PATENT-N26` 的「长函数」登记里（形态本身有可审计性理由）。
- 文案中出现 FreeCAD API 名（`shape.exportStep` / `Part.export`）：这是**给用户照做的指令**，
  不是 Sati 的契约，FreeCAD 改 API 时需跟着改（已在该行注释里说明依据是本机 1.1.3 实测）。

**未做 / 待观察**：`describeCadFailure` 的「标记行优先」只在 stderr 还有其它噪声时才有可观测
差异（判据已覆盖该形态）；若将来 freecadcmd 改变退出码行为，消费侧那条兜底即成为主通道。

## 判据与负控制

新增/改写的判据都在 `tests/patent/figuregen/cad.spec.ts`：脚本契约（可执行行内不得出现
`raise SystemExit`、必须写 stderr 标记、必须有 `sys.exit(1)`、必须有 `_main()` + 顶层兜底、
9 条失败文案齐备）、两侧标记常量绑定、两条运行期失败路径、`describeCadFailure` 的取值优先级。

负控制（6 条变异，**串行**注入，每条 1 处退化，收尾从 `/tmp/fsfix/bak/` 用 `cp` 还原——
未用 `git checkout --`）：

| 变异 | 注入 | 预期转红 | 实际转红 | 命中 |
|---|---|---|---|---|
| M0（驱动器自检） | 改判据侧期望文案 | 脚本契约用例 | 脚本契约用例（`失败分支缺少真因文案`） | ✅ |
| M1 | `_fail` 不写 stderr | 脚本契约用例 | 同左（`sys.stderr.write(CAD_ERROR_MARKER` 不匹配） | ✅ |
| M2 | `sys.exit(1)` → `raise SystemExit(1)` | 脚本契约用例 | 同左（可执行行内含 `raise SystemExit`） | ✅ |
| M3 | 删掉顶层兜底 | 脚本契约用例 | 同左（`try: _main() except …` 结构断言不匹配） | ✅ |
| M4 | 消费侧解析失败不带 stderr | 「退出码 0…」用例 | 同左（只剩「缺少定界标记」） | ✅ |
| M5 | 去掉「标记行优先」一档 | 取值优先级用例 | 同左（返回 `… 先 \| 警告 \| … 后`） | ✅ |

每条变异**只红 1 条**、同批其余 27 条保持绿（证明三组判据各自独立，不是「一并崩」）；
还原后 md5 与备份逐位一致。M1/M2/M3 三条同落在「脚本契约」这一个用例上，但错误文本各自
指向对应注入（红名单与预测逐条对上），符合「每个红项能指回那处注入」。
