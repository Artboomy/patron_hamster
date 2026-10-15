export type HostConnectivity = 'connected' | 'disconnected' | 'degraded';
export type BridgeMode = 'LOCALHOST' | 'READ_ONLY';
export type RequestSource = 'dashboard' | 'node-worker';

export type ProcessState = 'queued' | 'running' | 'done' | 'error';

export interface BridgeError {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export interface BridgeRequest<TPayload = unknown> {
  version: '1.0';
  requestId: string;
  action: string;
  payload: TPayload;
  timeoutMs: number;
  sentAt: number | string;
}

export interface BridgeResponse<TResult = unknown> {
  version: '1.0';
  requestId: string;
  ok: boolean;
  result?: TResult;
  error?: BridgeError;
  receivedAt: number;
  durationMs: number;
}

export interface LogEntry {
  timestamp: number;
  level: 'info' | 'warn' | 'debug';
  message: string;
  requestId?: string;
  source?: RequestSource;
}

export interface ErrorEntry {
  timestamp: number;
  code: string;
  message: string;
  stackSnippet?: string;
  requestId?: string;
  source?: RequestSource;
}

export interface ProcessEntry {
  requestId: string;
  action: string;
  state: ProcessState;
  startedAt: number;
  durationMs?: number;
  source?: RequestSource;
}

export interface RecentImageEntry {
  url: string;
  capturedAt: number;
  requestId?: string;
  action?: string;
}

export interface BrokerDiagnostics {
  queueDepth: number;
  claimedCount: number;
  inflightCount: number;
  timeoutCount: number;
  lastWorkerHeartbeat: number | null;
  workerId: string | null;
}

export interface DashboardState {
  mode: BridgeMode;
  hostConnectivity: HostConnectivity;
  canExecuteCommands: boolean;
  readOnlyReason: string | null;
  activeTabId: number | null;
  lastHeartbeat: number | null;
  lastCommandLatencyMs: number | null;
  runningProcesses: ProcessEntry[];
  recentImages: RecentImageEntry[];
  logs: LogEntry[];
  errors: ErrorEntry[];
  brokerDiagnostics: BrokerDiagnostics;
}

export const DEFAULT_DASHBOARD_STATE: DashboardState = {
  mode: 'READ_ONLY',
  hostConnectivity: 'disconnected',
  canExecuteCommands: false,
  readOnlyReason: 'Local bridge server is not connected.',
  activeTabId: null,
  lastHeartbeat: null,
  lastCommandLatencyMs: null,
  runningProcesses: [],
  recentImages: [],
  logs: [],
  errors: [],
  brokerDiagnostics: {
    queueDepth: 0,
    claimedCount: 0,
    inflightCount: 0,
    timeoutCount: 0,
    lastWorkerHeartbeat: null,
    workerId: null
  }
};

export interface DashboardPortMessage {
  type: 'state-update';
  payload: DashboardState;
}

export interface DashboardCommand {
  type: 'clear-logs-errors' | 'export-diagnostics';
}
