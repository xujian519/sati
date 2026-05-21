<p align="center">
  <img src="assets/banner.png" alt="PilotDeck" width="680"/>
</p>

<p align="center">
  Task-oriented AI Agent productivity platform — redefining operational boundaries and memory evolution, one WorkSpace at a time.
</p>

<p align="center">
  <a href="http://58.57.119.12:52006/"><img src="https://img.shields.io/badge/Demo-Live-brightgreen?style=flat-square" alt="Live Demo"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-TBD-blue.svg?style=flat-square" alt="License"/></a>
  <a href="https://modelcontextprotocol.io/"><img src="https://img.shields.io/badge/MCP-Native-6366F1?style=flat-square" alt="MCP Native"/></a>
  <a href="#-desktop-app-apple-silicon"><img src="https://img.shields.io/badge/macOS-Desktop_App-000000?style=flat-square&logo=apple&logoColor=white" alt="Desktop App"/></a>
  <a href="https://github.com/Gucc111/PilotDeck/stargazers"><img src="https://img.shields.io/github/stars/Gucc111/PilotDeck?style=flat-square" alt="Stars"/></a>
  <br/>
  <a href="#-community"><img src="https://img.shields.io/badge/Discord-Join_Community-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"/></a>
  &nbsp;
  <a href="#-community"><img src="https://img.shields.io/badge/Feishu-Community-00D6B9?style=for-the-badge&logo=bytedance&logoColor=white" alt="Feishu"/></a>
  &nbsp;
  <a href="#-community"><img src="https://img.shields.io/badge/WeChat-Community-07C160?style=for-the-badge&logo=wechat&logoColor=white" alt="WeChat"/></a>
  <br/>
  <img src="https://img.shields.io/badge/Node.js-22-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js"/>
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"/>
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=white" alt="React"/>
  <img src="https://img.shields.io/badge/Vite-6-646CFF?style=flat-square&logo=vite&logoColor=white" alt="Vite"/>
  <img src="https://img.shields.io/badge/MCP-Protocol-6366F1?style=flat-square" alt="MCP"/>
</p>

<p align="center">
  <b>English</b> | <a href="./README.md">简体中文</a>
  <br/>
  <a href="http://58.57.119.12:52006/">Live Demo</a> · <a href="#-installation--quick-start">Quick Start</a> · <a href="#-key-highlights">Highlights</a> · <a href="#use-cases">Use Cases</a> · <a href="#-community">Community</a>
</p>

---

**News** 🔥

- **[2026.05.28]** PilotDeck v0.1 public beta released! Try it now at [http://58.57.119.12:52006/](http://58.57.119.12:52006/). The full WorkSpace cockpit plus the three pillars — White-box Memory, Smart Routing, and Always-on — shipped with the initial release.

---

## 💡 About PilotDeck

**PilotDeck** is an open-source agent operating system designed around the concept of "WorkSpace". It is jointly developed and open-sourced by Tsinghua University [THUNLP](https://nlp.csai.tsinghua.edu.cn/), [ModelBest](https://modelbest.cn/), [OpenBMB](https://www.openbmb.cn/), and AI9stars. Targeting general-purpose, multi-task scenarios, PilotDeck is built to be a true *productivity tool* for the Agent era.

A wave of excellent AI Agent harnesses has emerged in recent years, each with its own focus: **Claude Code / Cursor / Trae Solo** brought model reasoning deep into the programming IDE; **Claude Cowork** introduced the notion of project-level isolation to desktop-side knowledge work; **WorkBuddy** connected agents to IM ecosystems such as WeCom and Feishu so AI is one message away.

When we shift the lens from "one-shot programming" or "immediate Q&A" to **long-running, multi-project productivity work**, however, several questions remain open:

- When many projects run in parallel, can memory be **white-box and traceable**? When the AI gets something wrong, can you pinpoint which memory entry caused it and edit it directly — without starting a new chat from scratch?
- Can token cost be **tracked per task**, so that running agents in the background actually becomes economically viable?
- Can tasks of different difficulty **automatically be matched to different models**, instead of burning the flagship model on trivial calls?
- When you step away from the keyboard, can the work keep moving? Can the agent **proactively discover what's worth doing, report progress, and land results as files on disk**?

PilotDeck is an incremental exploration around exactly these questions. It uses the WorkSpace as the fundamental unit — completely isolating files, memory and skills per project — and pairs it with three pillar capabilities: **White-box Memory**, **Smart Routing** and **Always-on**. The entire system natively supports the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) and behaves consistently across front-ends (Web / CLI / IM).

### ✨ Key Highlights

<table width="100%">
<tr>
<td width="50%" valign="top">

**WorkSpace-Level Isolation & Accretion**

Every project gets its own file system, memory store and skill set. Parallel work no longer interferes with itself, retrieval has a bounded scope, and skills accrete naturally as each task grows — no more global context pollution.

</td>
<td width="50%" valign="top">

**Traceable White-box Memory**

Memory generation, extraction, storage and retrieval are visible end-to-end. When the AI mis-remembers, you can pinpoint and fix the offending entry. Built-in **Dream Mode** consolidates memory in idle windows, and supports one-click rollback.

</td>
</tr>
<tr>
<td width="50%" valign="top">

**Smart Routing & Cost Optimization**

Task difficulty is auto-detected; complex calls go to flagship models (e.g. Claude 3.5 Sonnet / GPT-4o), simple ones drop to lighter models. Through on-device / cloud co-orchestration and precise matching, token spend shrinks dramatically without sacrificing quality.

</td>
<td width="50%" valign="top">

**Always-on Background Execution**

PilotDeck breaks the "you ask, it answers" loop: after you sign off, the agent keeps discovering candidate tasks, running long-horizon monitors, and finally lands deliverables as local files with a summary report waiting for you.

</td>
</tr>
</table>

### 📊 Real-world Numbers

The three pillar capabilities have shown clear advantages in production-grade workflows:

#### 1. Smart Routing — ~70% cost savings on social-media workloads

In Xiaohongshu-style social-media operations, enabling Smart Routing automatically demotes simple polishing / layout tasks to a sub-agent (e.g. Sonnet 4.5) and only invokes Opus 4.5 at planning checkpoints:

| Setup | Model configuration | Cost | Multiplier |
| :--- | :--- | ---: | ---: |
| **Smart Routing ON** | Opus 4.5 (main) + Sonnet 4.5 (sub) | **$2.83** | **1.1×** |
| Smart Routing OFF | All Opus 4.5 (main + sub) | $12.58 | 5.0× |
| Monolithic | Single Opus 4.5 long-react (estimated) | $12.20 | 4.8× |

#### 2. Smart Routing — 1/6 the cost while beating frontier models on hard tasks

The research team benchmarked 7 complex tasks (multilingual podcast push, multi-source data reports, domain-specific literature review, codebase architecture docs, etc.). The "strong main + light sub" routing setup matches or beats the frontier single-model setup at a fraction of the cost:

| Setting | Score | Cost |
| :--- | ---: | ---: |
| MiniMax-M2.7 single-agent | 37.1 | $1.90 |
| Claude Sonnet 4.6 single-agent | 69.1 | $18.36 |
| **Sonnet 4.6 (main) + MiniMax-M2.7 (sub)** | **70.6** | **$3.15** |

#### 3. White-box Memory — layout & tone never bleed across projects

In black-box agents, mixing tasks in a shared context pool inevitably pollutes memory. PilotDeck's WorkSpace-scoped white-box memory addresses this end-to-end:

<table width="100%">
<thead>
<tr>
  <th align="left">Dimension</th>
  <th align="left">Current AI Agents (black-box)</th>
  <th align="left">PilotDeck (white-box)</th>
</tr>
</thead>
<tbody>
<tr>
  <td><b>Visibility</b></td>
  <td>You can't see what the AI remembers, only what it outputs</td>
  <td>View every memory entry: what was stored, when, and which WorkSpace</td>
</tr>
<tr>
  <td><b>Control</b></td>
  <td>Once written, memory can't be edited or removed</td>
  <td>Edit / delete entries, pin critical decisions so they don't drift</td>
</tr>
<tr>
  <td><b>Traceability</b></td>
  <td>When it goes wrong, you can't find the root cause</td>
  <td>Generation → extraction → storage → retrieval, all auditable</td>
</tr>
<tr>
  <td><b>Isolation</b></td>
  <td>One shared pool — projects bleed into each other</td>
  <td>Scoped per WorkSpace; A's memory never reaches B</td>
</tr>
<tr>
  <td><b>Reversible</b></td>
  <td>After compression, the original is gone</td>
  <td>Dream-mode supports <b>one-click rollback</b> to the prior state</td>
</tr>
</tbody>
</table>

---

## 🖥️ UI & Demo

PilotDeck ships an out-of-the-box Web UI with full WorkSpace management, white-box memory editing, and visualization of multi-agent collaboration.

### Use Cases

#### Survey the Chinese LLM market → HTML white paper

> *"Survey the Chinese LLM application market and turn it into a formal HTML white paper."*

<table width="100%">
<tr>
<td width="50%" align="center"><b>Process</b></td>
<td width="50%" align="center"><b>Result</b></td>
</tr>
<tr>
<td><img src="assets/en/ppt_en.gif" width="100%"/></td>
<td><img src="assets/result/ppt_result_en.gif" width="100%"/></td>
</tr>
</table>

#### Vibe Coding → iOS AR mini-game "Ball Finder"

> *"Walk me through building an iOS AR mini-game Ball Finder in Vibe Coding mode."*

<table width="100%">
<tr>
<td width="50%" align="center"><b>Process</b></td>
<td width="50%" align="center"><b>Result</b></td>
</tr>
<tr>
<td><img src="assets/en/iosgame_en.gif" width="100%"/></td>
<td><img src="assets/result/ios_game_result.gif" width="100%"/></td>
</tr>
</table>

#### Build a low-code embedding fine-tuning platform

> *"Build a low-code embedding fine-tuning platform from scratch."*

<table width="100%">
<tr>
<td width="50%" align="center"><b>Process</b></td>
<td width="50%" align="center"><b>Result</b></td>
</tr>
<tr>
<td><img src="assets/en/modeltraining_en.gif" width="100%"/></td>
<td><img src="assets/result/modeltrainingresult_en.gif" width="100%"/></td>
</tr>
</table>

#### English podcast → 6-language global push

> *"Push this English podcast to a global audience in Chinese / Japanese / French / Korean / Spanish / Arabic."*

**Process**

<img src="assets/en/podcast_en.gif" width="100%"/>

**Result (with audio)**

https://github.com/Gucc111/PilotDeck/raw/feat/cleanup/assets/result/podcast_result.mp4

---

## 📦 Installation & Quick Start

We provide a one-line installer for macOS / Linux, plus a source-based workflow for developers.

### Option A: One-line install (recommended, macOS / Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/Gucc111/PilotDeck/main/install.sh | bash
```

The script auto-installs Node.js 22, clones the repo, installs dependencies, and builds the frontend. Once it finishes:

```bash
pilotdeck            # starts the server at http://localhost:3001
pilotdeck status     # check runtime status
```

### Option B: From source (for developers)

**1. Clone and install dependencies**

```bash
git clone https://github.com/Gucc111/PilotDeck.git
cd PilotDeck

npm install              # root deps (Gateway runtime)
cd ui && npm install     # UI deps
cd ..
```

**2. Configure a model provider**

PilotDeck reads `~/.pilotdeck/pilotdeck.yaml`. You can create it manually, let the bootstrap script generate one, **or just open the Web UI and configure providers visually in the settings panel.**
Supported protocols include OpenAI, Anthropic, DeepSeek, Qwen, Kimi, MiniMax and other OpenAI-compatible endpoints.

```yaml
schemaVersion: 1
agent:
  model: deepseek/deepseek-v4-pro
model:
  providers:
    deepseek:
      protocol: openai
      url: https://api.deepseek.com/v1
      apiKey: sk-your-api-key
```

**3. Start the services**

```bash
cd ui && npm run dev     # dev mode (HMR), visit http://localhost:5173
# or
cd ui && npm run start   # production mode, visit http://localhost:3001
```

### 🍎 Desktop App (Apple Silicon)

For macOS users we ship a signed, Apple-notarized DMG — double-click to run, no command-line setup required.
Build and release details: [apps/desktop/RELEASING.md](apps/desktop/RELEASING.md).

---

## 🛠️ Extension Protocol

PilotDeck has an open plugin architecture with a strict boundary between the open-source core and plugin customization. Extending the system is a `plugin.json` away:

- **MCP Servers** — first-class integration with any Model Context Protocol server.
- **Tools & Skills** — register custom tools, or pull community skills via [ClawHub](https://www.npmjs.com/package/clawhub).
- **Lifecycle Hooks** — intercept `PreToolUse`, `UserPromptSubmit`, and other critical lifecycle events.
- **Custom Memory** — plug in your own memory store provider.

---

## 🤝 Contributing

Thanks to everyone who has contributed code, feedback, and ideas. New contributors are warmly welcome — let's build the next-gen agent OS together.

Workflow: **Fork → feature branch → PR**. Please make sure the unit tests and linters pass before opening a PR:

```bash
npm test
cd ui && npx vitest run
```

---

## 💬 Community

- For bugs and feature requests, please open a [GitHub Issue](https://github.com/Gucc111/PilotDeck/issues).
- For commercial collaboration, enterprise support, or open-source license discussions, please reach out via email: `team@pilotdeck.ai` <!-- TODO: replace with real contact email -->.
- Join our community channels:

<table width="100%">
<tr>
<td width="33%" align="center"><b>WeChat Community</b></td>
<td width="33%" align="center"><b>Feishu Community</b></td>
<td width="33%" align="center"><b>Discord Community</b></td>
</tr>
</table>

---

## 🏢 Joint Development

PilotDeck is jointly developed by Tsinghua University [THUNLP](https://nlp.csai.tsinghua.edu.cn/), [ModelBest](https://modelbest.cn/), [OpenBMB](https://www.openbmb.cn/) and AI9stars.

---

## ⭐ Support Us

If PilotDeck has been helpful in your work or research, please consider giving us a Star on GitHub!

---

## 📝 Citation

```bibtex
@misc{pilotdeck2026,
  title  = {PilotDeck: A WorkSpace-Centric Open-Source Agent Operating System},
  author = {THUNLP and ModelBest and OpenBMB and AI9stars},
  year   = {2026},
  note   = {Live demo: http://58.57.119.12:52006/},
  url    = {https://github.com/Gucc111/PilotDeck}
}
```

## 📄 License

The open-source license for this project is **TBD**. Until a formal license is finalized, the core code should be treated as "source-available, all rights reserved". The `products/**` directory contains customer-specific customizations and is **not** part of the open-source release scope.
