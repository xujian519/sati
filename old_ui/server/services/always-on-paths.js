import path from 'path';

export function getAlwaysOnRoot(projectRoot) {
  return path.join(path.resolve(projectRoot), '.claude', 'always-on');
}

export function getAlwaysOnHeartbeatsDir(projectRoot) {
  return path.join(getAlwaysOnRoot(projectRoot), 'heartbeats');
}

export function getAlwaysOnHeartbeatPath(projectRoot, fileName) {
  return path.join(getAlwaysOnHeartbeatsDir(projectRoot), fileName);
}

export function getAlwaysOnDiscoveryLockPath(projectRoot) {
  return path.join(getAlwaysOnRoot(projectRoot), 'discovery.lock');
}

export function getAlwaysOnDiscoveryStatePath(projectRoot) {
  return path.join(getAlwaysOnRoot(projectRoot), 'discovery-state.json');
}

export function getAlwaysOnRunHistoryPath(projectRoot) {
  return path.join(getAlwaysOnRoot(projectRoot), 'run-history.jsonl');
}

export function getAlwaysOnRunsDir(projectRoot) {
  return path.join(getAlwaysOnRoot(projectRoot), 'runs');
}
