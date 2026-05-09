import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  applyConfigToProcessEnv,
  buildCcrConfig,
  buildGatewayConfig,
  expandTilde,
} from './edgeclawConfig.js';
import { closeMemoryServices, startMemoryScheduler } from './memoryService.js';
import { restartCCR, saveCCRConfig, shutdownCCR } from '../embedded-ccr.js';

// Regenerates the derived gateway runtime YAML from the unified config.
async function writeGatewayYaml(config) {
  const gatewayHome = expandTilde(config.gateway?.home || path.join(os.homedir(), '.edgeclaw', 'gateway'));
  await fsPromises.mkdir(gatewayHome, { recursive: true });
  const yamlPath = path.join(gatewayHome, 'config.yaml');
  const { stringify } = await import('yaml');
  await fsPromises.writeFile(yamlPath, stringify(buildGatewayConfig(config), { lineWidth: 0 }), 'utf8');
  return yamlPath;
}

// Applies a validated config to every running subsystem (env, memory, router, gateway, proxy)
// and returns a per-subsystem summary so the UI can show what actually reloaded.
export async function reloadEdgeClawConfig(config) {
  const result = {
    processEnv: { reloaded: false },
    memory: { reloaded: false },
    router: { reloaded: false, skipped: false },
    gateway: { reloaded: false, skipped: false },
    proxy: { reloaded: false, skipped: false },
  };

  applyConfigToProcessEnv(config);
  result.processEnv.reloaded = true;

  closeMemoryServices();
  if (config.memory?.enabled) {
    startMemoryScheduler();
  }
  result.memory.reloaded = true;
  result.memory.scheduler = config.memory?.enabled ? 'started' : 'stopped';

  if (config.router?.enabled) {
    saveCCRConfig(buildCcrConfig(config));
    try {
      await restartCCR();
      result.router.reloaded = true;
    } catch (error) {
      result.router.reloaded = false;
      result.router.error = error instanceof Error ? error.message : String(error);
    }
  } else {
    try {
      await shutdownCCR();
      result.router.reloaded = true;
    } catch (error) {
      result.router.reloaded = false;
      result.router.error = error instanceof Error ? error.message : String(error);
    }
    result.router.reason = 'router.enabled is false';
  }

  if (config.gateway?.enabled) {
    try {
      result.gateway.configPath = await writeGatewayYaml(config);
      result.gateway.reloaded = true;
      result.gateway.note = 'gateway YAML regenerated; running gateway processes must reconnect or be restarted by their owner';
    } catch (error) {
      result.gateway.reloaded = false;
      result.gateway.error = error instanceof Error ? error.message : String(error);
    }
  } else {
    result.gateway.skipped = true;
    result.gateway.reason = 'gateway.enabled is false';
  }

  result.proxy = await new Promise((resolve) => {
    const handled = process.emit('edgeclaw:restart-proxy', (error) => {
      if (error) {
        resolve({ reloaded: false, error: error instanceof Error ? error.message : String(error) });
      } else {
        resolve({ reloaded: true });
      }
    });
    if (!handled) {
      resolve({ reloaded: false, skipped: true, reason: 'proxy restart hook is not registered in this process' });
    }
  });

  return result;
}
