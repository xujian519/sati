# XHS Header Generator — Setup Guide (PilotDeck)

One-click generate Xiaohongshu (小红书) header images from a brief:
search the web, screenshot pages, compose HTML layout, render PNG, push to Figma.

## Prerequisites

- [PilotDeck](https://github.com/pilotdeck/pilotdeck) installed
- Google Chrome (for headless screenshots)
- Node.js 22+

## Step 1: Copy files

```bash
mkdir -p ~/.pilotdeck/skills/brief-to-xhs-header
cp -r skills/brief-to-xhs-header/* ~/.pilotdeck/skills/brief-to-xhs-header/
```

## Step 2: Configure pilotdeck.yaml

Ensure your `~/.pilotdeck/pilotdeck.yaml` has a model provider configured. The skill uses PilotDeck's built-in `web_search` and `bash` tools.

## Step 3: Test

```bash
# Start PilotDeck and send a test message:
# "帮我生成一张 VoxCPM2 的小红书头图，搜一下相关信息然后截图 GitHub 页面"
```

Output PNG will be at `./xhs-output/output.png` (direct mode) or `/tmp/xhs-workspace/header/output.png` (orchestration mode).

## Chrome path

The skill assumes Chrome is at the macOS default path:

```
/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
```

On Linux, change the path in your prompt to:

```
google-chrome --headless=new --disable-gpu --no-sandbox --screenshot=...
```

## Figma integration (optional)

If you have a Figma MCP server configured, the skill can push designs to Figma.
Configure the Figma MCP server in your PilotDeck MCP settings.

## Troubleshooting

| Problem                                | Fix                                                             |
| -------------------------------------- | --------------------------------------------------------------- |
| Chrome screenshot times out            | Increase bash timeout                                           |
| `web_search` fails                     | Check your search API configuration                             |
| Figma capture times out                | Ensure browser is visible, not headless                         |

## File structure

```
~/.pilotdeck/
├── pilotdeck.yaml                        ← config
└── skills/
    └── brief-to-xhs-header/
        ├── SKILL.md                      ← design rules + recipes
        ├── SETUP.md                      ← this file
        ├── examples/x-card.html
        └── scripts/scrape-tweet.sh
```
