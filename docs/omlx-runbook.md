# oMLX 运行手册（oMLX runbook）

> 定位：Sati 语义检索（embedding / rerank）本机端点 oMLX 的**运维手册**——「变慢时检查 oMLX 队列」的诊断三步、模型常驻/冷加载判读、重启判据与步骤。
> 事实源分工：Sati 侧超时配置在 `~/.sati/sati.yaml`（`memory.embedding.timeoutMs` / `memory.embedding.rerank.timeoutMs`）；oMLX 配置在 `~/.omlx/settings.json`；服务日志在 `~/.omlx/logs/`；Sati 侧日志在 `~/.sati/desktop.server.log`。

## 0. 本机 oMLX 形态（速查）

| 项 | 值 |
|---|---|
| 应用 | `/Applications/oMLX.app`（内嵌 Python 3.11 + MLX，非 CLI） |
| 端点 | `http://127.0.0.1:8000/v1`（OpenAI 兼容） |
| 配置 | `~/.omlx/settings.json`（API key 在 `auth.api_key`；Sati 侧对应 `~/.sati/sati.yaml` 的 `memory.embedding.apiKey`） |
| 日志 | `~/.omlx/logs/server.log`（按天轮转，保留 7 天） |
| 统计 | `~/.omlx/stats.json`（累计请求数 / 每模型 token 与耗时） |
| 调度 | `max_concurrent_requests: 8`、`embedding_batch_size: 32`；**无空闲卸载**（`idle_timeout_seconds: null`，模型加载后驻留） |
| Sati 两模型 | embedding=`bge-m3-mlx-fp16`；rerank=`BAAI-bge-reranker-v2-m3-mlx-fp16` |

关键模型行为：**同一模型的请求串行处理**（实测 ≈152ms/批的严格 FIFO）。请求延迟 ≈ 队列深度 × 单批耗时——这是「检索突然变慢」最常见的原因。

## 1. 「变慢时」检查队列（诊断三步）

**① 看服务端每请求耗时（最可靠）**：

```bash
grep "Embedding: model=" ~/.omlx/logs/server.log | tail -20
```

- `in 0.1–0.5s` = 健康；`in` 数秒～30s = 队列积压（有并发方在打）。
- 单位是服务端**完整处理时间**（含排队）；Sati 侧 30s 超时放弃时服务端可能仍在跑完。

**② 看错误**：

```bash
grep "→ 500" ~/.omlx/logs/server.log | tail
```

- `[metal::malloc] Attempting to allocate ... greater than the maximum allowed buffer size` = 并发风暴下 oMLX 内部大分配失败（2026-10-03 / 10-05 / 10-10 各出现过，均与并发请求风暴同窗）。连续出现即按 §3 处理。

**③ 空载对照（区分 oMLX 慢还是 Sati 慢）**：

```bash
KEY=$(python3 -c "import json;print(json.load(open('$HOME/.omlx/settings.json'))['auth']['api_key'])")
time curl -s http://127.0.0.1:8000/v1/embeddings \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"bge-m3-mlx-fp16","input":["健康检查"]}' -o /dev/null
```

- `<1s` = oMLX 健康 → 慢在 Sati 侧或队列中还有别的调用方（看 `~/.sati/desktop.server.log` 的检索日志与 `[projects] getProjects` 等 metrics 行）；
- 数秒+ 且连续两次都慢 → 进入 §3；

rerank 同理：`POST /v1/rerank`，body `{"model":"BAAI-bge-reranker-v2-m3-mlx-fp16","query":"...","documents":["..."]}`。

## 2. 模型常驻与冷加载判读

- oMLX **无空闲卸载设置**：模型加载后驻留内存（实测热态单批 0.3s）。
- 冷加载判据：长时间无人调用（或内存压力驱逐）后**首个请求 >2–3s**（探针实测冷模型首请求 ≈3.0s），第二个请求应恢复 <1s。
- 「避免换页/冷加载」实践：使用期间自然保热；机器内存吃紧（大模型常驻 + 浏览器多开）时 `memory_guard`（balanced，soft 0.85）可能驱逐模型 → 表现为「检索突然变慢」→ 用 §1③ 复测两次即可区分「冷加载」与「真拥塞」。
- 怀疑端点健康但无从确认时：直接跑 §1③ 两次，第二次 <1s 即模型热态正常。

## 3. 重启判据与步骤

**判据**（满足任一）：

1. 空载单请求连续两次 >5s（已排除冷加载：第一次慢、第二次仍慢）；
2. `server.log` 连续出现 `→ 500`（尤其 metal::malloc）且空载复测仍复现；
3. 日志长时间无新行，但 Sati 侧检索持续报超时。

**步骤**：

1. 菜单栏 oMLX → 退出，重新打开 App（`auto_start_on_launch: true`，重开即恢复 8000 端口服务）；
2. 重开后跑 §1③ 复测：首个请求若含冷加载偏慢属正常，**第二次应 <1s**；
3. 若重启后仍不达标，检查 `~/.omlx/logs/server.log` 新错误与 `~/.omlx/stats.json` 请求量，再决定是否升级 oMLX.app。

## 4. 与 Sati 侧的关系（2026-10-10 削峰）

- Sati 已把「每个项目运行时装配各发一次一致性自检」改为**进程内去重**（同 knowledge.db + 同端点单次）+ **5s 短超时**——启动不再向 oMLX 扇出 N 并发（见 `docs/notes/implemented/2026-10-10-desktop-slowness-storm-shedding.md`）。
- 复测对照（同日）：17:16–17:18 旧代码启动风暴窗，oMLX 侧 embedding `in 29–30s` + 6 次 500；17:19 之后新代码，**0 次 500，自检单批 8 锚点 `in 0.345s`**。
- Sati 侧超时（`~/.sati/sati.yaml`）：embedding `8000ms` / rerank `5000ms`（均 ≤ `memory.retrievalTimeoutMs: 8000`）——拥塞时 Sati 端 8s/5s 内自动降级（熔断 → 关键词/FTS），不再逐请求等满 30s。
- 一致性自检为**进程内一次性**（成功/失败均缓存不重检）：启动时若自检因拥塞超时告警，oMLX 恢复后信号不会自愈——需**重启 gateway**（桌面 App 退出重开）重新探测。

## 5. 命令小抄

```bash
# 最近 embedding/rerank 服务端耗时
grep -E "Embedding: model=|in [0-9.]+s$" ~/.omlx/logs/server.log | tail -20
# 今日错误
grep "$(date +%F)" ~/.omlx/logs/server.log | grep "→ 500" | tail
# 每模型累计
python3 -c "import json;s=json.load(open('$HOME/.omlx/stats.json'));[print(k,v.get('requests')) for k,v in s['per_model'].items()]"
```
