import { logger } from "./consoleLogger.js";
/**
 * TASKMASTER WEBSOCKET UTILITIES
 * ==============================
 *
 * Utilities for broadcasting TaskMaster state changes via WebSocket.
 * Integrates with the existing WebSocket system to provide real-time updates.
 */

/**
 * Broadcast TaskMaster project update to all connected clients
 * @param {WebSocket.Server} wss - WebSocket server instance
 * @param {string} projectName - Name of the updated project
 * @param {Object} taskMasterData - Updated TaskMaster data
 */
export function broadcastTaskMasterProjectUpdate(wss, projectName, taskMasterData) {
  if (!wss || !projectName) {
    logger.warn("TaskMaster WebSocket broadcast: Missing wss or projectName");
    return;
  }

  const message = {
    type: "taskmaster-project-updated",
    projectName,
    taskMasterData,
    timestamp: new Date().toISOString(),
  };

  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      // WebSocket.OPEN
      try {
        client.send(JSON.stringify(message));
      } catch (error) {
        logger.error("Error sending TaskMaster project update:", error);
      }
    }
  });
}

/**
 * Broadcast TaskMaster tasks update for a specific project
 * @param {WebSocket.Server} wss - WebSocket server instance
 * @param {string} projectName - Name of the project with updated tasks
 */
export function broadcastTaskMasterTasksUpdate(wss, projectName) {
  if (!wss || !projectName) {
    logger.warn("TaskMaster WebSocket broadcast: Missing wss or projectName");
    return;
  }

  const message = {
    type: "taskmaster-tasks-updated",
    projectName,
    timestamp: new Date().toISOString(),
  };

  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      // WebSocket.OPEN
      try {
        client.send(JSON.stringify(message));
      } catch (error) {
        logger.error("Error sending TaskMaster tasks update:", error);
      }
    }
  });
}
