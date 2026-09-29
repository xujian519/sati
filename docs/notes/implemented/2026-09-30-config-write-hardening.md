# Agent Note: 配置写盘四点加固（软链目标 / fsync / 提交后抑制 watcher / 稳定读）

Status: implemented

## Problem

`writeSatiConfig` 的原子写（temp + rename）只保证了"不会写出半截 YAML"，但另有四处漏点：

1. **软链被换成普通文件**：`~/.sati/sati.yaml` 是软链时，`rename(temp, configPath)` 会把软链替换成普通文件——把配置指向同步盘/版本库的部署会静默失去链接关系。
2. **崩溃窗口**：temp 从未 fsync，rename 也未保证目录项落盘。断电后可能得到"名字换了、内容还在页缓存里"的空/旧文件，而这正是原子写要防的。
3. **失败也抑制 watcher**：路由在写盘**之前**调 `suppressNextWatchEvent()`，于是保存失败时，紧随其后的外部变更事件会被吞掉，UI 不知道磁盘已变。
4. **基准读不是稳定读**：乐观锁的 revision 取自单次 `readSatiConfigFile()`。外部编辑器落盘途中读到半截内容，既可能造成假冲突，也可能让"半截值"成为基准。

## Decision

`writeSatiConfig` 增加 `onWriteCommitted` 回调，四点逐一落实：

- 先把配置路径解析成**真正要写的路径**（逐级跟随软链，含 ELOOP 防护），写目标而不是软链本身；
- temp 以 `open(tmp, "wx", mode)` 写入后 `handle.sync()`，再 `rename`，最后 best-effort `fsync` 目录；mode 沿用既有文件权限，新文件用 0600（配置里有凭证，不该按 umask 落到更宽）；
- `onWriteCommitted` 在 rename **之后**调用，路由把 `suppressNextWatchEvent` 传进来（`config.js` 两条写入路径 + `memory.js` 一条）；
- 乐观锁的基准读改为稳定读：连续两次读到相同内容才认账（250ms 间隔、最多 3 次），始终不稳定时按冲突失败。

I/O 原语（路径解析 / 稳定读 / 原子写）拆到 `services/satiConfigFileIo.js`：它们与"配置 schema、校验、序列化"是两件事，且能脱离一份合法配置单独测试；`satiConfig.js` 因此在架构基线豁免清单（876 行）内**不增长**。

## Alternatives considered

- **保持路由侧"写前抑制"** — 落选：抑制的含义是"这次磁盘变化是我自己造成的"，只有提交之后这个判断才成立；写前抑制把失败的保存也一并藏了。
- **`writeFile` + `rename`，不加 fsync** — 落选：断电时 rename 可能先于数据落盘，留下空文件——原子写本就是要防这个。
- **软链改成"解析出目标目录 + 原文件名"再拼路径** — 落选：等价于 `resolveConfigWritePath` 但少一层 ELOOP 防护与"路径尚不存在"的处理。
- **稳定读做成通用工具（注入 `isSame` 谓词）** — 落选：`{ exists, raw }` 就是本仓配置读的契约，为"通用"再加一层谓词只增加调用方负担。
- **只登记基线增长（`--update-baseline` +92 行）** — 落选：门禁首选拆分，而 I/O 原语本就该能独立测试，拆出去比追认增长更划算。
- **顺带收编 `gateway.js` 的 `saveYaml`（裸 `writeFileSync`，不走事务路径）** — **未做**：它是同步写、调用方也是同步的，异步化整条调用链超出本次范围，留作后续。

## Consequences

- 软链配置保持是软链；保存后 `~/.sati/sati.yaml` 仍指向原目标，内容写到目标文件。
- 崩溃窗口收窄为"数据已 fsync、目录项未落盘"；目录 fsync 失败不致命（平台/文件系统差异）。
- 保存失败不再吞掉外部变更事件。
- 带 `previousRevision` 的服务层保存多出 250ms 量级的稳定读开销；目前只有 memory 设置这一条路径走服务层乐观锁（`config.js` 在路由层用 `baseRevision` 校验，不受影响）。
- `satiConfig.js` 968 → 871 行（基线 876），新增 `satiConfigFileIo.js`；ui/server 文件数 +1。
- 已知缺口：`gateway.js` 的 `saveYaml` 仍是裸 `writeFileSync`（无锁、无原子性）。
