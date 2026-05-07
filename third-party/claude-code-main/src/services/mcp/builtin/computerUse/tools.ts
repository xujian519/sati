import type { Tool } from '@modelcontextprotocol/sdk/types.js'

export const COMPUTER_USE_TOOLS: Tool[] = [
  {
    name: 'screenshot',
    description:
      'Take a screenshot of the screen or a specific region. Returns the image as base64-encoded PNG.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        region: {
          type: 'string',
          description: 'Region to capture: "screen", "window", or coordinates "x,y,w,h"',
        },
        windowId: {
          type: 'number',
          description: 'Window ID to screenshot (use with region="window")',
        },
      },
    },
  },
  {
    name: 'see',
    description:
      'Get an annotated UI map of the current screen showing interactive elements with IDs you can use for click, type, and other actions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        app: {
          type: 'string',
          description: 'Limit to a specific application name',
        },
        windowId: {
          type: 'number',
          description: 'Specific window ID to inspect',
        },
      },
    },
  },
  {
    name: 'click',
    description: 'Click at a position or on an element identified by peekaboo see.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: {
          type: 'string',
          description: 'Element ID from peekaboo see output',
        },
        x: { type: 'number', description: 'X coordinate for absolute click' },
        y: { type: 'number', description: 'Y coordinate for absolute click' },
        button: {
          type: 'string',
          enum: ['left', 'right'],
          description: 'Mouse button. Default: left',
        },
        doubleClick: { type: 'boolean', description: 'Double-click' },
        query: {
          type: 'string',
          description: 'Text query to find and click on',
        },
      },
    },
  },
  {
    name: 'type',
    description: 'Type text using the keyboard.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Text to type' },
      },
      required: ['text'],
    },
  },
  {
    name: 'press',
    description:
      'Press a single key (e.g., "return", "tab", "escape", "space", "delete").',
    inputSchema: {
      type: 'object' as const,
      properties: {
        key: { type: 'string', description: 'Key name to press' },
      },
      required: ['key'],
    },
  },
  {
    name: 'hotkey',
    description:
      'Press a keyboard shortcut (e.g., "command+c", "control+shift+t").',
    inputSchema: {
      type: 'object' as const,
      properties: {
        keys: {
          type: 'string',
          description: 'Key combination with + separator (e.g., "command+c")',
        },
      },
      required: ['keys'],
    },
  },
  {
    name: 'scroll',
    description: 'Scroll at a position or the current location.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        direction: {
          type: 'string',
          enum: ['up', 'down', 'left', 'right'],
          description: 'Scroll direction. Default: down',
        },
        amount: {
          type: 'number',
          description: 'Number of scroll clicks. Default: 3',
        },
        x: { type: 'number', description: 'X coordinate to scroll at' },
        y: { type: 'number', description: 'Y coordinate to scroll at' },
      },
    },
  },
  {
    name: 'drag',
    description: 'Drag from one position to another.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        startX: { type: 'number', description: 'Start X coordinate' },
        startY: { type: 'number', description: 'Start Y coordinate' },
        endX: { type: 'number', description: 'End X coordinate' },
        endY: { type: 'number', description: 'End Y coordinate' },
      },
      required: ['startX', 'startY', 'endX', 'endY'],
    },
  },
  {
    name: 'window',
    description: 'List, focus, resize, or move windows.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'focus', 'resize', 'move', 'minimize', 'maximize'],
          description: 'Window action',
        },
        windowId: { type: 'number', description: 'Target window ID' },
        app: { type: 'string', description: 'Target application name' },
        width: { type: 'number', description: 'New width (for resize)' },
        height: { type: 'number', description: 'New height (for resize)' },
        x: { type: 'number', description: 'New X position (for move)' },
        y: { type: 'number', description: 'New Y position (for move)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'app',
    description: 'Launch, quit, or focus applications.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['launch', 'quit', 'focus', 'list'],
          description: 'Application action',
        },
        name: {
          type: 'string',
          description: 'Application name (e.g., "Safari", "Terminal")',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'clipboard',
    description: 'Read or write the system clipboard.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'write'],
          description: 'Clipboard action',
        },
        text: {
          type: 'string',
          description: 'Text to write to clipboard (for "write" action)',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'menu',
    description: 'Interact with application menus.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        app: {
          type: 'string',
          description: 'Application name',
        },
        menuItem: {
          type: 'string',
          description: 'Menu item path (e.g., "File > Save")',
        },
        action: {
          type: 'string',
          enum: ['list', 'click'],
          description: 'Menu action. Default: click',
        },
      },
    },
  },
]
