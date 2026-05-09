# Cron 模块当前实现

`src/cron/` 是 PilotDeck 当前的定时任务子系统。它运行在 `pilotdeck server` 进程内，通过 Gateway 管理面创建、列出、删除和停止任务；任务触发时仍通过 `Gateway.submitTurn()` 进入普通 `AgentSession`，不绕过权限、上下文、工具或 transcript。

## 模块结构

```text
src/cron/
  config/parseCronConfig.ts       cron.enabled / timezone / maxConcurrentRuns
  protocol/types.ts               CronTask / CronRunRecord / create/list/delete/stop 输入输出
  runtime/CronRuntime.ts          生命周期入口，绑定 Gateway、注册工具、管理 active runs
  runtime/CronScheduler.ts        tick 循环、并发限制、due task 触发
  runtime/CronFire.ts             单次任务执行，调用 Gateway.submitTurn/abortTurn
  runtime/CronSchedule.ts         once 与 cron expression 的下一次运行时间计算
  storage/CronPaths.ts            PilotHome 下的 cron 路径解析
  storage/CronTaskStore.ts        task JSON 与 run history JSONL 持久化
  tool/                          cron_create / cron_list / cron_delete / cron_stop 工具
```

## 配置

`pilot/config` 已接入顶层 `cron` 段：

```yaml
cron:
  enabled: true
  timezone: UTC
  maxConcurrentRuns: 1
```

不配置 `cron` 时不会创建 Cron runtime；配置后 `src/cli/pilotdeck.ts` 的 `server` 子命令会创建 `CronRuntime`、把 `cron_*` 工具合入每个项目的 `ToolRegistry`，并把 Gateway 的 `cronCreate` / `cronList` / `cronDelete` / `cronStop` 方法接到该 runtime。

## CLI 与 Gateway

`pilotdeck cron` 命令需要已有 `pilotdeck server`：

```text
pilotdeck cron list [--history] [--limit <n>]
pilotdeck cron create --session <sessionKey> --message <text> (--once <iso> | --cron <expr>) [--channel <key>] [--project <path>] [--timezone <tz>]
pilotdeck cron delete <taskId> [--stop-running]
pilotdeck cron stop <taskId>
pilotdeck cron stop --run <runId>
```

Gateway 和 WS 协议包含对应方法：

```text
cron_create
cron_list
cron_delete
cron_stop
```

这些方法是 server 管理面，不是独立 HTTP daemon；远端客户端通过 `RemoteGateway` 还原成同名 `Gateway` 方法。

## 测试

当前测试位于 `tests/cron/`：

- `parse-cron-config.test.ts`
- `cron-task-store.test.ts`
- `cron-scheduler.test.ts`
- `cron-runtime.test.ts`
- `cron-tools.test.ts`
- `load-pilot-config-cron.test.ts`

根项目验证命令：

```text
npm run build
npm test
```
