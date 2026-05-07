import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { COMPUTER_USE_TOOLS } from './tools.js'
import {
  isPeekabooAvailable,
  runPeekaboo,
  checkPermissions,
} from './peekaboo.js'

export async function createComputerUseMcpServerInstance(): Promise<Server> {
  const server = new Server(
    { name: 'computer-use', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const available = await isPeekabooAvailable()
    if (!available) {
      return {
        tools: [
          {
            name: 'setup_instructions',
            description:
              'Peekaboo is not installed. Install it with: brew install steipete/tap/peekaboo. Then grant Screen Recording and Accessibility permissions in System Settings > Privacy & Security.',
            inputSchema: { type: 'object' as const, properties: {} },
          },
        ],
      }
    }

    const perms = await checkPermissions()
    if (!perms.screenRecording || !perms.accessibility) {
      const missing = []
      if (!perms.screenRecording) missing.push('Screen Recording')
      if (!perms.accessibility) missing.push('Accessibility')
      return {
        tools: [
          {
            name: 'grant_permissions',
            description: `Peekaboo needs macOS permissions: ${missing.join(', ')}. Grant them in System Settings > Privacy & Security.`,
            inputSchema: { type: 'object' as const, properties: {} },
          },
        ],
      }
    }

    return { tools: COMPUTER_USE_TOOLS }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    try {
      const result = await handleToolCall(name, args ?? {})
      return { content: result }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      }
    }
  })

  return server
}

type ContentItem =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<ContentItem[]> {
  switch (name) {
    case 'screenshot':
      return handleScreenshot(args)
    case 'see':
      return handleSee(args)
    case 'click':
      return handleClick(args)
    case 'type':
      return handleType(args)
    case 'press':
      return handlePress(args)
    case 'hotkey':
      return handleHotkey(args)
    case 'scroll':
      return handleScroll(args)
    case 'drag':
      return handleDrag(args)
    case 'window':
      return handleWindow(args)
    case 'app':
      return handleApp(args)
    case 'clipboard':
      return handleClipboard(args)
    case 'menu':
      return handleMenu(args)
    case 'setup_instructions':
    case 'grant_permissions':
      return [{ type: 'text', text: 'Please follow the instructions in the tool description.' }]
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

async function handleScreenshot(args: Record<string, unknown>): Promise<ContentItem[]> {
  const extraArgs: string[] = []
  if (args.region && args.region !== 'screen') {
    extraArgs.push('--region', String(args.region))
  }
  if (args.windowId) {
    extraArgs.push('--window-id', String(args.windowId))
  }

  const result = await runPeekaboo('image', extraArgs)
  if (!result.ok) {
    throw new Error(result.stderr || 'Failed to capture screenshot')
  }

  // If peekaboo returns a file path in JSON, read it
  if (result.parsed && typeof result.parsed === 'object') {
    const data = result.parsed as Record<string, unknown>
    if (data.path && typeof data.path === 'string') {
      const fs = await import('fs')
      const imgBuffer = fs.readFileSync(data.path)
      return [{ type: 'image', data: imgBuffer.toString('base64'), mimeType: 'image/png' }]
    }
    if (data.image && typeof data.image === 'string') {
      return [{ type: 'image', data: data.image, mimeType: 'image/png' }]
    }
  }

  return [{ type: 'text', text: result.stdout }]
}

async function handleSee(args: Record<string, unknown>): Promise<ContentItem[]> {
  const extraArgs: string[] = []
  if (args.app) extraArgs.push('--app', String(args.app))
  if (args.windowId) extraArgs.push('--window-id', String(args.windowId))

  const result = await runPeekaboo('see', extraArgs)
  if (!result.ok) {
    throw new Error(result.stderr || 'Failed to get UI snapshot')
  }

  return [{ type: 'text', text: result.stdout }]
}

async function handleClick(args: Record<string, unknown>): Promise<ContentItem[]> {
  const extraArgs: string[] = []

  if (args.id) {
    extraArgs.push('--id', String(args.id))
  } else if (args.x !== undefined && args.y !== undefined) {
    extraArgs.push('--x', String(args.x), '--y', String(args.y))
  } else if (args.query) {
    extraArgs.push('--query', String(args.query))
  }

  if (args.button === 'right') extraArgs.push('--right')
  if (args.doubleClick) extraArgs.push('--double')

  const result = await runPeekaboo('click', extraArgs)
  if (!result.ok) {
    throw new Error(result.stderr || 'Click failed')
  }

  return [{ type: 'text', text: result.stdout || JSON.stringify({ ok: true }) }]
}

async function handleType(args: Record<string, unknown>): Promise<ContentItem[]> {
  const text = args.text as string
  const result = await runPeekaboo('type', [text])
  if (!result.ok) {
    throw new Error(result.stderr || 'Type failed')
  }
  return [{ type: 'text', text: result.stdout || JSON.stringify({ ok: true }) }]
}

async function handlePress(args: Record<string, unknown>): Promise<ContentItem[]> {
  const key = args.key as string
  const result = await runPeekaboo('press', [key])
  if (!result.ok) {
    throw new Error(result.stderr || 'Key press failed')
  }
  return [{ type: 'text', text: result.stdout || JSON.stringify({ ok: true }) }]
}

async function handleHotkey(args: Record<string, unknown>): Promise<ContentItem[]> {
  const keys = args.keys as string
  const result = await runPeekaboo('hotkey', [keys])
  if (!result.ok) {
    throw new Error(result.stderr || 'Hotkey failed')
  }
  return [{ type: 'text', text: result.stdout || JSON.stringify({ ok: true }) }]
}

async function handleScroll(args: Record<string, unknown>): Promise<ContentItem[]> {
  const extraArgs: string[] = []
  const direction = (args.direction as string) ?? 'down'
  const amount = (args.amount as number) ?? 3

  extraArgs.push('--direction', direction)
  extraArgs.push('--amount', String(amount))
  if (args.x !== undefined) extraArgs.push('--x', String(args.x))
  if (args.y !== undefined) extraArgs.push('--y', String(args.y))

  const result = await runPeekaboo('scroll', extraArgs)
  if (!result.ok) {
    throw new Error(result.stderr || 'Scroll failed')
  }
  return [{ type: 'text', text: result.stdout || JSON.stringify({ ok: true }) }]
}

async function handleDrag(args: Record<string, unknown>): Promise<ContentItem[]> {
  const result = await runPeekaboo('drag', [
    '--from', `${args.startX},${args.startY}`,
    '--to', `${args.endX},${args.endY}`,
  ])
  if (!result.ok) {
    throw new Error(result.stderr || 'Drag failed')
  }
  return [{ type: 'text', text: result.stdout || JSON.stringify({ ok: true }) }]
}

async function handleWindow(args: Record<string, unknown>): Promise<ContentItem[]> {
  const action = args.action as string
  const extraArgs: string[] = []

  switch (action) {
    case 'list':
      if (args.app) extraArgs.push('--app', String(args.app))
      break
    case 'focus':
    case 'minimize':
    case 'maximize':
      if (args.windowId) extraArgs.push('--window-id', String(args.windowId))
      else if (args.app) extraArgs.push('--app', String(args.app))
      break
    case 'resize':
      if (args.windowId) extraArgs.push('--window-id', String(args.windowId))
      if (args.width) extraArgs.push('--width', String(args.width))
      if (args.height) extraArgs.push('--height', String(args.height))
      break
    case 'move':
      if (args.windowId) extraArgs.push('--window-id', String(args.windowId))
      if (args.x !== undefined) extraArgs.push('--x', String(args.x))
      if (args.y !== undefined) extraArgs.push('--y', String(args.y))
      break
  }

  const result = await runPeekaboo('window', [action, ...extraArgs])
  if (!result.ok) {
    throw new Error(result.stderr || `Window ${action} failed`)
  }
  return [{ type: 'text', text: result.stdout || JSON.stringify({ ok: true }) }]
}

async function handleApp(args: Record<string, unknown>): Promise<ContentItem[]> {
  const action = args.action as string
  const extraArgs: string[] = []

  if (args.name && action !== 'list') {
    extraArgs.push(String(args.name))
  }

  const result = await runPeekaboo('app', [action, ...extraArgs])
  if (!result.ok) {
    throw new Error(result.stderr || `App ${action} failed`)
  }
  return [{ type: 'text', text: result.stdout || JSON.stringify({ ok: true }) }]
}

async function handleClipboard(args: Record<string, unknown>): Promise<ContentItem[]> {
  const action = args.action as string

  if (action === 'write') {
    const text = args.text as string
    if (!text) throw new Error('text is required for clipboard write')
    const result = await runPeekaboo('clipboard', ['write', text])
    if (!result.ok) throw new Error(result.stderr || 'Clipboard write failed')
    return [{ type: 'text', text: JSON.stringify({ ok: true }) }]
  }

  // read
  const result = await runPeekaboo('clipboard', ['read'])
  if (!result.ok) throw new Error(result.stderr || 'Clipboard read failed')
  return [{ type: 'text', text: result.stdout }]
}

async function handleMenu(args: Record<string, unknown>): Promise<ContentItem[]> {
  const extraArgs: string[] = []
  const action = (args.action as string) ?? 'click'

  if (args.app) extraArgs.push('--app', String(args.app))

  if (action === 'list') {
    const result = await runPeekaboo('menu', ['list', ...extraArgs])
    if (!result.ok) throw new Error(result.stderr || 'Menu list failed')
    return [{ type: 'text', text: result.stdout }]
  }

  // click
  if (!args.menuItem) throw new Error('menuItem is required for menu click')
  extraArgs.push(String(args.menuItem))
  const result = await runPeekaboo('menu', ['click', ...extraArgs])
  if (!result.ok) throw new Error(result.stderr || 'Menu click failed')
  return [{ type: 'text', text: result.stdout || JSON.stringify({ ok: true }) }]
}
