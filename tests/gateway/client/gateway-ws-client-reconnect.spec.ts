import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { GatewayWsClient } from "../../../src/gateway/client/GatewayWsClient.js";

/**
 * GatewayWsClient 重连/关闭监听器清理回归测试。
 *
 * 背景（docs/workbuddy-sati-performance-analysis-review.md P2-14 第三批 #11）：
 * connect() 原先直接向旧 socket 之上再建新连接，旧 socket 的 message/close
 * 监听器未显式摘除——旧连接关闭事件会错误地拒绝新连接的 pending 请求
 * （pending/streams 为实例共享状态），且 this.hello 不重置会令新 connect()
 * 用旧握手结果提前 resolve。本测试覆盖：重连摘监听器、close 确定性拒绝
 * pending、重连后旧 pending 立即失败。
 */

function startServer(): Promise<{ server: WebSocketServer; url: string; connections: string[] }> {
  return new Promise(resolve => {
    const server = new WebSocketServer({ port: 0 });
    const connections: string[] = [];
    server.on("connection", ws => {
      const marker = `conn-${connections.length + 1}`;
      connections.push(marker);
      ws.on("message", raw => {
        const frame = JSON.parse(String(raw)) as { type?: string };
        if (frame.type === "hello") {
          ws.send(
            JSON.stringify({
              type: "hello_ok",
              protocolVersion: "1.2",
              serverVersion: "test",
              serverInfo: { marker },
            }),
          );
        }
        // 其余帧（request 等）故意不回，供 pending 拒绝路径测试
      });
    });
    server.on("listening", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `ws://127.0.0.1:${port}/ws`, connections });
    });
  });
}

test("GatewayWsClient: 重连后 hello 使用新连接结果（旧 hello 不残留、监听器不串扰）", async t => {
  const { server, url, connections } = await startServer();
  t.after(() => server.close());

  const client = new GatewayWsClient({ url, token: "t", clientName: "test" });
  const first = (await client.connect()) as unknown as { serverInfo: { marker: string } };
  assert.equal(first.serverInfo.marker, "conn-1");

  const second = (await client.connect()) as unknown as { serverInfo: { marker: string } };
  assert.equal(second.serverInfo.marker, "conn-2", "重连应等待新连接握手结果，而非复用旧 hello");
  assert.equal(connections.length, 2);

  // 旧 socket 已关闭：其监听器应已摘除（若未摘除，旧 close 事件会触发
  // closePending，进而拒绝下面新连接上的 pending——见下一个测试的断言）。
  client.close();
});

test("GatewayWsClient: close() 确定性拒绝挂起请求", async t => {
  const { server, url } = await startServer();
  t.after(() => server.close());

  const client = new GatewayWsClient({ url, token: "t", clientName: "test" });
  await client.connect();
  const pending = client.request("describe_server", {});
  await new Promise(r => setTimeout(r, 30)); // 让 request 帧送达（服务端不回）
  client.close();
  await assert.rejects(pending, /Gateway WebSocket closed/);
});

test("GatewayWsClient: 重连时旧连接挂起请求立即失败（不被旧 socket close 事件延迟污染）", async t => {
  const { server, url } = await startServer();
  t.after(() => server.close());

  const client = new GatewayWsClient({ url, token: "t", clientName: "test" });
  await client.connect();
  const oldPending = client.request("describe_server", {});
  await new Promise(r => setTimeout(r, 30));

  // 重连：旧 pending 应同步失败（replaced），新连接不受影响
  const reconnect = client.connect();
  await assert.rejects(oldPending, /reconnect/);
  await reconnect;

  // 新连接上发起请求并 close：正常拒绝
  const newPending = client.request("describe_server", {});
  await new Promise(r => setTimeout(r, 30));
  client.close();
  await assert.rejects(newPending, /Gateway WebSocket closed/);
});
