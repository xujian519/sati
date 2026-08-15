import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import "@fontsource-variable/inter";
import "./index.css";
// katex.min.css 已改为按需加载：仅在渲染含公式的消息/预览时随动态 chunk 注入
// （见 chat Markdown.tsx 与 code-editor MarkdownPreview.tsx），避免首屏 CSS 携带 69 个字体文件。
// Initialize i18n
import "./i18n/config.js";
import { registerDynamicImportReloadHandler } from "./utils/reloadOnChunkError";

registerDynamicImportReloadHandler();

// Register service worker for PWA + Web Push support
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(err => {
    console.warn("Service worker registration failed:", err);
  });
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
