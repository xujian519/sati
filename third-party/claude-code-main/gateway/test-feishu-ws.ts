#!/usr/bin/env bun
/**
 * Minimal Feishu WebSocket test — just SDK + event listener, no gateway overhead.
 */

const APP_ID = 'cli_a917a14208b99bde'
const APP_SECRET = 'nvWIkwu7qt5ejof68qUMJgxOLLlhzrSV'

const lark = require('@larksuiteoapi/node-sdk')

console.log('Starting minimal Feishu WebSocket test...')
console.log(`App ID: ${APP_ID}`)
console.log(`Domain: Feishu`)
console.log()

const eventDispatcher = new lark.EventDispatcher({}).register({
  'im.message.receive_v1': (data: unknown) => {
    console.log('\n★★★ MESSAGE RECEIVED ★★★')
    console.log(JSON.stringify(data, null, 2))
    console.log('★★★ END ★★★\n')
  },
})

const client = new lark.WSClient({
  appId: APP_ID,
  appSecret: APP_SECRET,
  loggerLevel: lark.LoggerLevel.info,
  domain: lark.Domain.Feishu,
})

console.log('Calling client.start()...')
client.start({ eventDispatcher }).then(() => {
  console.log('client.start() resolved')
}).catch((err: unknown) => {
  console.error('client.start() error:', err)
})

console.log('Waiting for messages... Send something to the bot in 飞书.')
console.log('Press Ctrl+C to quit.\n')

process.on('SIGINT', () => {
  console.log('\nStopping...')
  client.close?.({ force: true })
  process.exit(0)
})
