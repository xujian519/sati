import type { IncomingMessage } from "node:http";

/**
 * 读取 HTTP 请求体并解码为 UTF-8 文本，`max` 为字节数上限。
 *
 * 超限时以固定文案 `payload too large` 拒绝并销毁请求——调用方按该文案
 * 分流错误响应，故文案是对外契约的一部分，不可改写。
 *
 * 原为 api-server / sms / webhook 三份逐字相同的实现（issue #149 · TD-ADAPTERS-N03）。
 */
export function readRequestBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
