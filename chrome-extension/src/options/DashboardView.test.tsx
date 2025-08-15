import { useState } from 'react';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DashboardView } from './DashboardView';
import { DEFAULT_DASHBOARD_STATE, type DashboardState } from '../shared/types';

function buildState(overrides: Partial<DashboardState> = {}): DashboardState {
  const now = Date.now();
  return {
    ...DEFAULT_DASHBOARD_STATE,
    mode: 'LOCALHOST',
    hostConnectivity: 'connected',
    canExecuteCommands: true,
    lastHeartbeat: now,
    runningProcesses: [
      {
        requestId: 'req-running',
        action: 'openTab',
        state: 'running',
        startedAt: now - 2_000
      }
    ],
    logs: [{ timestamp: now - 1_000, level: 'info', message: 'Connected to local bridge' }],
    errors: [{ timestamp: now - 500, code: 'NONE', message: 'Synthetic error row for layout checks' }],
    ...overrides
  };
}

const theme = createTheme();

function renderView(isTestPanelOpen: boolean, onToggleTestPanel: () => void): void {
  const state = buildState();
  render(
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <DashboardView
        state={state}
        lastResponse={null}
        isSubmitting={false}
        isTestPanelOpen={isTestPanelOpen}
        onToggleTestPanel={onToggleTestPanel}
        onSendBridgeRequest={async () => undefined}
        onClearLogsErrors={async () => undefined}
        onExportDiagnostics={async () => undefined}
      />
    </ThemeProvider>
  );
}

function ToggleHarness(): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <DashboardView
        state={buildState()}
        lastResponse={null}
        isSubmitting={false}
        isTestPanelOpen={open}
        onToggleTestPanel={() => setOpen((prev) => !prev)}
        onSendBridgeRequest={async () => undefined}
        onClearLogsErrors={async () => undefined}
        onExportDiagnostics={async () => undefined}
      />
    </ThemeProvider>
  );
}

describe('DashboardView', () => {
  it('renders core sections', () => {
    renderView(false, () => undefined);

    expect(screen.getByRole('heading', { name: 'Pending tasks' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Overall status' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Last N images carousel' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Logs with autoscroll' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Errors log' })).toBeInTheDocument();
  });

  it('starts with test controls panel collapsed', () => {
    renderView(false, () => undefined);
    expect(screen.queryByTestId('test-controls-panel')).not.toBeInTheDocument();
  });

  it('toggles test controls panel open and closed', () => {
    render(<ToggleHarness />);

    expect(screen.queryByTestId('test-controls-panel')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('toggle-test-controls'));
    expect(screen.getByTestId('test-controls-panel')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('toggle-test-controls'));
    expect(screen.queryByTestId('test-controls-panel')).not.toBeInTheDocument();
  });

  it('renders different layout modes for collapsed and open panel states', () => {
    const { rerender } = render(
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <DashboardView
          state={buildState()}
          lastResponse={null}
          isSubmitting={false}
          isTestPanelOpen={false}
          onToggleTestPanel={() => undefined}
          onSendBridgeRequest={async () => undefined}
          onClearLogsErrors={async () => undefined}
          onExportDiagnostics={async () => undefined}
        />
      </ThemeProvider>
    );

    expect(screen.queryByTestId('test-controls-panel')).not.toBeInTheDocument();

    rerender(
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <DashboardView
          state={buildState()}
          lastResponse={null}
          isSubmitting={false}
          isTestPanelOpen={true}
          onToggleTestPanel={() => undefined}
          onSendBridgeRequest={async () => undefined}
          onClearLogsErrors={async () => undefined}
          onExportDiagnostics={async () => undefined}
        />
      </ThemeProvider>
    );

    expect(screen.getByTestId('test-controls-panel')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Logs with autoscroll' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Errors log' })).toBeInTheDocument();
  });

  it('does not crash when brokerDiagnostics is missing in incoming state', () => {
    render(
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <DashboardView
          state={{ ...(buildState() as unknown as Record<string, unknown>), brokerDiagnostics: undefined } as unknown as DashboardState}
          lastResponse={null}
          isSubmitting={false}
          isTestPanelOpen={false}
          onToggleTestPanel={() => undefined}
          onSendBridgeRequest={async () => undefined}
          onClearLogsErrors={async () => undefined}
          onExportDiagnostics={async () => undefined}
        />
      </ThemeProvider>
    );

    expect(screen.getByText('Queue depth: 0')).toBeInTheDocument();
    expect(screen.getByText('Inflight: 0')).toBeInTheDocument();
  });

  it('clears logs when clicking clear all logs button', () => {
    const onClearLogsErrors = vi.fn(async () => undefined);

    render(
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <DashboardView
          state={buildState()}
          lastResponse={null}
          isSubmitting={false}
          isTestPanelOpen={false}
          onToggleTestPanel={() => undefined}
          onSendBridgeRequest={async () => undefined}
          onClearLogsErrors={onClearLogsErrors}
          onExportDiagnostics={async () => undefined}
        />
      </ThemeProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear all logs' }));
    expect(onClearLogsErrors).toHaveBeenCalledTimes(1);
  });
});
