# EdgeClaw 安装与启动教程

这份文档写给第一次接触这个项目的人。

目标只有一个：

- 让你从 0 开始，把整个 `edgeclaw-opc` 仓库安装好
- 按步骤修改配置
- 成功启动
- 在浏览器里打开并使用

先说最重要的一点：

- `edgeclaw-memory-core` 不是一个单独运行的程序
- 它是整个 `edgeclaw-opc` 项目里的记忆核心模块
- 你真正要启动的是整个仓库，而不是只启动这个文件夹

所以，下面这份教程讲的是：

- 如何把整个 `edgeclaw-opc` 项目跑起来

## 你会启动出什么

成功后你会得到：

- 一个本地代理服务：`http://localhost:18080`
- 一个 Web 界面：`http://localhost:3001`

你平时主要打开的是：

- `http://localhost:3001`

## 一、先确认你的电脑环境

推荐环境：

- macOS
- Linux
- Windows + WSL2

如果你是 Windows 用户，强烈建议：

- 先安装 WSL2
- 在 WSL2 的 Ubuntu 终端里执行下面所有命令

原因很简单：

- 仓库里有 `start.sh`
- 这类脚本在 Bash / Linux 环境里最稳定

## 二、你需要准备的东西

开始之前，你的电脑里至少要有：

- Git
- Node.js 22 或更高版本
- npm
- Bun
- 一条可用的 OpenAI 兼容 API

你可以先执行下面 4 条命令检查：

```bash
git --version
node -v
npm -v
bun -v
```

如果这 4 条命令都能输出版本号，就可以继续。

如果 `bun -v` 报错，可以安装 Bun。

macOS / Linux / WSL2：

```bash
curl -fsSL https://bun.sh/install | bash
```

Windows PowerShell：

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

如果 `node -v` 报错，先安装 Node.js 22+，再重新打开终端。

## 三、下载项目

如果你是通过 Git 拉代码：

```bash
git clone <你的仓库地址> edgeclaw-opc
cd edgeclaw-opc
```

如果你是直接下载 ZIP：

1. 先把 ZIP 解压
2. 用终端进入解压后的项目根目录 `edgeclaw-opc`

你进入项目后，执行：

```bash
pwd
```

你应该看到当前目录是整个仓库根目录，而不是 `edgeclaw-memory-core` 子目录。

仓库根目录里应该能看到这些文件夹：

```text
claude-code-main/
ui/
edgeclaw-memory-core/
.env.example
```

## 四、创建根目录 `.env`

这个项目现在只认仓库根目录的一份 `.env`。

不要创建这些文件：

- `ui/.env`
- `claude-code-main/.env`
- `edgeclaw-memory-core/.env`

在仓库根目录执行：

macOS / Linux / WSL2：

```bash
cp .env.example .env
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env
```

执行完以后，仓库根目录会出现一个新的 `.env` 文件。

## 五、修改 `.env`

打开仓库根目录的 `.env`，至少要改这 3 个必填项：

```env
EDGECLAW_API_BASE_URL=
EDGECLAW_API_KEY=
EDGECLAW_MODEL=
```

你可以直接参考下面这个最小可用示例：

```env
EDGECLAW_API_BASE_URL=http://your-api-host:your-port
EDGECLAW_API_KEY=your_api_key
EDGECLAW_MODEL=your_model_name

EDGECLAW_PROXY_PORT=18080
SERVER_PORT=3001
VITE_PORT=5173
HOST=0.0.0.0
CONTEXT_WINDOW=160000
EDGECLAW_MEMORY_ENABLED=1
```

请注意这几个点：

- `EDGECLAW_API_BASE_URL` 不要带末尾 `/v1`
- `EDGECLAW_API_KEY` 填你自己的 key
- `EDGECLAW_MODEL` 填你真正要用的模型名
- `EDGECLAW_MEMORY_ENABLED=1` 表示开启记忆功能
- 如果你不想开记忆，可以写成 `EDGECLAW_MEMORY_ENABLED=0`

如果你只想先跑通项目，通常只改这三项就够了：

```env
EDGECLAW_API_BASE_URL=...
EDGECLAW_API_KEY=...
EDGECLAW_MODEL=...
```

## 六、安装依赖

下面这些命令请一行一行执行。

### 1. 安装 `edgeclaw-memory-core` 依赖并构建

```bash
cd edgeclaw-memory-core
npm install
npm run build
cd ..
```

这一步的作用是：

- 安装记忆核心模块依赖
- 把 TypeScript 编译到 `lib/`

如果你以后修改了 `edgeclaw-memory-core/src/` 里的源码，也要重新执行一次：

```bash
cd edgeclaw-memory-core
npm run build
cd ..
```

### 2. 安装 `claude-code-main` 依赖

```bash
cd claude-code-main
bun install
cd ..
```

### 3. 安装 `ui` 依赖

```bash
cd ui
npm install
cd ..
```

## 七、启动项目

推荐使用两个终端窗口。

### 终端 1：启动本地代理

在项目根目录执行：

```bash
cd claude-code-main
bun run proxy.ts
```

你看到下面这种信息，就说明代理启动成功了：

```text
[proxy] Anthropic→OpenAI proxy listening on http://localhost:18080
```

这个终端要保持打开，不要关。

### 终端 2：启动 Web 服务

重新打开一个终端，进入项目根目录后执行：

```bash
cd ui
npm run build
npm run server
```

你看到类似下面的信息，就说明 Web 服务启动成功了：

```text
CloudCLI Server - Ready
Server URL: http://localhost:3001
```

这个终端也要保持打开，不要关。

## 八、打开浏览器

打开浏览器访问：

```text
http://localhost:3001
```

如果一切正常，你应该能看到 CloudCLI 的页面。

## 九、如何确认真的启动成功

你可以额外执行下面两个检查命令。

### 检查代理

```bash
curl http://127.0.0.1:18080/health
```

正常应该返回：

```text
ok
```

### 检查 Web 服务

```bash
curl http://127.0.0.1:3001/health
```

正常应该返回一段 JSON，例如：

```json
{"status":"ok"}
```

## 十、以后改了 `.env` 怎么重启

只要你改了仓库根目录 `.env`，就需要重启服务。

重启方式：

1. 回到刚才那两个终端
2. 分别按 `Ctrl + C`
3. 再重新执行这两组命令

终端 1：

```bash
cd claude-code-main
bun run proxy.ts
```

终端 2：

```bash
cd ui
npm run build
npm run server
```

## 十一、如果你要做前端开发

如果你不是单纯使用，而是要改前端页面，可以把第二个终端换成开发模式：

```bash
cd ui
npm run dev
```

这时地址会变成：

- 页面：`http://localhost:5173`
- 后端接口：`http://localhost:3001`

但如果你只是想“最简单地跑起来”，仍然推荐你用上一节的方式：

```bash
npm run build
npm run server
```

因为这样浏览器只需要看一个端口：

- `http://localhost:3001`

## 十二、常见问题

### 1. `bun: command not found`

说明 Bun 没装好，先安装 Bun，再重新打开终端。

### 2. `node: command not found`

说明 Node.js 没装好，先安装 Node.js 22+，再重新打开终端。

### 3. `Missing required EdgeClaw configuration`

说明你的根目录 `.env` 里缺少必填项。

至少补齐这三个：

```env
EDGECLAW_API_BASE_URL=...
EDGECLAW_API_KEY=...
EDGECLAW_MODEL=...
```

### 4. 打开 `3001` 没页面

先检查这两个终端是不是都还在运行：

- `claude-code-main` 的代理终端
- `ui` 的 Web 终端

然后执行：

```bash
curl http://127.0.0.1:18080/health
curl http://127.0.0.1:3001/health
```

只要有一个不通，就说明对应服务没起来。

### 5. 端口被占用了

如果 `3001` 或 `18080` 被其他程序占用，可以先查占用进程：

```bash
lsof -i :3001
lsof -i :18080
```

然后结束对应进程：

```bash
kill <PID>
```

或者直接改根目录 `.env`：

```env
EDGECLAW_PROXY_PORT=18081
SERVER_PORT=3002
```

改完后重启服务。

### 6. 为什么我不能只启动 `edgeclaw-memory-core`

因为它只是记忆核心模块，本身不是独立 Web 服务。

你必须通过下面两个宿主之一来用它：

- `claude-code-main`
- `ui`

在这个仓库里，最常见的实际启动方式就是本文写的：

- `bun run proxy.ts`
- `npm run server`

## 十三、最短启动清单

如果你已经安装过依赖，以后最短只需要这几步：

### 第一次配置

```bash
cp .env.example .env
```

然后编辑根目录 `.env`，填入：

```env
EDGECLAW_API_BASE_URL=...
EDGECLAW_API_KEY=...
EDGECLAW_MODEL=...
```

### 第一次安装

```bash
cd edgeclaw-memory-core
npm install
npm run build
cd ..

cd claude-code-main
bun install
cd ..

cd ui
npm install
cd ..
```

### 每次启动

终端 1：

```bash
cd claude-code-main
bun run proxy.ts
```

终端 2：

```bash
cd ui
npm run build
npm run server
```

浏览器打开：

```text
http://localhost:3001
```

## 十四、补充说明

- 当前仓库唯一有效配置入口是仓库根目录 `.env`
- 不要再创建子目录 `.env`
- `edgeclaw-memory-core` 默认随整个项目一起工作
- 如果你改了记忆核心源码，要记得重新执行 `npm run build`

如果你现在已经在仓库根目录，可以直接从这里开始：

```bash
cp .env.example .env
```

然后编辑 `.env`，再继续往下执行本文命令即可。
