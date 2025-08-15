import { useState } from 'react';
import type { StoryDefault } from '@ladle/react';
import { DashboardView } from './DashboardView';
import { DEFAULT_DASHBOARD_STATE, type DashboardState } from '../shared/types';

export default {
  title: 'Options/Bridge Dashboard'
} satisfies StoryDefault;

interface StoryProps {
  state: DashboardState;
  initialPanelOpen: boolean;
}

function StoryFrame({ state, initialPanelOpen }: StoryProps): JSX.Element {
  const [open, setOpen] = useState(initialPanelOpen);

  return (
    <DashboardView
      state={state}
      lastResponse={null}
      isSubmitting={false}
      isTestPanelOpen={open}
      onToggleTestPanel={() => setOpen((prev) => !prev)}
      onSendBridgeRequest={async () => undefined}
      onClearLogsErrors={async () => undefined}
      onExportDiagnostics={async () => undefined}
    />
  );
}

const now = Date.now();

const healthyState: DashboardState = {
  ...DEFAULT_DASHBOARD_STATE,
  mode: 'LOCALHOST',
  hostConnectivity: 'connected',
  canExecuteCommands: true,
  readOnlyReason: null,
  activeTabId: 42,
  lastHeartbeat: now,
  lastCommandLatencyMs: 144,
  runningProcesses: [
    { requestId: 'req-1', action: 'openTab', state: 'running', startedAt: now - 3_000 },
    { requestId: 'req-2', action: 'navigate', state: 'done', startedAt: now - 10_000, durationMs: 385 }
  ],
  logs: [
    { timestamp: now - 11_000, level: 'info', message: 'Bridge connected' },
    { timestamp: now - 8_000, level: 'debug', message: 'Request received: openTab' },
    { timestamp: now - 5_000, level: 'info', message: 'Request completed: navigate' }
  ],
  errors: []
};

const readOnlyState: DashboardState = {
  ...DEFAULT_DASHBOARD_STATE,
  mode: 'READ_ONLY',
  hostConnectivity: 'degraded',
  canExecuteCommands: false,
  readOnlyReason: 'Local bridge server is unavailable.',
  lastHeartbeat: now - 2_500,
  lastCommandLatencyMs: null,
  runningProcesses: [{ requestId: 'req-3', action: 'evaluate', state: 'error', startedAt: now - 20_000, durationMs: 10_000 }],
  logs: [
    { timestamp: now - 7_000, level: 'warn', message: 'Lost connection to local bridge server' },
    { timestamp: now - 2_000, level: 'debug', message: 'Request received: evaluate' }
  ],
  errors: [{ timestamp: now - 2_000, code: 'HOST_UNAVAILABLE', message: 'Local bridge unavailable' }]
};

const errorHeavyState: DashboardState = {
  ...readOnlyState,
  errors: Array.from({ length: 12 }).map((_, index) => ({
    timestamp: now - index * 1_500,
    code: `ERR_${index + 1}`,
    message: `Synthetic error item ${index + 1}`
  })),
  logs: Array.from({ length: 18 }).map((_, index) => ({
    timestamp: now - index * 800,
    level: index % 2 === 0 ? 'warn' : 'debug',
    message: `Log line ${index + 1} for overflow testing`
  })) as DashboardState['logs']
};

export const MainMode = () => <StoryFrame state={healthyState} initialPanelOpen={false} />;

export const TestControlsOpen = () => <StoryFrame state={healthyState} initialPanelOpen={true} />;

export const ReadOnlyErrorHeavy = () => <StoryFrame state={errorHeavyState} initialPanelOpen={false} />;
