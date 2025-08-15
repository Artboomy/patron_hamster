import { useEffect, useState } from 'react';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../shared/constants';
import { DEFAULT_DASHBOARD_STATE, type BridgeRequest, type BridgeResponse, type DashboardState } from '../shared/types';
import { DashboardView } from './DashboardView';
import { useDashboardUiStore } from './store/uiStore';

function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const DASHBOARD_KEEPALIVE_MS = 20_000;

export function App(): JSX.Element {
  const [state, setState] = useState<DashboardState>(DEFAULT_DASHBOARD_STATE);
  const [lastResponse, setLastResponse] = useState<BridgeResponse | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isTestPanelOpen = useDashboardUiStore((store) => store.isTestPanelOpen);
  const toggleTestPanel = useDashboardUiStore((store) => store.toggleTestPanel);

  useEffect(() => {
    let port: chrome.runtime.Port | null = null;
    let reconnectHandle: number | null = null;
    let keepAliveHandle: number | null = null;

    const startKeepAlive = () => {
      if (keepAliveHandle !== null) {
        window.clearInterval(keepAliveHandle);
      }
      keepAliveHandle = window.setInterval(() => {
        if (!port) return;
        try {
          port.postMessage({ type: 'keepalive', ts: Date.now() });
        } catch {
          // no-op: reconnect loop handles broken ports
        }
      }, DASHBOARD_KEEPALIVE_MS);
    };

    const connect = () => {
      port = chrome.runtime.connect({ name: 'dashboard' });
      startKeepAlive();
      port.onMessage.addListener((message) => {
        if (message?.type === 'state-update') {
          const incoming = message.payload as Partial<DashboardState>;
          setState({
            ...DEFAULT_DASHBOARD_STATE,
            ...incoming,
            brokerDiagnostics: {
              ...DEFAULT_DASHBOARD_STATE.brokerDiagnostics,
              ...(incoming.brokerDiagnostics ?? {})
            }
          });
        }
      });

      port.onDisconnect.addListener(() => {
        if (keepAliveHandle !== null) {
          window.clearInterval(keepAliveHandle);
          keepAliveHandle = null;
        }
        if (reconnectHandle !== null) {
          return;
        }

        reconnectHandle = window.setTimeout(() => {
          reconnectHandle = null;
          connect();
        }, 500);
      });
    };

    connect();

    return () => {
      if (keepAliveHandle !== null) {
        window.clearInterval(keepAliveHandle);
      }
      if (reconnectHandle !== null) {
        window.clearTimeout(reconnectHandle);
      }
      port?.disconnect();
    };
  }, []);

  async function onClearLogsErrors(): Promise<void> {
    await chrome.runtime.sendMessage({
      type: 'dashboard-command',
      command: { type: 'clear-logs-errors' }
    });
  }

  async function onExportDiagnostics(): Promise<void> {
    const response = (await chrome.runtime.sendMessage({
      type: 'dashboard-command',
      command: { type: 'export-diagnostics' }
    })) as { ok: boolean; payload?: DashboardState };

    if (!response?.ok || !response.payload) {
      return;
    }

    const blob = new Blob([JSON.stringify(response.payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `bridge-v2-diagnostics-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function onSendBridgeRequest(action: string, payload: unknown): Promise<void> {
    const request: BridgeRequest = {
      version: '1.0',
      requestId: createRequestId(),
      action,
      payload,
      timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      sentAt: Date.now()
    };

    setIsSubmitting(true);
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'bridge-request',
        request
      })) as BridgeResponse;
      setLastResponse(response);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <DashboardView
      state={state}
      lastResponse={lastResponse}
      isSubmitting={isSubmitting}
      isTestPanelOpen={isTestPanelOpen}
      onToggleTestPanel={toggleTestPanel}
      onSendBridgeRequest={onSendBridgeRequest}
      onClearLogsErrors={onClearLogsErrors}
      onExportDiagnostics={onExportDiagnostics}
    />
  );
}
