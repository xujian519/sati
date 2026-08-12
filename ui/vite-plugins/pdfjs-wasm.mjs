import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WASM_DIR = path.resolve(__dirname, "..", "node_modules/pdfjs-dist/wasm");
const WASM_URL_PATH = "/wasm/";
const WASM_OUTPUT_DIR = path.resolve(__dirname, "..", "dist/wasm");

function listWasmFiles() {
  if (!fs.existsSync(WASM_DIR)) {
    throw new Error(`pdfjs-dist wasm directory not found: ${WASM_DIR}`);
  }
  const files = fs.readdirSync(WASM_DIR).filter(fileName => fileName.endsWith(".wasm"));
  if (files.length === 0) {
    throw new Error(`No .wasm files found in ${WASM_DIR}; pdfjs-dist layout may have changed.`);
  }
  return files;
}

function serveWasmMiddlewareFactory(wasmFiles) {
  return function serveWasm(req, res, next) {
    if (!req.url?.startsWith(WASM_URL_PATH)) {
      next();
      return;
    }

    const fileName = path.basename(req.url.split("?")[0]);
    const filePath = path.join(WASM_DIR, fileName);

    if (!wasmFiles.includes(fileName) || !fs.existsSync(filePath)) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    res.setHeader("Content-Type", "application/wasm");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    fs.createReadStream(filePath).pipe(res);
  };
}

function copyWasmToDist(wasmFiles) {
  fs.mkdirSync(WASM_OUTPUT_DIR, { recursive: true });
  for (const fileName of wasmFiles) {
    const src = path.join(WASM_DIR, fileName);
    const dest = path.join(WASM_OUTPUT_DIR, fileName);
    fs.copyFileSync(src, dest);
  }
}

export default function pdfjsWasmPlugin() {
  const wasmFiles = listWasmFiles();
  const serveWasm = serveWasmMiddlewareFactory(wasmFiles);

  return {
    name: "pdfjs-wasm",
    configureServer(server) {
      server.middlewares.use(serveWasm);
    },
    configurePreviewServer(server) {
      server.middlewares.use(serveWasm);
    },
    writeBundle() {
      copyWasmToDist(wasmFiles);
    },
  };
}
