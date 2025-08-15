import {
  DEFAULT_DASHBOARD_STATE,
  type BridgeError,
  type BridgeRequest,
  type BridgeResponse,
  type DashboardCommand,
  type DashboardPortMessage,
  type DashboardState,
  type ErrorEntry,
  type LogEntry,
  type ProcessEntry,
  type RecentImageEntry,
  type RequestSource
} from '../shared/types';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  LOCAL_BRIDGE_HEALTH_PATH,
  LOCAL_BRIDGE_ORIGIN,
  MAX_ERRORS,
  MAX_LOGS,
  STORAGE_KEY_STATE,
  WORKER_ALARM_NAME,
  WORKER_ALARM_PERIOD_MINUTES
} from '../shared/constants';

const HEALTH_CHECK_TIMEOUT_MS = 1_500;
const WORKER_POLL_WAIT_MS = 4_000;
const MIN_RECONNECT_RETRY_MS = 500;
const MAX_RECONNECT_RETRY_MS = 8_000;
const HOT_POLL_INTERVAL_MS = 150;
const HOT_POLL_IDLE_CUTOFF_MS = 60_000;
const RECENT_IMAGE_MAX_DIMENSION = 400;

let dashboardState: DashboardState = { ...DEFAULT_DASHBOARD_STATE };
const dashboardPorts = new Set<chrome.runtime.Port>();

let workerTickInFlight = false;
let reconnectAttempt = 0;
let scheduledWorkerTick: number | null = null;
let lastBridgeActivityAt = 0;

const workerId =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? `ext-${crypto.randomUUID()}`
    : `ext-${Date.now()}-${Math.random().toString(16).slice(2)}`;

function healthUrl(): string {
  return `${LOCAL_BRIDGE_ORIGIN}${LOCAL_BRIDGE_HEALTH_PATH}`;
}

function workerClaimUrl(): string {
  return `${LOCAL_BRIDGE_ORIGIN}/v2/worker/claim`;
}

function workerResultUrl(): string {
  return `${LOCAL_BRIDGE_ORIGIN}/v2/worker/result`;
}

function workerHeartbeatUrl(): string {
  return `${LOCAL_BRIDGE_ORIGIN}/v2/worker/heartbeat`;
}

function workerRecentImageUrl(): string {
  return `${LOCAL_BRIDGE_ORIGIN}/v2/worker/recent-image`;
}

function workerClaimSavedImageUrl(): string {
  return `${LOCAL_BRIDGE_ORIGIN}/v2/worker/claim-saved-image`;
}

function dashboardResetRecentImagesUrl(): string {
  return `${LOCAL_BRIDGE_ORIGIN}/v2/dashboard/recent-images/reset`;
}

function dashboardRecentImageBinaryUrl(id: string): string {
  return `${LOCAL_BRIDGE_ORIGIN}/v2/dashboard/recent-images/${encodeURIComponent(id)}`;
}

async function loadState(): Promise<void> {
  const data = await chrome.storage.local.get(STORAGE_KEY_STATE);
  if (data[STORAGE_KEY_STATE]) {
    dashboardState = {
      ...DEFAULT_DASHBOARD_STATE,
      ...(data[STORAGE_KEY_STATE] as DashboardState),
      brokerDiagnostics: {
        ...DEFAULT_DASHBOARD_STATE.brokerDiagnostics,
        ...((data[STORAGE_KEY_STATE] as DashboardState).brokerDiagnostics ?? {})
      }
    };
  }
}

async function persistAndBroadcast(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY_STATE]: dashboardState });
  const message: DashboardPortMessage = { type: 'state-update', payload: dashboardState };
  for (const port of dashboardPorts) {
    try {
      port.postMessage(message);
    } catch {
      dashboardPorts.delete(port);
    }
  }
}

function appendLog(entry: LogEntry): void {
  dashboardState.logs = [...dashboardState.logs, entry].slice(-MAX_LOGS);
}

function appendError(entry: ErrorEntry): void {
  dashboardState.errors = [...dashboardState.errors, entry].slice(-MAX_ERRORS);
}

function upsertProcess(process: ProcessEntry): void {
  const next = dashboardState.runningProcesses.filter((item) => item.requestId !== process.requestId);
  next.push(process);
  dashboardState.runningProcesses = next.slice(-100);
}

function updateActiveTab(tabId: number | null): void {
  dashboardState.activeTabId = tabId;
}

function markBridgeActivity(): void {
  lastBridgeActivityAt = Date.now();
}

function shouldHotPoll(): boolean {
  if (dashboardPorts.size > 0) {
    return true;
  }
  return Date.now() - lastBridgeActivityAt < HOT_POLL_IDLE_CUTOFF_MS;
}

function parseRecentImages(raw: unknown): RecentImageEntry[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((entry): RecentImageEntry | null => {
      if (!entry || typeof entry !== 'object') return null;
      const candidate = entry as Record<string, unknown>;
      if (typeof candidate.id !== 'string' || candidate.id.length === 0) return null;
      const capturedAtValue = candidate.capturedAt;
      const capturedAt =
        typeof capturedAtValue === 'number'
          ? capturedAtValue
          : typeof capturedAtValue === 'string'
            ? Date.parse(capturedAtValue)
            : NaN;
      if (!Number.isFinite(capturedAt)) return null;

      return {
        url: dashboardRecentImageBinaryUrl(candidate.id),
        capturedAt,
        requestId: typeof candidate.requestId === 'string' ? candidate.requestId : undefined,
        action: typeof candidate.action === 'string' ? candidate.action : undefined
      };
    })
    .filter((entry): entry is RecentImageEntry => entry !== null);
}

function updateRecentImagesFromDiagnostics(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const recentImages = parseRecentImages((raw as Record<string, unknown>).recentImages);
  if (recentImages.length > 0 || dashboardState.recentImages.length > 0) {
    dashboardState.recentImages = recentImages;
  }
}

async function fetchResizeImage(url: string): Promise<{
  bytes: ArrayBuffer;
  mimeType: string;
  width: number;
  height: number;
} | null> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    return null;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.startsWith('image/')) {
    return null;
  }

  const sourceBlob = await response.blob();
  if (!sourceBlob.type.startsWith('image/')) {
    return null;
  }

  const bitmap = await createImageBitmap(sourceBlob);
  try {
    const scale = Math.min(1, RECENT_IMAGE_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, width, height);

    const mimeType = sourceBlob.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const resized = await canvas.convertToBlob({
      type: mimeType,
      ...(mimeType === 'image/jpeg' ? { quality: 0.85 } : {})
    });
    return {
      bytes: await resized.arrayBuffer(),
      mimeType,
      width,
      height
    };
  } finally {
    bitmap.close();
  }
}

async function uploadRecentImage(
  imageUrl: string,
  context: { requestId: string; action: string }
): Promise<void> {
  const resized = await fetchResizeImage(imageUrl);
  if (!resized) {
    return;
  }

  const response = await fetch(workerRecentImageUrl(), {
    method: 'POST',
    headers: {
      'content-type': resized.mimeType,
      'x-worker-id': workerId,
      'x-image-request-id': context.requestId,
      'x-image-action': context.action,
      'x-image-width': String(resized.width),
      'x-image-height': String(resized.height)
    },
    body: resized.bytes
  });
  if (!response.ok) {
    throw createBridgeError('HTTP_ERROR', `Recent image upload failed: HTTP ${response.status}`, true, {
      status: response.status
    });
  }

  const body = (await response.json()) as { diagnostics?: unknown };
  setBrokerDiagnostics(body.diagnostics);
  updateRecentImagesFromDiagnostics(body.diagnostics);
}

async function processSavedImageThumbnail(): Promise<void> {
  const claim = (await fetchJson(workerClaimSavedImageUrl(), { workerId }, HEALTH_CHECK_TIMEOUT_MS)) as {
    image?: {
      id: string;
      binaryPath: string;
      requestId?: string;
      action?: string;
    } | null;
    diagnostics?: unknown;
  };
  setBrokerDiagnostics(claim.diagnostics);

  const image = claim.image;
  if (!image || typeof image.binaryPath !== 'string') {
    return;
  }

  const imageUrl = image.binaryPath.startsWith('http') ? image.binaryPath : `${LOCAL_BRIDGE_ORIGIN}${image.binaryPath}`;
  await uploadRecentImage(imageUrl, {
    requestId: image.requestId ?? image.id,
    action: image.action ?? 'saved-image'
  });
}

function createBridgeError(code: string, message: string, retryable: boolean, details?: unknown): BridgeError {
  return { code, message, retryable, details };
}

function normalizeBridgeError(error: unknown): BridgeError {
  if (typeof error === 'object' && error !== null && 'code' in error && 'message' in error) {
    const candidate = error as BridgeError;
    return {
      code: candidate.code,
      message: candidate.message,
      retryable: Boolean(candidate.retryable),
      details: candidate.details
    };
  }

  if (error instanceof Error) {
    return createBridgeError('RUNTIME_ERROR', error.message, false);
  }

  return createBridgeError('UNKNOWN_ERROR', 'Unknown error', false, error);
}

function setReadOnlyMode(reason: string, connectivity: DashboardState['hostConnectivity']): void {
  dashboardState.mode = 'READ_ONLY';
  dashboardState.canExecuteCommands = false;
  dashboardState.readOnlyReason = reason;
  dashboardState.hostConnectivity = connectivity;
}

function setLocalhostMode(): void {
  dashboardState.mode = 'LOCALHOST';
  dashboardState.canExecuteCommands = true;
  dashboardState.readOnlyReason = null;
  dashboardState.hostConnectivity = 'connected';
}

function setBrokerDiagnostics(raw: unknown): void {
  if (!raw || typeof raw !== 'object') {
    return;
  }

  const data = raw as Partial<DashboardState['brokerDiagnostics']>;
  dashboardState.brokerDiagnostics = {
    ...dashboardState.brokerDiagnostics,
    queueDepth: typeof data.queueDepth === 'number' ? data.queueDepth : dashboardState.brokerDiagnostics.queueDepth,
    claimedCount: typeof data.claimedCount === 'number' ? data.claimedCount : dashboardState.brokerDiagnostics.claimedCount,
    inflightCount: typeof data.inflightCount === 'number' ? data.inflightCount : dashboardState.brokerDiagnostics.inflightCount,
    timeoutCount: typeof data.timeoutCount === 'number' ? data.timeoutCount : dashboardState.brokerDiagnostics.timeoutCount,
    lastWorkerHeartbeat:
      typeof data.lastWorkerHeartbeat === 'string'
        ? Date.parse(data.lastWorkerHeartbeat)
        : typeof data.lastWorkerHeartbeat === 'number'
          ? data.lastWorkerHeartbeat
          : dashboardState.brokerDiagnostics.lastWorkerHeartbeat,
    workerId: typeof data.workerId === 'string' ? data.workerId : dashboardState.brokerDiagnostics.workerId
  };

  updateRecentImagesFromDiagnostics(raw);
}

function toFailureResponse(request: BridgeRequest, startedAt: number, bridgeError: BridgeError): BridgeResponse {
  const receivedAt = Date.now();
  return {
    version: '1.0',
    requestId: request.requestId,
    ok: false,
    error: bridgeError,
    receivedAt,
    durationMs: receivedAt - startedAt
  };
}

function validateRequest(request: BridgeRequest): BridgeError | null {
  if (!request || request.version !== '1.0' || !request.requestId || !request.action) {
    return createBridgeError('INVALID_PAYLOAD', 'Request must include version, requestId, and action', false);
  }

  return null;
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url: string, body: unknown, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs) as unknown as number;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      throw createBridgeError('HTTP_ERROR', `Bridge HTTP ${response.status}`, true, {
        status: response.status,
        statusText: response.statusText,
        url
      });
    }

    return await response.json();
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw createBridgeError('LOCAL_TIMEOUT', `Bridge request timed out after ${timeoutMs}ms`, true, { url, timeoutMs });
    }
    throw normalizeBridgeError(error);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function verifyLocalBridge(): Promise<void> {
  const wasConnected = dashboardState.canExecuteCommands;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS) as unknown as number;

  try {
    const response = await fetch(healthUrl(), { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const healthBody = (await response.json()) as { diagnostics?: unknown };
    setBrokerDiagnostics(healthBody.diagnostics);

    setLocalhostMode();

    if (!wasConnected) {
      appendLog({ timestamp: Date.now(), level: 'info', message: `Connected to local bridge: ${LOCAL_BRIDGE_ORIGIN}` });
    }
  } catch (error) {
    setReadOnlyMode('Local bridge server is unavailable.', wasConnected ? 'degraded' : 'disconnected');
    if (wasConnected) {
      appendError({
        timestamp: Date.now(),
        code: 'HOST_UNAVAILABLE',
        message: (error as Error)?.message ?? 'Local bridge unavailable'
      });
      appendLog({ timestamp: Date.now(), level: 'warn', message: 'Lost connection to local bridge server' });
    }
  } finally {
    clearTimeout(timeoutHandle);
    await persistAndBroadcast();
  }
}

async function queryTabs(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> {
  return await chrome.tabs.query(queryInfo);
}

async function getTabOrThrow(tabId: number): Promise<chrome.tabs.Tab> {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    throw createBridgeError('TAB_NOT_FOUND', `Tab not found: ${tabId}`, false, { tabId });
  }
}

function parseSelectorState(value: unknown): 'attached' | 'detached' | 'visible' | 'hidden' {
  if (value === 'attached' || value === 'detached' || value === 'visible' || value === 'hidden') {
    return value;
  }
  return 'attached';
}

function createDebuggerExpression(expression: string, args: unknown[]): string {
  const serializedArgs = JSON.stringify(args);
  return `(() => {
    const args = ${serializedArgs};
    return (${expression});
  })()`;
}

async function evaluateInTabViaDebugger(
  tabId: number,
  expression: string,
  args: unknown[]
): Promise<unknown> {
  const debuggee: chrome.debugger.Debuggee = { tabId };
  let attachedByThisCall = false;

  try {
    try {
      await chrome.debugger.attach(debuggee, '1.3');
      attachedByThisCall = true;
    } catch (error) {
      const message = (error as Error)?.message ?? '';
      if (!message.includes('Another debugger is already attached')) {
        throw error;
      }
    }

    await chrome.debugger.sendCommand(debuggee, 'Runtime.enable');
    const result = (await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
      expression: createDebuggerExpression(expression, args),
      returnByValue: true,
      awaitPromise: true
    })) as {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };

    if (result.exceptionDetails) {
      const description =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        'Runtime.evaluate failed';
      throw new Error(description);
    }

    return result.result?.value ?? null;
  } finally {
    if (attachedByThisCall) {
      await chrome.debugger.detach(debuggee).catch(() => undefined);
    }
  }
}

function inferValueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

async function executeAction(request: BridgeRequest): Promise<{ result?: unknown; meta?: unknown }> {
  const payload = (request.payload ?? {}) as Record<string, unknown>;

  if (request.action === 'ping') {
    return {
      result: {
        status: 'ok',
        hostName: 'extension-worker',
        now: new Date().toISOString(),
        echo: typeof payload.echo === 'string' ? payload.echo : undefined
      }
    };
  }

  if (request.action === 'openTab') {
    const url = typeof payload.url === 'string' ? payload.url : 'about:blank';
    const active = typeof payload.active === 'boolean' ? payload.active : true;
    const tab = await chrome.tabs.create({ url, active });
    return {
      result: {
        tabId: tab.id,
        url: tab.url,
        title: tab.title,
        active: tab.active
      },
      meta: {
        tabId: tab.id,
        url: tab.url
      }
    };
  }

  if (request.action === 'navigate') {
    const tabId = Number(payload.tabId);
    const url = typeof payload.url === 'string' ? payload.url : '';
    if (!Number.isFinite(tabId) || !url) {
      throw createBridgeError('INVALID_PAYLOAD', 'navigate expects payload.tabId and payload.url', false, payload);
    }

    const updated = await chrome.tabs.update(tabId, { url });
    return {
      result: {
        tabId,
        url,
        finalUrl: updated.url ?? url,
        navigatedAt: new Date().toISOString()
      },
      meta: {
        tabId,
        url
      }
    };
  }

  if (request.action === 'getUrl') {
    const tabId = Number(payload.tabId);
    if (!Number.isFinite(tabId)) {
      throw createBridgeError('INVALID_PAYLOAD', 'getUrl expects payload.tabId', false, payload);
    }

    const tab = await getTabOrThrow(tabId);
    return {
      result: {
        tabId,
        url: tab.url ?? ''
      },
      meta: {
        tabId,
        url: tab.url
      }
    };
  }

  if (request.action === 'listTabs') {
    const windowId = typeof payload.windowId === 'number' ? payload.windowId : undefined;
    const includeDiscarded = Boolean(payload.includeDiscarded);
    const tabs = await queryTabs(windowId === undefined ? {} : { windowId });

    return {
      result: {
        tabs: tabs
          .filter((tab) => (includeDiscarded ? true : !tab.discarded))
          .map((tab) => ({
            tabId: tab.id,
            windowId: tab.windowId,
            url: tab.url ?? '',
            title: tab.title ?? '',
            active: Boolean(tab.active)
          }))
      }
    };
  }

  if (request.action === 'activateTab') {
    const tabId = Number(payload.tabId);
    if (!Number.isFinite(tabId)) {
      throw createBridgeError('INVALID_PAYLOAD', 'activateTab expects payload.tabId', false, payload);
    }

    await chrome.tabs.update(tabId, { active: true });
    return {
      result: {
        tabId,
        active: true
      },
      meta: {
        tabId
      }
    };
  }

  if (request.action === 'evaluate') {
    const tabId = Number(payload.tabId);
    const expression = typeof payload.expression === 'string' ? payload.expression : '';
    const evaluationArgs = Array.isArray(payload.args) ? payload.args : [];
    const returnByValue = payload.returnByValue !== false;
    void payload.executionWorld;

    if (!Number.isFinite(tabId) || !expression) {
      throw createBridgeError('INVALID_PAYLOAD', 'evaluate expects payload.tabId and payload.expression', false, payload);
    }

    const value = await evaluateInTabViaDebugger(tabId, expression, evaluationArgs);

    const normalizedValue = returnByValue ? (value ?? null) : String(value ?? '');
    return {
      result: {
        tabId,
        value: normalizedValue,
        valueType: inferValueType(normalizedValue)
      },
      meta: {
        tabId,
        actionPayload: { expression }
      }
    };
  }

  if (request.action === 'waitForSelector') {
    const tabId = Number(payload.tabId);
    const selector = typeof payload.selector === 'string' ? payload.selector : '';
    const state = parseSelectorState(payload.state);
    const pollIntervalMs = typeof payload.pollIntervalMs === 'number' ? payload.pollIntervalMs : 200;
    const timeoutMs = request.timeoutMs > 0 ? request.timeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;

    if (!Number.isFinite(tabId) || !selector) {
      throw createBridgeError('INVALID_PAYLOAD', 'waitForSelector expects payload.tabId and payload.selector', false, payload);
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const matched = await evaluateInTabViaDebugger(
        tabId,
        `(() => {
          const list = Array.from(document.querySelectorAll(args[0]));
          if (args[1] === 'attached') return list.length > 0;
          if (args[1] === 'detached') return list.length === 0;
          if (args[1] === 'visible') {
            return list.some((el) => {
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
            });
          }
          return list.length === 0 || list.every((el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none';
          });
        })()`,
        [selector, state]
      ) as boolean;

      if (matched) {
        return {
          result: {
            tabId,
            selector,
            state,
            matched: true,
            elapsedMs: Date.now() - startedAt
          },
          meta: {
            tabId,
            selector
          }
        };
      }

      await wait(Math.max(50, pollIntervalMs));
    }

    throw createBridgeError('TIMEOUT', `Timed out waiting for selector "${selector}"`, true, {
      tabId,
      selector,
      state,
      timeoutMs
    });
  }

  if (request.action === 'count') {
    const tabId = Number(payload.tabId);
    const selector = typeof payload.selector === 'string' ? payload.selector : '';
    if (!Number.isFinite(tabId) || !selector) {
      throw createBridgeError('INVALID_PAYLOAD', 'count expects payload.tabId and payload.selector', false, payload);
    }

    const count = (await evaluateInTabViaDebugger(
      tabId,
      'document.querySelectorAll(args[0]).length',
      [selector]
    )) as number;

    return {
      result: { tabId, selector, count },
      meta: { tabId, selector }
    };
  }

  if (request.action === 'innerText') {
    const tabId = Number(payload.tabId);
    const selector = typeof payload.selector === 'string' ? payload.selector : '';
    const index = typeof payload.index === 'number' ? payload.index : 0;
    if (!Number.isFinite(tabId) || !selector) {
      throw createBridgeError('INVALID_PAYLOAD', 'innerText expects payload.tabId and payload.selector', false, payload);
    }

    const text = (await evaluateInTabViaDebugger(
      tabId,
      `(() => {
        const element = document.querySelectorAll(args[0]).item(args[1]);
        return element ? (element.innerText || '') : null;
      })()`,
      [selector, index]
    )) as string | null;

    if (text === null) {
      throw createBridgeError('SELECTOR_NOT_FOUND', `No element found for selector "${selector}" at index ${index}`, false, {
        selector,
        index,
        tabId
      });
    }

    return {
      result: { tabId, selector, text },
      meta: { tabId, selector }
    };
  }

  if (request.action === 'click') {
    const tabId = Number(payload.tabId);
    const selector = typeof payload.selector === 'string' ? payload.selector : '';
    const index = typeof payload.index === 'number' ? payload.index : 0;
    if (!Number.isFinite(tabId) || !selector) {
      throw createBridgeError('INVALID_PAYLOAD', 'click expects payload.tabId and payload.selector', false, payload);
    }

    const clicked = (await evaluateInTabViaDebugger(
      tabId,
      `(() => {
        const target = document.querySelectorAll(args[0]).item(args[1]);
        if (!target) return false;
        target.click();
        return true;
      })()`,
      [selector, index]
    )) as boolean;

    if (!clicked) {
      throw createBridgeError('SELECTOR_NOT_FOUND', `No element found for selector "${selector}" at index ${index}`, false, {
        selector,
        index,
        tabId
      });
    }

    return {
      result: { tabId, selector, clicked: true },
      meta: { tabId, selector }
    };
  }

  if (request.action === 'hover') {
    const tabId = Number(payload.tabId);
    const selector = typeof payload.selector === 'string' ? payload.selector : '';
    const index = typeof payload.index === 'number' ? payload.index : 0;
    if (!Number.isFinite(tabId) || !selector) {
      throw createBridgeError('INVALID_PAYLOAD', 'hover expects payload.tabId and payload.selector', false, payload);
    }

    const hovered = (await evaluateInTabViaDebugger(
      tabId,
      `(() => {
        const target = document.querySelectorAll(args[0]).item(args[1]);
        if (!target) return false;
        target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
        return true;
      })()`,
      [selector, index]
    )) as boolean;

    if (!hovered) {
      throw createBridgeError('SELECTOR_NOT_FOUND', `No element found for selector "${selector}" at index ${index}`, false, {
        selector,
        index,
        tabId
      });
    }

    return {
      result: { tabId, selector, hovered: true },
      meta: { tabId, selector }
    };
  }

  if (request.action === 'scrollBy') {
    const tabId = Number(payload.tabId);
    const x = typeof payload.x === 'number' ? payload.x : 0;
    const y = typeof payload.y === 'number' ? payload.y : NaN;
    const behavior = payload.behavior === 'smooth' ? 'smooth' : 'auto';

    if (!Number.isFinite(tabId) || !Number.isFinite(y)) {
      throw createBridgeError('INVALID_PAYLOAD', 'scrollBy expects payload.tabId and payload.y', false, payload);
    }

    const position = (await evaluateInTabViaDebugger(
      tabId,
      `(() => {
        window.scrollBy({ left: args[0], top: args[1], behavior: args[2] });
        return { x: window.scrollX, y: window.scrollY };
      })()`,
      [x, y, behavior]
    )) as { x: number; y: number };

    return {
      result: {
        tabId,
        x,
        y,
        scrollX: position.x,
        scrollY: position.y
      },
      meta: { tabId }
    };
  }

  if (request.action === 'sleep') {
    const durationMs = typeof payload.durationMs === 'number' ? payload.durationMs : NaN;
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw createBridgeError('INVALID_PAYLOAD', 'sleep expects payload.durationMs as non-negative number', false, payload);
    }

    const startedAt = Date.now();
    await wait(durationMs);
    return {
      result: {
        sleptMs: Date.now() - startedAt
      }
    };
  }

  throw createBridgeError('UNSUPPORTED_ACTION', `Unsupported action: ${request.action}`, false, {
    action: request.action
  });
}

async function executeBridgeRequest(request: BridgeRequest, source: RequestSource): Promise<BridgeResponse> {
  const startedAt = Date.now();
  markBridgeActivity();
  const processState: ProcessEntry = {
    requestId: request.requestId,
    action: request.action,
    state: 'running',
    startedAt,
    source
  };

  upsertProcess(processState);
  appendLog({
    timestamp: startedAt,
    level: 'debug',
    message: `Request received (${source}): ${request.action}`,
    requestId: request.requestId,
    source
  });
  await persistAndBroadcast();

  const payloadError = validateRequest(request);
  if (payloadError) {
    const invalidResponse = toFailureResponse(request, startedAt, payloadError);
    upsertProcess({ ...processState, state: 'error', durationMs: invalidResponse.durationMs });
    appendError({
      timestamp: invalidResponse.receivedAt,
      code: payloadError.code,
      message: payloadError.message,
      requestId: request.requestId,
      source
    });
    await persistAndBroadcast();
    return invalidResponse;
  }

  try {
    const actionResult = await executeAction(request);
    const receivedAt = Date.now();
    const response: BridgeResponse = {
      version: '1.0',
      requestId: request.requestId,
      ok: true,
      result: actionResult.result,
      receivedAt,
      durationMs: receivedAt - startedAt
    };

    dashboardState.lastCommandLatencyMs = response.durationMs;

    const tabId =
      actionResult.result && typeof actionResult.result === 'object' && 'tabId' in actionResult.result
        ? Number((actionResult.result as { tabId?: unknown }).tabId)
        : NaN;
    if (Number.isFinite(tabId)) {
      updateActiveTab(tabId);
    }

    upsertProcess({ ...processState, state: 'done', durationMs: response.durationMs });
    appendLog({
      timestamp: receivedAt,
      level: 'info',
      message: `Request completed (${source}): ${request.action}`,
      requestId: request.requestId,
      source
    });

    await persistAndBroadcast();
    return response;
  } catch (error) {
    const bridgeError = normalizeBridgeError(error);
    const failure = toFailureResponse(request, startedAt, bridgeError);

    dashboardState.lastCommandLatencyMs = failure.durationMs;

    upsertProcess({ ...processState, state: 'error', durationMs: failure.durationMs });
    appendError({
      timestamp: failure.receivedAt,
      code: bridgeError.code,
      message: bridgeError.message,
      requestId: request.requestId,
      source,
      stackSnippet:
        bridgeError.details && typeof bridgeError.details === 'object' && 'stackSnippet' in (bridgeError.details as Record<string, unknown>)
          ? String((bridgeError.details as Record<string, unknown>).stackSnippet)
          : undefined
    });
    appendLog({
      timestamp: failure.receivedAt,
      level: 'warn',
      message: `Request failed (${source}): ${request.action}`,
      requestId: request.requestId,
      source
    });

    await persistAndBroadcast();
    return failure;
  }
}

async function runWorkerCycle(): Promise<void> {
  dashboardState.lastHeartbeat = Date.now();
  const heartbeat = (await fetchJson(workerHeartbeatUrl(), { workerId }, HEALTH_CHECK_TIMEOUT_MS)) as {
    diagnostics?: unknown;
  };
  setBrokerDiagnostics(heartbeat.diagnostics);

  const claimed = (await fetchJson(
    workerClaimUrl(),
    {
      workerId,
      waitMs: WORKER_POLL_WAIT_MS
    },
    WORKER_POLL_WAIT_MS + 2_000
  )) as {
    command?: BridgeRequest | null;
    diagnostics?: unknown;
  };

  setBrokerDiagnostics(claimed.diagnostics);

  const request = claimed.command;
  if (!request) {
    try {
      await processSavedImageThumbnail();
    } catch {
      // Best-effort thumbnail processing should not break the worker loop.
    }
    await persistAndBroadcast();
    return;
  }

  const response = await executeBridgeRequest(request, 'node-worker');

  const resultPayload = response.ok
    ? {
        requestId: request.requestId,
        ok: true,
        result: response.result
      }
    : {
        requestId: request.requestId,
        ok: false,
        error: response.error
      };

  const postResult = (await fetchJson(workerResultUrl(), resultPayload, HEALTH_CHECK_TIMEOUT_MS)) as { diagnostics?: unknown };
  setBrokerDiagnostics(postResult.diagnostics);
  try {
    await processSavedImageThumbnail();
  } catch {
    // Best-effort thumbnail processing should not break the worker loop.
  }
  await persistAndBroadcast();
}

function scheduleWorkerTick(delayMs: number): void {
  if (scheduledWorkerTick !== null) {
    clearTimeout(scheduledWorkerTick);
  }
  scheduledWorkerTick = setTimeout(() => {
    scheduledWorkerTick = null;
    void runWorkerTick();
  }, delayMs) as unknown as number;
}

async function runWorkerTick(): Promise<void> {
  if (workerTickInFlight) {
    return;
  }
  workerTickInFlight = true;

  try {
    if (!dashboardState.canExecuteCommands) {
      await verifyLocalBridge();
      if (!dashboardState.canExecuteCommands) {
        const delayMs = Math.min(MAX_RECONNECT_RETRY_MS, MIN_RECONNECT_RETRY_MS * 2 ** reconnectAttempt);
        reconnectAttempt = Math.min(reconnectAttempt + 1, 8);
        scheduleWorkerTick(delayMs);
      } else {
        reconnectAttempt = 0;
      }
      return;
    }

    reconnectAttempt = 0;
    await runWorkerCycle();
    if (shouldHotPoll()) {
      scheduleWorkerTick(HOT_POLL_INTERVAL_MS);
    }
  } catch (error) {
    const bridgeError = normalizeBridgeError(error);
    setReadOnlyMode('Local bridge server is unavailable.', 'degraded');
    appendError({
      timestamp: Date.now(),
      code: bridgeError.code,
      message: bridgeError.message,
      source: 'node-worker'
    });
    appendLog({
      timestamp: Date.now(),
      level: 'warn',
      message: `Worker tick degraded: ${bridgeError.message}`,
      source: 'node-worker'
    });
    await persistAndBroadcast();
    const delayMs = Math.min(MAX_RECONNECT_RETRY_MS, MIN_RECONNECT_RETRY_MS * 2 ** reconnectAttempt);
    reconnectAttempt = Math.min(reconnectAttempt + 1, 8);
    scheduleWorkerTick(delayMs);
  } finally {
    workerTickInFlight = false;
  }
}

async function ensureWorkerAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(WORKER_ALARM_NAME);
  if (existing) {
    return;
  }

  await chrome.alarms.create(WORKER_ALARM_NAME, {
    periodInMinutes: WORKER_ALARM_PERIOD_MINUTES
  });
}

async function resetRecentImagesForDashboardSession(): Promise<void> {
  try {
    const response = (await fetchJson(dashboardResetRecentImagesUrl(), { reason: 'dashboard-reload' }, HEALTH_CHECK_TIMEOUT_MS)) as {
      diagnostics?: unknown;
    };
    setBrokerDiagnostics(response.diagnostics);
  } catch {
    // Ignore reset failures; dashboard can still render stale data if server reset is unavailable.
  }
}

let dashboardHeartbeatHandle: number | null = null;

function startDashboardHeartbeat(): void {
  if (dashboardHeartbeatHandle !== null) {
    return;
  }

  dashboardHeartbeatHandle = setInterval(() => {
    dashboardState.lastHeartbeat = Date.now();
    void persistAndBroadcast();
  }, HEARTBEAT_INTERVAL_MS) as unknown as number;
}

function stopDashboardHeartbeatIfIdle(): void {
  if (dashboardPorts.size > 0 || dashboardHeartbeatHandle === null) {
    return;
  }
  clearInterval(dashboardHeartbeatHandle);
  dashboardHeartbeatHandle = null;
}

async function handleDashboardCommand(command: DashboardCommand): Promise<{ ok: boolean; payload?: unknown }> {
  if (command.type === 'clear-logs-errors') {
    dashboardState.logs = [];
    dashboardState.errors = [];
    dashboardState.runningProcesses = [];
    dashboardState.recentImages = [];
    await persistAndBroadcast();
    return { ok: true };
  }

  if (command.type === 'export-diagnostics') {
    return { ok: true, payload: dashboardState };
  }

  return { ok: false };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'dashboard') {
    dashboardPorts.add(port);
    startDashboardHeartbeat();
    markBridgeActivity();
    dashboardState.recentImages = [];
    void resetRecentImagesForDashboardSession().then(() => {
      void persistAndBroadcast();
    });

    port.onMessage.addListener((message) => {
      if (message?.type === 'keepalive') {
        dashboardState.lastHeartbeat = Date.now();
        markBridgeActivity();
        void runWorkerTick();
        void persistAndBroadcast();
      }
    });

    port.onDisconnect.addListener(() => {
      dashboardPorts.delete(port);
      stopDashboardHeartbeatIfIdle();
    });

    void runWorkerTick();
    return;
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== WORKER_ALARM_NAME) {
    return;
  }
  void runWorkerTick();
});

chrome.runtime.onInstalled.addListener(() => {
  void ensureWorkerAlarm();
  void runWorkerTick();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureWorkerAlarm();
  void runWorkerTick();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'dashboard-command') {
    void handleDashboardCommand(message.command as DashboardCommand).then(sendResponse);
    return true;
  }

  if (message?.type === 'bridge-request') {
    const request = message.request as BridgeRequest;
    void executeBridgeRequest(request, 'dashboard').then(sendResponse);
    return true;
  }

  return false;
});

async function bootstrap(): Promise<void> {
  await loadState();
  setReadOnlyMode('Local bridge server is not connected.', 'disconnected');
  await persistAndBroadcast();
  await ensureWorkerAlarm();
  await verifyLocalBridge();
  await runWorkerTick();
}

void bootstrap();
