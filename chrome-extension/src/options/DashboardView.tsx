import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  LinearProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
  useMediaQuery,
  useTheme
} from '@mui/material';
import type { BridgeResponse, DashboardState } from '../shared/types';

interface DashboardViewProps {
  state: DashboardState;
  lastResponse: BridgeResponse | null;
  isSubmitting: boolean;
  isTestPanelOpen: boolean;
  onToggleTestPanel: () => void;
  onSendBridgeRequest: (action: string, payload: unknown) => Promise<void>;
  onClearLogsErrors: () => Promise<void>;
  onExportDiagnostics: () => Promise<void>;
}

function formatTime(ts: number | null): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleString();
}

function processDuration(durationMs?: number): string {
  if (durationMs === undefined) return '-';
  return `${durationMs} ms`;
}

function connectivityColor(connectivity: DashboardState['hostConnectivity']): 'success' | 'warning' | 'error' {
  if (connectivity === 'connected') return 'success';
  if (connectivity === 'degraded') return 'warning';
  return 'error';
}

function hostDotColor(connectivity: DashboardState['hostConnectivity']): string {
  if (connectivity === 'connected') return 'success.main';
  if (connectivity === 'degraded') return 'warning.main';
  return 'error.main';
}

function isValidNumber(value: string): boolean {
  if (value.trim() === '') return false;
  return Number.isFinite(Number(value));
}

function HostStatusLabel({ connectivity }: { connectivity: DashboardState['hostConnectivity'] }): JSX.Element {
  return (
    <Stack direction="row" spacing={0.75} alignItems="center">
      <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: hostDotColor(connectivity) }} />
      <span>{`Host: ${connectivity}`}</span>
    </Stack>
  );
}

export function DashboardView({
  state,
  lastResponse,
  isSubmitting,
  isTestPanelOpen,
  onToggleTestPanel,
  onSendBridgeRequest,
  onClearLogsErrors,
  onExportDiagnostics
}: DashboardViewProps): JSX.Element {
  const brokerDiagnostics = state.brokerDiagnostics ?? {
    queueDepth: 0,
    inflightCount: 0,
    claimedCount: 0,
    timeoutCount: 0,
    lastWorkerHeartbeat: null,
    workerId: null
  };
  const [openTabUrl, setOpenTabUrl] = useState('https://example.com');
  const [navigateTabId, setNavigateTabId] = useState('');
  const [navigateUrl, setNavigateUrl] = useState('https://example.com');
  const [evaluateTabId, setEvaluateTabId] = useState('');
  const [evaluateExpression, setEvaluateExpression] = useState('document.title');

  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const logsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!logsRef.current) return;
    logsRef.current.scrollTop = logsRef.current.scrollHeight;
  }, [state.logs]);

  const pendingTasks = useMemo(
    () => state.runningProcesses.filter((item) => item.state === 'queued' || item.state === 'running'),
    [state.runningProcesses]
  );

  const runningCount = useMemo(
    () => state.runningProcesses.filter((item) => item.state === 'running').length,
    [state.runningProcesses]
  );

  const completedCount = useMemo(
    () => state.runningProcesses.filter((item) => item.state === 'done' || item.state === 'error').length,
    [state.runningProcesses]
  );

  const totalProcesses = state.runningProcesses.length;
  const progressValue = totalProcesses === 0 ? 0 : Math.round((completedCount / totalProcesses) * 100);
  const commandsDisabled = !state.canExecuteCommands || isSubmitting;
  const panelRadius = 0.5;
  const recentImages = state.recentImages.slice(-12).reverse();

  const controlsPanel = (
    <Paper variant="outlined" sx={{ p: 1.25, borderRadius: panelRadius }} data-testid="test-controls-panel">
      <Stack spacing={2}>
        <Typography variant="h6">Test controls</Typography>

        <TextField label="openTab.url" value={openTabUrl} onChange={(event) => setOpenTabUrl(event.target.value)} size="small" />
        <Button
          variant="contained"
          disabled={commandsDisabled || openTabUrl.trim().length === 0}
          onClick={() => void onSendBridgeRequest('openTab', { url: openTabUrl })}
        >
          Run openTab
        </Button>

        <Divider />

        <TextField
          label="navigate.tabId"
          value={navigateTabId}
          onChange={(event) => setNavigateTabId(event.target.value)}
          placeholder="123"
          size="small"
        />
        <TextField label="navigate.url" value={navigateUrl} onChange={(event) => setNavigateUrl(event.target.value)} size="small" />
        <Button
          variant="contained"
          disabled={commandsDisabled || !isValidNumber(navigateTabId) || navigateUrl.trim().length === 0}
          onClick={() =>
            void onSendBridgeRequest('navigate', {
              tabId: Number(navigateTabId),
              url: navigateUrl
            })
          }
        >
          Run navigate
        </Button>

        <Divider />

        <TextField
          label="evaluate.tabId"
          value={evaluateTabId}
          onChange={(event) => setEvaluateTabId(event.target.value)}
          placeholder="123"
          size="small"
        />
        <TextField
          label="evaluate.expression"
          value={evaluateExpression}
          onChange={(event) => setEvaluateExpression(event.target.value)}
          size="small"
        />
        <Button
          variant="contained"
          disabled={commandsDisabled || !isValidNumber(evaluateTabId) || evaluateExpression.trim().length === 0}
          onClick={() =>
            void onSendBridgeRequest('evaluate', {
              tabId: Number(evaluateTabId),
              expression: evaluateExpression
            })
          }
        >
          Run evaluate
        </Button>

        <Divider />

        <Button variant="outlined" onClick={() => void onExportDiagnostics()}>
          Export diagnostics JSON
        </Button>

        <Box>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Last command response
          </Typography>
          <Paper
            variant="outlined"
            sx={{
              p: 1,
              maxHeight: 220,
              overflow: 'auto',
              bgcolor: 'background.default'
            }}
          >
            <Typography
              component="pre"
              sx={{
                m: 0,
                fontSize: 12,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word'
              }}
            >
              {lastResponse ? JSON.stringify(lastResponse, null, 2) : 'No command sent yet.'}
            </Typography>
          </Paper>
        </Box>
      </Stack>
    </Paper>
  );

  return (
    <Box sx={{ p: { xs: 1, md: 1.25 }, bgcolor: '#f6f7fb', minHeight: '100vh', height: '100vh', boxSizing: 'border-box' }}>
      <Stack spacing={1.25} sx={{ height: '100%' }}>
        <Paper variant="outlined" sx={{ p: 1.25, borderRadius: panelRadius }} data-testid="progress-stats-card">
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} justifyContent="space-between" alignItems={{ sm: 'center' }}>
            <Typography variant="h5" sx={{ fontWeight: 700 }}>
              Extension bridge dashboard
            </Typography>
            <Button variant={isTestPanelOpen ? 'contained' : 'outlined'} onClick={onToggleTestPanel} data-testid="toggle-test-controls">
              {isTestPanelOpen ? 'Hide test controls' : 'Show test controls'}
            </Button>
          </Stack>

          <Box sx={{ mt: 1.25 }}>
            <LinearProgress variant="determinate" value={progressValue} sx={{ height: 8, borderRadius: panelRadius }} />
            <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" sx={{ mt: 1 }}>
              <Chip label={`Mode: ${state.mode}`} size="small" />
              <Chip label={<HostStatusLabel connectivity={state.hostConnectivity} />} color={connectivityColor(state.hostConnectivity)} size="small" />
              <Chip label={`Running: ${runningCount}`} size="small" />
              <Chip label={`Completed: ${completedCount}`} size="small" />
              <Chip label={`Active tab: ${state.activeTabId ?? '-'}`} size="small" />
            </Stack>
          </Box>
        </Paper>

        {!state.canExecuteCommands && (
          <Alert severity="warning">Read-only mode: {state.readOnlyReason ?? 'Native host is not available.'}</Alert>
        )}

        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            display: 'grid',
            gridTemplateColumns: isMobile ? '1fr' : isTestPanelOpen ? '220px minmax(0, 1fr) 340px' : '220px minmax(0, 1fr)',
            gap: 1.25,
            alignItems: 'stretch'
          }}
        >
          <Stack spacing={1.25} sx={{ minHeight: 0 }}>
            <Paper variant="outlined" sx={{ p: 1.25, borderRadius: panelRadius, flex: 1, minHeight: 0, overflow: 'auto' }}>
              <Typography variant="h6" gutterBottom>
                Pending tasks
              </Typography>
              <Stack spacing={0.75}>
                {pendingTasks.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    No pending tasks.
                  </Typography>
                ) : (
                  pendingTasks.map((task) => (
                    <Paper key={task.requestId} variant="outlined" sx={{ p: 0.75, borderRadius: panelRadius }}>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {task.action}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {task.requestId}
                      </Typography>
                    </Paper>
                  ))
                )}
              </Stack>
            </Paper>

            <Paper variant="outlined" sx={{ p: 1.25, borderRadius: panelRadius, mt: 'auto' }}>
              <Typography variant="h6" gutterBottom>
                Overall status
              </Typography>
              <Stack spacing={0.5}>
                <Typography variant="body2" component="div">
                  <HostStatusLabel connectivity={state.hostConnectivity} />
                </Typography>
                <Typography variant="body2">Can execute commands: {String(state.canExecuteCommands)}</Typography>
                <Typography variant="body2">Last heartbeat: {formatTime(state.lastHeartbeat)}</Typography>
                <Typography variant="body2">Last command latency: {state.lastCommandLatencyMs ?? '-'} ms</Typography>
                <Typography variant="body2">Queue depth: {brokerDiagnostics.queueDepth}</Typography>
                <Typography variant="body2">Inflight: {brokerDiagnostics.inflightCount}</Typography>
                <Typography variant="body2">Claimed: {brokerDiagnostics.claimedCount}</Typography>
                <Typography variant="body2">Timeouts: {brokerDiagnostics.timeoutCount}</Typography>
                <Typography variant="body2">Worker heartbeat: {formatTime(brokerDiagnostics.lastWorkerHeartbeat)}</Typography>
              </Stack>
            </Paper>
          </Stack>

          <Stack spacing={1.25} sx={{ minHeight: 0 }}>
            <Paper variant="outlined" sx={{ p: 1.25, borderRadius: panelRadius, minHeight: '25vh' }}>
              <Typography variant="h6" gutterBottom>
                Last N images carousel
              </Typography>
              <Box
                sx={{
                  minHeight: 'calc(25vh - 72px)',
                  borderRadius: panelRadius,
                  border: '1px solid',
                  borderColor: 'divider',
                  display: 'flex',
                  alignItems: 'center',
                  overflowX: 'auto',
                  gap: 1,
                  p: 1
                }}
              >
                {recentImages.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    No images captured yet.
                  </Typography>
                ) : (
                  recentImages.map((image) => (
                    <Paper
                      key={`${image.url}-${image.capturedAt}`}
                      variant="outlined"
                      sx={{
                        width: 160,
                        minWidth: 160,
                        borderRadius: panelRadius,
                        overflow: 'hidden',
                        flex: '0 0 auto'
                      }}
                    >
                      <Box sx={{ aspectRatio: '4 / 3', bgcolor: 'grey.200' }}>
                        <Box
                          component="img"
                          src={image.url}
                          alt={image.action ? `${image.action} image` : 'Captured image'}
                          loading="lazy"
                          sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                        />
                      </Box>
                    </Paper>
                  ))
                )}
              </Box>
            </Paper>

            <Paper
              variant="outlined"
              sx={{
                p: 1.25,
                borderRadius: panelRadius,
                minHeight: 0,
                flex: 1,
                display: 'flex',
                flexDirection: 'column'
              }}
            >
              <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1} sx={{ mb: 1 }}>
                <Typography variant="h6">Logs with autoscroll</Typography>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={() => void onClearLogsErrors()}
                  disabled={state.logs.length === 0 && state.errors.length === 0}
                >
                  Clear all logs
                </Button>
              </Stack>
              <Box
                ref={logsRef}
                sx={{
                  flex: 1,
                  minHeight: 0,
                  overflowY: 'auto',
                  overflowX: 'hidden',
                  borderRadius: panelRadius,
                  border: '1px solid',
                  borderColor: 'divider',
                  p: 1,
                  bgcolor: 'background.default'
                }}
              >
                <Stack spacing={0.75}>
                  {state.logs.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">
                      No logs yet.
                    </Typography>
                  ) : (
                    state.logs.map((log) => (
                      <Typography
                        key={`${log.timestamp}-${log.message}`}
                        variant="body2"
                        sx={{
                          fontFamily: 'monospace',
                          fontSize: 12,
                          overflowWrap: 'anywhere'
                        }}
                      >
                        [{new Date(log.timestamp).toLocaleTimeString()}] {log.level.toUpperCase()} {log.message}
                      </Typography>
                    ))
                  )}
                </Stack>
              </Box>
            </Paper>

            <Paper
              variant="outlined"
              sx={{
                p: 1.25,
                borderRadius: panelRadius,
                minHeight: 0,
                flex: 1,
                display: 'flex',
                flexDirection: 'column'
              }}
            >
              <Typography variant="h6" gutterBottom>
                Errors log
              </Typography>
              <Box
                sx={{
                  flex: 1,
                  minHeight: 0,
                  overflowY: 'auto',
                  overflowX: 'hidden',
                  borderRadius: panelRadius,
                  border: '1px solid',
                  borderColor: 'divider',
                  p: 1,
                  bgcolor: 'background.default'
                }}
              >
                <Stack spacing={0.75}>
                  {state.errors.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">
                      No errors.
                    </Typography>
                  ) : (
                    state.errors.map((error) => (
                      <Typography
                        key={`${error.timestamp}-${error.code}`}
                        variant="body2"
                        sx={{
                          fontFamily: 'monospace',
                          fontSize: 12,
                          color: 'error.main',
                          overflowWrap: 'anywhere'
                        }}
                      >
                        [{new Date(error.timestamp).toLocaleTimeString()}] {error.code}: {error.message}
                      </Typography>
                    ))
                  )}
                </Stack>
              </Box>
            </Paper>
          </Stack>

          {!isMobile && isTestPanelOpen ? controlsPanel : null}
        </Box>

        {isMobile ? <Box sx={{ display: isTestPanelOpen ? 'block' : 'none' }}>{controlsPanel}</Box> : null}

        {totalProcesses > 0 && (
          <Paper variant="outlined" sx={{ p: 1.25, borderRadius: panelRadius }}>
            <Typography variant="h6" gutterBottom>
              Recent process timeline
            </Typography>
            <TableContainer sx={{ maxHeight: 220, border: '1px solid', borderColor: 'divider', borderRadius: panelRadius }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell>Request</TableCell>
                    <TableCell>Action</TableCell>
                    <TableCell>Source</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell>Started</TableCell>
                    <TableCell align="right">Duration</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {state.runningProcesses
                    .slice(-8)
                    .reverse()
                    .map((process) => (
                      <TableRow key={process.requestId} hover>
                        <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{process.requestId}</TableCell>
                        <TableCell>{process.action}</TableCell>
                        <TableCell>{process.source ?? '-'}</TableCell>
                        <TableCell>
                          <Chip label={process.state} size="small" />
                        </TableCell>
                        <TableCell>{formatTime(process.startedAt)}</TableCell>
                        <TableCell align="right">{processDuration(process.durationMs)}</TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Paper>
        )}
      </Stack>
    </Box>
  );
}
