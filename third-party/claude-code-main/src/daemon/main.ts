import { assertCronDaemonOk, sendCronDaemonRequest } from './ipc.js'
import { CronDaemonServer } from './server.js'

export async function daemonMain(args: string[]): Promise<void> {
  const subcommand = args[0] ?? 'serve'

  switch (subcommand) {
    case 'serve': {
      const server = new CronDaemonServer()
      await server.start()
      const shutdown = async () => {
        await server.stop()
        process.exit(0)
      }
      process.on('SIGINT', () => {
        void shutdown()
      })
      process.on('SIGTERM', () => {
        void shutdown()
      })
      return
    }
    case 'status': {
      const response = await sendCronDaemonRequest({ type: 'ping' })
      assertCronDaemonOk(response)
      if (response.data.type !== 'pong') {
        throw new Error('Unexpected Cron daemon status response')
      }
      const { runtimes } = response.data
      if (runtimes.length === 0) {
        console.log('Cron daemon is running with no active project runtimes.')
        return
      }
      for (const runtime of runtimes) {
        console.log(
          `${runtime.projectRoot} durable=${runtime.durableCount} session_only=${runtime.sessionOnlyCount} active_workers=${runtime.activeWorkers}`,
        )
      }
      return
    }
    case 'stop': {
      const response = await sendCronDaemonRequest({ type: 'shutdown' })
      assertCronDaemonOk(response)
      console.log('Cron daemon shutdown requested.')
      return
    }
    default:
      throw new Error(
        `Unknown daemon subcommand "${subcommand}". Expected serve, status, or stop.`,
      )
  }
}
