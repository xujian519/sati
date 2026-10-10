# Agent Note: 配置写盘外科化与读写一致性（gateway 路由收口 / CAS / 软链 watcher）

Status: implemented

补记：本 note 于 2026-10-10 补写——变更随 PR #610 于 2026-10-07 落地，当时未附 note。评估背景见 `docs/pilotdeck-2026-10-upstream-port-plan.md` 批次 A / B。

## Problem

`ui/server` 里两条配置写路径并存，事务性只有一条：

1. **裸写**：`ui/server/routes/gateway.js` 的 `saveYaml` 是 `writeFileSync`——无 temp+rename、无 fsync、无写锁，且 7 处 read-modify-write 调用点（feishu 的 qr-poll / save / disable、weixin 的 disable、wecom 的 qr-poll / save / disable）全在共享写锁之外。进程崩溃，或 IM 配置保存与设置页保存并发，都会产生截断或互相覆盖的 `sati.yaml`。前一条 note（`2026-09-30-config-write-hardening.md`）把这条记为「已知缺口」。
2. **事务路径**：`writeSatiConfig` 稳定读 + 进程内串行 + temp/rename + fsync。但它同时做 `validateSatiConfig` → `normalizeSatiConfig`，会把 `buildDefaultSatiConfig` 的默认值**物化**进用户文件（`memory.enabled: true`、`router.enabled: false` …）并整份重排（schema 顺序）。

把 1 直接改走 2 就是把「只改一个键」的 IM 配置保存换成一次「默认值物化 + 全文重排」，用户手写的注释、缩进与键序会被洗掉。

另有三个读侧漏点：

- **乐观锁对「只改密钥」的外部编辑失明**：GET 返回的 `revision` 取自 mask 之后的 YAML，外部编辑器只改 apiKey 时掩码视图不变 ⇒ 客户端草稿不会失效。
- **预检在锁外**：`PUT /` 的 revision 预检与落盘之间仍可插入外部编辑（TOCTOU），写盘那一步不传 `previousRevision` 就没有第二道关卡。
- **软链配置读写不对称**：写路径已 `resolveConfigWritePath` 跟随软链目标，而 watcher 只 `fs.watch` 软链所在目录——外部编辑器改**目标**文件不产生任何事件，热重载静默失效。

## Decision

新增 `ui/server/services/satiConfigUpdate.js` 的 `updateSatiConfig(mutate, { paths, onWriteCommitted })`，作为「只改几个键、其余按字节保留」的第三形态：

- 稳定读磁盘原始 YAML → 交给 `mutate` 就地修改（返回 `false` 表示无需落盘）；
- 用 `parseDocument(raw, { keepSourceTokens: true })` 重建文档，只 `setIn` / `deleteIn` `paths` 声明过的键，其余字节不动——注释、行尾注释、键序都保住；缩进按**文档内出现次数最多**的宽度（2..8）还原（`doc.toString({ indent })` 是文档级参数，取众数只让少数派被对齐）；
- 事务性与 `writeSatiConfig` 一致：进程内串行 + 写前 `expectedRevision = configRevision(disk.raw)` 的 CAS；冲突（外部编辑落在读与写之间）时**重读并把本地改动重放到新内容上**（最多 3 次），两侧改动都保留，重试耗尽才抛 `CONFIG_CONFLICT`（路由映射 409，`config.test.js` 有专项用例）。

配套收口：

- `gateway.js` 的 7 处调用点统一走 `persistConfigAndReload(mutate, paths)`，`onWriteCommitted` 传 `suppressNextWatchEvent`（抑制的含义是「这次磁盘变化是我自己造成的」，只有提交之后才成立）；`gateway.js` 里不再有裸写。
- 首启默认配置写入（`ui/server/routes/config.js`）改走 `writeConfigAtomically`——裸 `writeFile` 崩在半路会留下半截 YAML，下次读取把它当成损坏配置。
- GET / PUT 的 `revision` 一律取 `configRevision(record.raw)`（**未掩码**原文）；`PUT /` 把 `baseRevision` 作为 `previousRevision` 传进写盘层，CAS 因此覆盖「预检 → 落盘」窗口。
- watcher 用 `collectWatchTargets` 收集两个目标——软链自身（它可能被指向别处）与 `resolveConfigWritePath` 解析出的真实文件——两个目录都 watch，读写对称。

单列一个模块是因为 `satiConfig.js` 已触 file-size 棘轮（`docs/technical-debt/architecture-baseline.json`），而该能力只依赖 I/O 原语，与配置 schema / 校验无关。

## Alternatives considered

- **把 `gateway.js` 直接改走 `writeSatiConfig`** — 落选：默认值物化 + 全文重排（丢注释/缩进/键序）。这是本批最大的代价，也是外科写存在的唯一理由。
- **保留裸 `writeFileSync`，只加写锁** — 落选：锁只防并发，崩在 rename 之前照样留下半截文件——原子写本就为防这个。
- **缩进统一成 2 空格（或取文档内最小缩进）** — 落选：两者都会重排全文；取众数只影响少数派块。
- **冲突时直接 409 让用户重试** — 落选：IM 渠道的 qr-poll 保存是自动路径（用户不在场），重放本地改动能让两边都保留。
- **只在软链所在目录 watch** — 落选：写目标是别处的真实文件，外部编辑目标时无事件，热重载静默失效。
- **把外科写与 I/O 原语都留在 `satiConfig.js`** — 落选：已触棘轮且职责不同（schema/校验 vs. I/O），拆分还能脱离一份合法配置单独测试。

## Consequences

- IM 配置保存不再整份重写：用户注释、行尾注释与键序保留；混宽缩进的文档里少数派块会被对齐到众数宽度。
- 所有配置写入都在「稳定读 + 进程内串行 + 写前 CAS + temp/rename + fsync」之下；`gateway.js` 的裸写缺口关闭（`2026-09-30-config-write-hardening.md` 的末行相应更新）。
- 写面收窄：`updateSatiConfig` 要求调用方**显式声明** `paths`，未声明的键不会写入。
- 代价：每次外科写多一次稳定读（仅在内容持续变化时才付 250ms 量级等待）；`revision` 改取未掩码原文会让「读草稿 → 外部只改密钥 → 保存」这一类请求首次出现 409，属预期语义修正。
- 已知缺口：`model.providers[*]` 等结构化编辑仍走 `writeSatiConfig`（默认值物化与重排的代价照付）——本批只把「只改少数键」的路径搬出，未改结构化编辑的语义。
