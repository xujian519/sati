import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export type FeishuWebhookAuthResult =
  | { kind: "ok"; payload: Record<string, unknown>; challenge?: string }
  | { kind: "ignore" }
  | { kind: "unauthorized"; reason: string };

/**
 * Webhook 回调鉴权：至少需要 verifyToken 或 encryptKey 之一。
 * 加密报文先 AES 解密，再校验 token/签名；签名覆盖 HTTP 原始 body。
 */
export function authenticateFeishuWebhook(input: {
  body: string;
  headers: IncomingMessage["headers"];
  verifyToken?: string;
  encryptKey?: string;
}): FeishuWebhookAuthResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.body);
  } catch {
    // 请求体非合法 JSON：忽略事件（fail-safe）。
    return { kind: "ignore" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "ignore" };
  let payload = parsed as Record<string, unknown>;

  // 否则任何人都能伪造消息触发 agent。
  if (!input.verifyToken && !input.encryptKey) {
    return { kind: "unauthorized", reason: "no verifyToken or encryptKey configured" };
  }

  const encrypted = typeof payload.encrypt === "string";
  if (encrypted) {
    if (!input.encryptKey) return { kind: "unauthorized", reason: "encrypted payload without encryptKey" };
    try {
      const decrypted = decryptFeishuPayload(payload.encrypt as string, input.encryptKey);
      const decoded: unknown = JSON.parse(decrypted);
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
        return { kind: "unauthorized", reason: "decrypted payload is not an object" };
      }
      payload = decoded as Record<string, unknown>;
    } catch {
      // 密钥不符或报文损坏：统一按未鉴权拒绝，不向调用方区分原因。
      return { kind: "unauthorized", reason: "payload decryption failed" };
    }
  }

  const challenge = payload.type === "url_verification" && typeof payload.challenge === "string";
  if (input.verifyToken) {
    const token = payload.token ?? (payload.header as { token?: unknown } | undefined)?.token;
    if (typeof token !== "string" || !secureEqual(token, input.verifyToken)) {
      return { kind: "unauthorized", reason: "verifyToken mismatch" };
    }
  }
  if (input.encryptKey) {
    const timestamp = input.headers["x-lark-request-timestamp"];
    const nonce = input.headers["x-lark-request-nonce"];
    const signature = input.headers["x-lark-signature"];
    const signed =
      typeof timestamp === "string" &&
      typeof nonce === "string" &&
      typeof signature === "string" &&
      secureEqual(
        createHash("sha256")
          .update(timestamp + nonce + input.encryptKey + input.body)
          .digest("hex"),
        signature,
      );
    // 飞书首次加密 URL 校验可能不带签名头；此时仅凭「解密成功 + token 校验」
    // 放行这次握手，普通事件仍必须带签名。
    if (!signed && !(challenge && encrypted)) {
      return { kind: "unauthorized", reason: "missing or invalid x-lark-signature" };
    }
  }

  return challenge ? { kind: "ok", payload, challenge: payload.challenge as string } : { kind: "ok", payload };
}

function secureEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function decryptFeishuPayload(encrypted: string, key: string): string {
  const aesKey = createHash("sha256").update(key, "utf8").digest();
  const buf = Buffer.from(encrypted, "base64");
  const iv = buf.subarray(0, 16);
  const cipherText = buf.subarray(16);
  const decipher = createDecipheriv("aes-256-cbc", aesKey, iv);
  decipher.setAutoPadding(true);
  const decoded = Buffer.concat([decipher.update(cipherText), decipher.final()]);
  return decoded.toString("utf8");
}
