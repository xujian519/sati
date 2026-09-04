# Agent Note: 配置保存事务化（原子写 + 写互斥 + 乐观锁补口）

Status: implemented

## Problem

`writeSatiConfig` 直接 `writeFile` 覆写 `~/.sati/sati.yaml`：进程在写入中崩溃会留下半截 YAML（下次启动整份配置不可用）；并发写之间无串行化——`config.js` PUT 路由有自己的 `configWriteQueue` + `baseRevision` 乐观锁，但 `memory.js` 的 `saveGlobalMemorySettings` 读改写不走该队列也无乐观锁，与设置页并发保存时后写者会静默覆盖前者的更新。移植自 PilotDeck `desktop-v2026.09.04` #546（serialize config updates + transactional saves）。

## Decision

三层修复（`ui/server/services/satiConfig.js`）：

1. **原子写**：落盘改为同目录 `${configPath}.sati-tmp` → `rename(2)`（同文件系统原子）；失败 best-effort 清理 temp、磁盘保持旧配置。temp 文件名不以 `.yaml` 结尾且 watcher 按 `configBase` 文件名过滤目录事件，不会误触发 reload。
2. **service 级写互斥**：模块内 `configWriteChain` promise 链串行化 `writeSatiConfig`/`writeRawSatiYaml` 全部落盘入口（路由层队列保留，覆盖不同调用面；链尾吞错不阻塞后续写）。
3. **乐观锁下沉为通用能力**：`configRevision`（sha256 of raw）从 config.js 迁至 service 导出；`writeSatiConfig` 增加可选 `{ previousRevision }`——锁内落盘前校验磁盘 revision，不匹配抛 `ConfigConflictError`（code `CONFIG_CONFLICT` + currentRevision）。

消费方接线：`memory.js` POST `/api/memory/settings` 接受可选 `baseRevision`（透传为 previousRevision），冲突映射 409（响应含 currentRevision，与 config.js 既有语义一致）；GET 响应附 `revision` 字段供前端取用。`config.js` 改用 service 的 `configRevision`（删除本地副本），PUT 路由逻辑不变。前端（memory 设置面板）提交 baseRevision 与 409 重试提示留作后续小改——后端已向后兼容（不带 baseRevision 时行为与旧版完全一致）。

## Alternatives considered

- **把 memory.js 挂进 config.js 的 `configWriteQueue`** — 落选：队列是 config.js 模块内变量，跨路由导出会引入隐性耦合；service 层互斥对所有入口（含未来新增路由）兜底。
- **文件锁（lockfile/flock）跨进程互斥** — 落选：ui/server 是单进程写入方；CLI/手工直改 sati.yaml 的跨进程场景本就依赖 watcher + `PilotConfigStore` last-good 兜底，进程内方案已覆盖实际竞态。
- **mtime+size 作 revision** — 落选：watcher 已用 size:mtime 做 signature 但那是去重启发式；乐观锁需要内容稳定标识（同内容重写不冲突），sha256 更正确且成本可忽略。
- **memory.js 冲突时自动重读重试（read-retry loop）** — 落选：读改写重试会吞掉"用户基于旧草稿编辑"的事实；409 暴露冲突让前端决定刷新/重试，与 config.js 行为一致。
