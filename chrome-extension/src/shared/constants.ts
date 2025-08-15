export const MAX_LOGS = 500;
export const MAX_ERRORS = 200;
export const STORAGE_KEY_STATE = 'bridgeV2DashboardState';
export const LOCAL_BRIDGE_ORIGIN =
  import.meta.env.VITE_LOCAL_BRIDGE_ORIGIN || 'http://127.0.0.1:17353';
export const LOCAL_BRIDGE_HEALTH_PATH = '/health';
export const LOCAL_BRIDGE_MESSAGE_PATH = '/v1/message';
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const MAX_RECONNECT_BACKOFF_MS = 30_000;
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const WORKER_ALARM_NAME = 'bridge-v2-worker-tick';
export const WORKER_ALARM_PERIOD_MINUTES = 0.5;
