/**
 * ui/server projects 目录 watcher（B3 分片）。
 *
 * 从 ui/server/index.js 拆出（机械搬移，不改逻辑）：chokidar 监听
 * ~/.sati/projects 转录根，防抖刷新项目列表并广播 projects_updated。
 * 依赖 websocket/broadcast.js 的 connectedClients/broadcastProgress
 * （广播状态单一来源，禁止反向 import）。
 */

import { promises as fsPromises } from "fs";
import path from "path";
import os from "os";
import { WebSocket } from "ws";
import { clearProjectDirectoryCache, getProjects } from "../projects.js";
import { broadcastProgress, connectedClients } from "../websocket/broadcast.js";

// File-system watchers for the chat transcript root maintained by
// Sati. Provider-specific watchers (.sati) were dropped along with the four provider adapters.
// .gemini) were dropped along with the four provider adapters.
const PROVIDER_WATCH_PATHS = [
  {
    provider: "sati",
    rootPath: path.join(process.env.SATI_HOME || path.join(os.homedir(), ".sati"), "projects"),
  },
];
const WATCHER_IGNORED_PATTERNS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/*.tmp",
  "**/*.swp",
  "**/.DS_Store",
];
const WATCHER_DEBOUNCE_MS = 300;
let projectsWatchers = [];
let projectsWatcherDebounceTimer = null;
let isGetProjectsRunning = false; // Flag to prevent reentrant calls

async function setupProjectsWatcher() {
  const chokidar = (await import("chokidar")).default;

  if (projectsWatcherDebounceTimer) {
    clearTimeout(projectsWatcherDebounceTimer);
    projectsWatcherDebounceTimer = null;
  }

  await Promise.all(
    projectsWatchers.map(async watcher => {
      try {
        await watcher.close();
      } catch (error) {
        console.error("[WARN] Failed to close watcher:", error);
      }
    }),
  );
  projectsWatchers = [];

  const debouncedUpdate = (eventType, filePath, provider, rootPath) => {
    if (projectsWatcherDebounceTimer) {
      clearTimeout(projectsWatcherDebounceTimer);
    }

    projectsWatcherDebounceTimer = setTimeout(async () => {
      // Prevent reentrant calls
      if (isGetProjectsRunning) {
        return;
      }

      try {
        isGetProjectsRunning = true;

        // Clear project directory cache when files change
        clearProjectDirectoryCache();

        // Get updated projects list
        const updatedProjects = await getProjects(broadcastProgress);

        // Notify all connected clients about the project changes
        const updateMessage = JSON.stringify({
          type: "projects_updated",
          projects: updatedProjects,
          timestamp: new Date().toISOString(),
          changeType: eventType,
          changedFile: path.relative(rootPath, filePath),
          watchProvider: provider,
        });

        connectedClients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(updateMessage);
          }
        });
      } catch (error) {
        console.error("[ERROR] Error handling project changes:", error);
      } finally {
        isGetProjectsRunning = false;
      }
    }, WATCHER_DEBOUNCE_MS);
  };

  for (const { provider, rootPath } of PROVIDER_WATCH_PATHS) {
    try {
      // chokidar v4 emits ENOENT via the "error" event for missing roots and will not auto-recover.
      // Ensure provider folders exist before creating the watcher so watching stays active.
      await fsPromises.mkdir(rootPath, { recursive: true });

      // Initialize chokidar watcher with optimized settings
      const watcher = chokidar.watch(rootPath, {
        ignored: WATCHER_IGNORED_PATTERNS,
        persistent: true,
        ignoreInitial: true, // Don't fire events for existing files on startup
        followSymlinks: false,
        depth: 10, // Reasonable depth limit
        awaitWriteFinish: {
          stabilityThreshold: 100, // Wait 100ms for file to stabilize
          pollInterval: 50,
        },
      });

      // Set up event listeners
      watcher
        .on("add", filePath => debouncedUpdate("add", filePath, provider, rootPath))
        .on("change", filePath => debouncedUpdate("change", filePath, provider, rootPath))
        .on("unlink", filePath => debouncedUpdate("unlink", filePath, provider, rootPath))
        .on("addDir", dirPath => debouncedUpdate("addDir", dirPath, provider, rootPath))
        .on("unlinkDir", dirPath => debouncedUpdate("unlinkDir", dirPath, provider, rootPath))
        .on("error", error => {
          console.error(`[ERROR] ${provider} watcher error:`, error);
        })
        .on("ready", () => {});

      projectsWatchers.push(watcher);
    } catch (error) {
      console.error(`[ERROR] Failed to setup ${provider} watcher for ${rootPath}:`, error);
    }
  }

  if (projectsWatchers.length === 0) {
    console.error("[ERROR] Failed to setup any provider watchers");
  }
}

export { setupProjectsWatcher };
