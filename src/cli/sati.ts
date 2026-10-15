#!/usr/bin/env node
/**
 * `sati` CLI 可执行入口：只负责触发分发（P2.7 起，逻辑见 `./commandDispatch.ts`）。
 *
 * 顶层错误刻意**无前缀**输出：CI/脚本按裸错误文本 grep，保持既有契约。
 */

import { plainLogger as out } from "../telemetry/index.js";
import { main } from "./commandDispatch.js";

main().catch(error => {
  out.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
