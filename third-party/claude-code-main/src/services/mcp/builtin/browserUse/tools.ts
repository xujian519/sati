import type { Tool } from '@modelcontextprotocol/sdk/types.js'

export const BROWSER_TOOLS: Tool[] = [
  {
    name: 'navigate',
    description: 'Navigate to a URL. Returns the page title and final URL after navigation.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'The URL to navigate to' },
        waitUntil: {
          type: 'string',
          enum: ['load', 'domcontentloaded', 'commit'],
          description: 'When to consider navigation finished. Default: domcontentloaded. Prefer domcontentloaded for SPA sites (Twitter/X, etc.).',
        },
        timeoutMs: {
          type: 'number',
          description: 'Navigation timeout in milliseconds. Default: 60000',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'screenshot',
    description:
      'Take a screenshot of the current page. Returns the image as base64-encoded PNG.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector of element to screenshot. Omit for full viewport.',
        },
        fullPage: {
          type: 'boolean',
          description: 'Capture the full scrollable page instead of just the viewport.',
        },
      },
    },
  },
  {
    name: 'snapshot',
    description:
      'Get an accessibility tree snapshot of the current page. Returns a text representation with element references (ref=...) that can be used with click, type, and other actions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector to scope the snapshot. Omit for whole page.',
        },
      },
    },
  },
  {
    name: 'click',
    description: 'Click an element on the page.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', description: 'CSS selector of element to click' },
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: 'Mouse button to use. Default: left',
        },
        doubleClick: { type: 'boolean', description: 'Double-click instead of single click' },
        position: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
          description: 'Click at specific coordinates relative to the element',
        },
      },
      required: ['selector'],
    },
  },
  {
    name: 'type',
    description: 'Type text into a focused element or a specified element.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', description: 'CSS selector of element to type into' },
        text: { type: 'string', description: 'Text to type' },
        clear: {
          type: 'boolean',
          description: 'Clear the field before typing (uses fill instead of type)',
        },
        submit: {
          type: 'boolean',
          description: 'Press Enter after typing',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'press',
    description:
      'Press a keyboard key or key combination (e.g., "Enter", "Control+a", "Meta+c").',
    inputSchema: {
      type: 'object' as const,
      properties: {
        key: {
          type: 'string',
          description:
            'Key to press. Supports Playwright key names: Enter, Tab, Escape, ArrowDown, Control+a, Meta+c, etc.',
        },
      },
      required: ['key'],
    },
  },
  {
    name: 'hover',
    description: 'Hover over an element.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', description: 'CSS selector of element to hover over' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the page or a specific element.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector of element to scroll. Omit to scroll the page.',
        },
        direction: {
          type: 'string',
          enum: ['up', 'down', 'left', 'right'],
          description: 'Direction to scroll. Default: down',
        },
        amount: {
          type: 'number',
          description: 'Pixels to scroll. Default: 500',
        },
      },
    },
  },
  {
    name: 'select',
    description: 'Select option(s) in a <select> element.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', description: 'CSS selector of the select element' },
        values: {
          type: 'array',
          items: { type: 'string' },
          description: 'Values or labels to select',
        },
      },
      required: ['selector', 'values'],
    },
  },
  {
    name: 'wait',
    description: 'Wait for a condition to be met.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector to wait for',
        },
        text: {
          type: 'string',
          description: 'Text content to wait for on the page',
        },
        url: {
          type: 'string',
          description: 'URL pattern to wait for (glob or regex)',
        },
        loadState: {
          type: 'string',
          enum: ['load', 'domcontentloaded', 'networkidle'],
          description: 'Load state to wait for',
        },
        timeoutMs: {
          type: 'number',
          description: 'Maximum time to wait in milliseconds. Default: 30000',
        },
      },
    },
  },
  {
    name: 'evaluate',
    description:
      'Execute JavaScript in the page context. Returns the serialized result.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        expression: {
          type: 'string',
          description: 'JavaScript expression or function body to evaluate',
        },
      },
      required: ['expression'],
    },
  },
  {
    name: 'tabs',
    description: 'Manage browser tabs: list, open, close, or focus.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'open', 'close', 'focus'],
          description: 'Tab action to perform',
        },
        url: {
          type: 'string',
          description: 'URL to open (for "open" action)',
        },
        index: {
          type: 'number',
          description: 'Tab index (for "close" or "focus" action)',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'upload',
    description: 'Upload file(s) to a file input element.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', description: 'CSS selector of the file input element' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute paths of files to upload',
        },
      },
      required: ['selector', 'paths'],
    },
  },
  {
    name: 'fill',
    description:
      'Clear the field and fill it with new text. Works on input, textarea, and contenteditable elements.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element' },
        value: { type: 'string', description: 'Text to fill' },
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'sleep',
    description: 'Wait for a specified number of milliseconds. Use when you need a pure time-based delay (e.g., waiting for animations or async rendering).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ms: {
          type: 'number',
          description: 'Milliseconds to wait. Default: 1000',
        },
      },
    },
  },
]
