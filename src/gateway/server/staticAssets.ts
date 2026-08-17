import { createReadStream, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

/**
 * 提供静态资产（SPA 资源 + index.html 回退）。
 *
 * 性能：原实现对候选路径与回退路径各做一次 existsSync + statSync（每次请求
 * 4 次系统调用），且无缓存协商。现合并为按 errno 区分的一次 statSync，并输出
 * ETag（size-mtime）支持 304 协商——浏览器缓存命中的请求零文件读取。
 */
export function serveStaticAsset(
  staticRoot: string,
  requestPath: string,
  response: ServerResponse,
  request?: IncomingMessage,
): boolean {
  const root = resolve(staticRoot);
  const pathname = requestPath === "/" ? "/index.html" : requestPath;
  const candidate = resolve(join(root, normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "")));
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    return false;
  }

  // 一次 stat 判断：候选不存在（ENOENT）或非文件 → 回退 index.html（SPA 路由）。
  let filePath = candidate;
  let fileStat = tryStat(candidate);
  if (!fileStat?.isFile()) {
    filePath = resolve(root, "index.html");
    fileStat = tryStat(filePath);
  }
  if (!fileStat?.isFile()) {
    return false;
  }

  const etag = `"${Number(fileStat.size).toString(16)}-${Math.floor(Number(fileStat.mtimeMs)).toString(16)}"`;
  const ifNoneMatch = request?.headers["if-none-match"];
  if (typeof ifNoneMatch === "string" && ifNoneMatch === etag) {
    response.writeHead(304, { etag });
    response.end();
    return true;
  }

  response.writeHead(200, {
    "content-type": CONTENT_TYPES[filePath.slice(filePath.lastIndexOf("."))] ?? "application/octet-stream",
    etag,
  });
  createReadStream(filePath).pipe(response);
  return true;
}

function tryStat(path: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}
