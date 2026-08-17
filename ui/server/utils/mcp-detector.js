/**
 * MCP SERVER DETECTION UTILITY
 * ============================
 *
 * Centralized utility for detecting MCP server configurations.
 * Used across TaskMaster integration and other MCP-dependent features.
 */

import { promises as fsPromises } from "fs";
import path from "path";
import os from "os";

/**
 * Sati 用户级 MCP 配置候选路径。当前主路径为 `~/.sati/mcp.json`
 * （与 `src/mcp/config/loadMcpServerConfig.ts` 的 `MCP_CONFIG_FILE_NAME`
 * 对齐，Sati 运行时只读取它）；`.sati.json` / `settings.json` 为历史
 * 遗留兼容，运行时不再读取，保留仅为旧版迁移过渡。
 */
const SATI_USER_CONFIG_PATHS = [
  path.join(os.homedir(), ".sati.json"),
  path.join(os.homedir(), ".sati", "settings.json"),
  path.join(os.homedir(), ".sati", "mcp.json"),
];

/**
 * Check if task-master-ai MCP server is configured
 * @returns {Promise<Object>} MCP detection result
 */
export async function detectTaskMasterMCPServer() {
  try {
    const configPaths = SATI_USER_CONFIG_PATHS;

    let configData = null;
    let configPath = null;

    // Try to read from either config file
    for (const filepath of configPaths) {
      try {
        const fileContent = await fsPromises.readFile(filepath, "utf8");
        configData = JSON.parse(fileContent);
        configPath = filepath;
        break;
      } catch {
        // File doesn't exist or is not valid JSON, try next
        continue;
      }
    }

    if (!configData) {
      return {
        hasMCPServer: false,
        reason: "No sati configuration file found",
        hasConfig: false,
      };
    }

    // Look for task-master-ai in user-scoped MCP servers
    let taskMasterServer = null;
    if (configData.mcpServers && typeof configData.mcpServers === "object") {
      const serverEntry = Object.entries(configData.mcpServers).find(
        ([name, config]) =>
          name === "task-master-ai" ||
          name.includes("task-master") ||
          (config && config.command && config.command.includes("task-master")),
      );

      if (serverEntry) {
        const [name, config] = serverEntry;
        taskMasterServer = {
          name,
          scope: "user",
          config,
          type: config.command ? "stdio" : config.url ? "http" : "unknown",
        };
      }
    }

    // Also check project-specific MCP servers if not found globally
    if (!taskMasterServer && configData.projects) {
      for (const [projectPath, projectConfig] of Object.entries(configData.projects)) {
        if (projectConfig.mcpServers && typeof projectConfig.mcpServers === "object") {
          const serverEntry = Object.entries(projectConfig.mcpServers).find(
            ([name, config]) =>
              name === "task-master-ai" ||
              name.includes("task-master") ||
              (config && config.command && config.command.includes("task-master")),
          );

          if (serverEntry) {
            const [name, config] = serverEntry;
            taskMasterServer = {
              name,
              scope: "local",
              projectPath,
              config,
              type: config.command ? "stdio" : config.url ? "http" : "unknown",
            };
            break;
          }
        }
      }
    }

    if (taskMasterServer) {
      const isValid = !!(taskMasterServer.config && (taskMasterServer.config.command || taskMasterServer.config.url));
      const hasEnvVars = !!(
        taskMasterServer.config &&
        taskMasterServer.config.env &&
        Object.keys(taskMasterServer.config.env).length > 0
      );

      return {
        hasMCPServer: true,
        isConfigured: isValid,
        hasApiKeys: hasEnvVars,
        scope: taskMasterServer.scope,
        config: {
          command: taskMasterServer.config?.command,
          args: taskMasterServer.config?.args || [],
          url: taskMasterServer.config?.url,
          envVars: hasEnvVars ? Object.keys(taskMasterServer.config.env) : [],
          type: taskMasterServer.type,
        },
      };
    } else {
      // Get list of available servers for debugging
      const availableServers = [];
      if (configData.mcpServers) {
        availableServers.push(...Object.keys(configData.mcpServers));
      }
      if (configData.projects) {
        for (const projectConfig of Object.values(configData.projects)) {
          if (projectConfig.mcpServers) {
            availableServers.push(...Object.keys(projectConfig.mcpServers).map(name => `local:${name}`));
          }
        }
      }

      return {
        hasMCPServer: false,
        reason: "task-master-ai not found in configured MCP servers",
        hasConfig: true,
        configPath,
        availableServers,
      };
    }
  } catch (error) {
    console.error("Error detecting MCP server config:", error);
    return {
      hasMCPServer: false,
      reason: `Error checking MCP config: ${error.message}`,
      hasConfig: false,
    };
  }
}

/**
 * Get all configured MCP servers (not just TaskMaster)
 * @returns {Promise<Object>} All MCP servers configuration
 */
export async function getAllMCPServers() {
  try {
    const configPaths = SATI_USER_CONFIG_PATHS;

    let configData = null;
    let configPath = null;

    // Try to read from either config file
    for (const filepath of configPaths) {
      try {
        const fileContent = await fsPromises.readFile(filepath, "utf8");
        configData = JSON.parse(fileContent);
        configPath = filepath;
        break;
      } catch {
        continue;
      }
    }

    if (!configData) {
      return {
        hasConfig: false,
        servers: {},
        projectServers: {},
      };
    }

    return {
      hasConfig: true,
      configPath,
      servers: configData.mcpServers || {},
      projectServers: configData.projects || {},
    };
  } catch (error) {
    console.error("Error getting all MCP servers:", error);
    return {
      hasConfig: false,
      error: error.message,
      servers: {},
      projectServers: {},
    };
  }
}
