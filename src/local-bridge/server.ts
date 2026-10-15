import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { type Socket } from 'node:net';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const VERSION = '1.0' as const;
const PORT = Number(process.env.BRIDGE_PORT || 17353);
const HOST = process.env.BRIDGE_HOST || '127.0.0.1';
const MAX_TIMEOUT_MS = 600_000;
const CLAIM_WAIT_MS = 4_000;
const MAX_RECENT_IMAGES = 24;
const MAX_BINARY_CHUNK_BYTES = 1024 * 1024;

type RecentImageRecord = {
  id: string;
  capturedAt: string;
  mimeType: string;
  width: number;
  height: number;
  requestId?: string;
  action?: string;
  bytes: Buffer;
};

type RecentImageMeta = Omit<RecentImageRecord, 'bytes'>;

type PendingSavedImage = {
  id: string;
  capturedAt: string;
  mimeType: string;
  requestId?: string;
  action?: string;
  bytes: Buffer;
};

type BridgeError = {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
};

type BridgeRequest = {
  version: string;
  requestId: string;
  action: string;
  payload: unknown;
  timeoutMs: number;
  sentAt: number | string;
};

type BridgeResponse = {
  version: typeof VERSION;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: BridgeError;
  receivedAt: string;
  durationMs: number;
};

type PendingRequest = {
  request: BridgeRequest;
  startedAt: number;
  claimed: boolean;
  timeoutHandle: NodeJS.Timeout;
  resolve: (value: BridgeResponse) => void;
};

type WorkerResult = {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: BridgeError;
  meta?: {
    tabId?: number;
    url?: string;
    selector?: string;
    stackSnippet?: string;
    actionPayload?: unknown;
  };
};
type BinaryTransfer = {
  response: ServerResponse;
  downloadedBytes: number;
  totalBytes?: number;
  metadataReceived: boolean;
  heldChunk?: Buffer;
  upload?: IncomingMessage;
  onDisconnect: () => void;
};


type BrokerDiagnostics = {
  queueDepth: number;
  claimedCount: number;
  inflightCount: number;
  timeoutCount: number;
  lastWorkerHeartbeat: string | null;
  workerId: string | null;
  recentImages: RecentImageMeta[];
  pendingSavedImageCount?: number;
};

type ClaimWaiter = {
  acceptBinary: boolean;
  resolve: (request: BridgeRequest | null) => void;
  timeoutHandle: NodeJS.Timeout;
};

const pendingRequests = new Map<string, PendingRequest>();
const commandQueue: BridgeRequest[] = [];
const inflightRequestIds = new Set<string>();
const claimWaiters: ClaimWaiter[] = [];
const activeSockets = new Set<Socket>();
const binaryTransfers = new Map<string, BinaryTransfer>();


let claimedCount = 0;
let timeoutCount = 0;
let lastWorkerHeartbeat: string | null = null;
let lastWorkerId: string | null = null;
const recentImages: RecentImageRecord[] = [];
const pendingSavedImages: PendingSavedImage[] = [];
const claimedSavedImages = new Map<string, PendingSavedImage>();

function nowIso(): string {
  return new Date().toISOString();
}

function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,x-worker-id,x-image-request-id,x-image-action,x-image-width,x-image-height,x-total-bytes');
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  setCors(res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function createError(code: string, message: string, retryable: boolean, details?: unknown): BridgeError {
  return {
    code,
    message,
    retryable,
    ...(details === undefined ? {} : { details })
  };
}

function createResponseEnvelope(requestId: string, startedAt: number, result: unknown): BridgeResponse {
  return {
    version: VERSION,
    requestId,
    ok: true,
    result,
    receivedAt: nowIso(),
    durationMs: Date.now() - startedAt
  };
}

function createErrorEnvelope(requestId: string, startedAt: number, error: BridgeError): BridgeResponse {
  return {
    version: VERSION,
    requestId,
    ok: false,
    error,
    receivedAt: nowIso(),
    durationMs: Date.now() - startedAt
  };
}

function getDiagnostics(): BrokerDiagnostics {
  return {
    queueDepth: commandQueue.length,
    claimedCount,
    inflightCount: inflightRequestIds.size,
    timeoutCount,
    lastWorkerHeartbeat,
    workerId: lastWorkerId,
    recentImages: recentImages.map(({ bytes: _bytes, ...rest }) => rest),
    pendingSavedImageCount: pendingSavedImages.length
  };
}

function clampImageDimension(value: string | undefined): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.round(numeric));
}

function createRecentImageId(): string {
  return `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function pushRecentImage(params: {
  mimeType: string;
  width: number;
  height: number;
  requestId?: string;
  action?: string;
  bytes: Buffer;
}): void {
  const next: RecentImageRecord = {
    id: createRecentImageId(),
    capturedAt: nowIso(),
    mimeType: params.mimeType,
    width: params.width,
    height: params.height,
    requestId: params.requestId,
    action: params.action,
    bytes: params.bytes
  };
  recentImages.push(next);
  if (recentImages.length > MAX_RECENT_IMAGES) {
    recentImages.splice(0, recentImages.length - MAX_RECENT_IMAGES);
  }
}

function pushPendingSavedImage(params: {
  mimeType: string;
  requestId?: string;
  action?: string;
  bytes: Buffer;
}): void {
  pendingSavedImages.push({
    id: createRecentImageId(),
    capturedAt: nowIso(),
    mimeType: params.mimeType,
    requestId: params.requestId,
    action: params.action,
    bytes: params.bytes
  });
  if (pendingSavedImages.length > MAX_RECENT_IMAGES * 3) {
    pendingSavedImages.splice(0, pendingSavedImages.length - MAX_RECENT_IMAGES * 3);
  }
}

function validateBridgeRequest(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return 'Request must be an object';

  const candidate = raw as Partial<BridgeRequest>;
  if (candidate.version !== VERSION) return `Invalid version, expected "${VERSION}"`;
  if (typeof candidate.requestId !== 'string' || candidate.requestId.length < 1) return 'requestId must be a non-empty string';
  if (typeof candidate.action !== 'string' || candidate.action.length < 1) return 'action must be a non-empty string';
  if (!Object.prototype.hasOwnProperty.call(candidate, 'payload')) return 'payload is required';
  if (typeof candidate.timeoutMs !== 'number' || !Number.isInteger(candidate.timeoutMs)) return 'timeoutMs must be an integer';
  if (candidate.timeoutMs < 1 || candidate.timeoutMs > MAX_TIMEOUT_MS) return `timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`;
  if (typeof candidate.sentAt !== 'number' && typeof candidate.sentAt !== 'string') {
    return 'sentAt must be a number or an ISO date-time string';
  }

  return null;
}

function dequeueRequestById(requestId: string): void {
  const index = commandQueue.findIndex((item) => item.requestId === requestId);
  if (index >= 0) {
    commandQueue.splice(index, 1);
  }
}

function resolveNextWaiter(request: BridgeRequest): boolean {
  const index = claimWaiters.findIndex((waiter) => waiter.acceptBinary || request.action !== 'fetchBinary');
  if (index < 0) {
    return false;
  }
  const [waiter] = claimWaiters.splice(index, 1);
  clearTimeout(waiter.timeoutHandle);
  waiter.resolve(request);
  return true;
}

function setBinaryHeaders(transfer: BinaryTransfer): void {
  setCors(transfer.response);
  transfer.response.statusCode = 200;
  transfer.response.setHeader('Content-Type', 'application/octet-stream');
  if (transfer.totalBytes !== undefined) {
    transfer.response.setHeader('Content-Length', transfer.totalBytes);
  }
}

function finishBinaryTransfer(requestId: string, response: BridgeResponse): void {
  const transfer = binaryTransfers.get(requestId);
  if (!transfer) return;
  binaryTransfers.delete(requestId);
  const res = transfer.response;
  res.off('close', transfer.onDisconnect);
  res.off('error', transfer.onDisconnect);
  transfer.upload?.destroy();
  if (res.destroyed) return;

  if (response.ok) {
    if (!res.headersSent) setBinaryHeaders(transfer);
    res.end(transfer.heldChunk);
  } else if (res.headersSent) {
    res.destroy();
  } else {
    res.removeHeader('Content-Length');
    const status = response.error?.code === 'LOCAL_TIMEOUT' ? 504
      : response.error?.code === 'BAD_REQUEST' ? 400
      : response.error?.code === 'HOST_SHUTDOWN' ? 503 : 502;
    sendJson(res, status, response);
  }
}

function settlePendingRequest(requestId: string, response: BridgeResponse): void {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  pendingRequests.delete(requestId);
  inflightRequestIds.delete(requestId);
  dequeueRequestById(requestId);
  clearTimeout(pending.timeoutHandle);
  finishBinaryTransfer(requestId, response);
  pending.resolve(response);
}

function failBinaryTransfer(requestId: string, error: BridgeError): void {
  const pending = pendingRequests.get(requestId);
  if (pending) {
    settlePendingRequest(requestId, createErrorEnvelope(requestId, pending.startedAt, error));
  }
}

async function enqueueAndAwaitResult(request: BridgeRequest): Promise<BridgeResponse> {
  if (pendingRequests.has(request.requestId)) {
    return createErrorEnvelope(
      request.requestId,
      Date.now(),
      createError('BAD_REQUEST', `Duplicate requestId: ${request.requestId}`, false)
    );
  }

  return await new Promise<BridgeResponse>((resolve) => {
    const startedAt = Date.now();
    const timeoutHandle = setTimeout(() => {
      const pending = pendingRequests.get(request.requestId);
      if (!pending) {
        return;
      }

      timeoutCount += 1;


      settlePendingRequest(
        request.requestId,
        createErrorEnvelope(
          request.requestId,
          startedAt,
          createError('LOCAL_TIMEOUT', `Bridge command timed out after ${request.timeoutMs}ms`, true, {
            action: request.action,
            timeoutMs: request.timeoutMs,
            requestId: request.requestId
          })
        )
      );
    }, request.timeoutMs);

    const pending: PendingRequest = {
      request,
      startedAt,
      claimed: false,
      timeoutHandle,
      resolve
    };

    pendingRequests.set(request.requestId, pending);

    if (!resolveNextWaiter(request)) {
      commandQueue.push(request);
    }
  });
}

async function claimNextCommand(waitMs: number, acceptBinary: boolean, response: ServerResponse): Promise<BridgeRequest | null> {
  const index = commandQueue.findIndex((request) => acceptBinary || request.action !== 'fetchBinary');
  const immediate = index < 0 ? undefined : commandQueue.splice(index, 1)[0];
  if (immediate) {
    const pending = pendingRequests.get(immediate.requestId);
    if (pending) {
      pending.claimed = true;
      claimedCount += 1;
      inflightRequestIds.add(immediate.requestId);
    }
    return immediate;
  }

  return await new Promise<BridgeRequest | null>((resolve) => {
    const onDisconnect = () => waiter.resolve(null);
    const waiter: ClaimWaiter = {
      acceptBinary,
      timeoutHandle: setTimeout(() => waiter.resolve(null), waitMs),
      resolve: (request) => {
        clearTimeout(waiter.timeoutHandle);
        response.off('close', onDisconnect);
        const waiterIndex = claimWaiters.indexOf(waiter);
        if (waiterIndex >= 0) claimWaiters.splice(waiterIndex, 1);
        if (request) {
          const pending = pendingRequests.get(request.requestId);
          if (pending) {
            pending.claimed = true;
            claimedCount += 1;
            inflightRequestIds.add(request.requestId);
          }
        }
        resolve(request);
      }
    };
    claimWaiters.push(waiter);
    response.once('close', onDisconnect);
  });
}

function sanitizeResultError(result: WorkerResult): BridgeError {
  const normalized = result.error;
  if (normalized && typeof normalized.code === 'string' && typeof normalized.message === 'string') {
    const details = normalized.details && typeof normalized.details === 'object'
      ? normalized.details as Record<string, unknown>
      : {};
    return {
      code: normalized.code,
      message: normalized.message,
      retryable: Boolean(normalized.retryable),
      details: {
        ...details,
        action: pendingRequests.get(result.requestId)?.request.action,
        ...(result.meta ?? {})
      }
    };
  }

  return createError('WORKER_ERROR', 'Worker failed without a valid error envelope', false, {
    action: pendingRequests.get(result.requestId)?.request.action,
    ...(result.meta ?? {})
  });
}

function resolveWithWorkerResult(result: WorkerResult): { statusCode: number; body: unknown } {
  const pending = pendingRequests.get(result.requestId);
  if (!pending) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: createError('UNKNOWN_REQUEST_ID', `No pending request for ${result.requestId}`, false)
      }
    };
  }

  const transfer = binaryTransfers.get(result.requestId);
  if (result.ok && transfer) {
    const downloadedBytes = (result.result as { downloadedBytes?: unknown } | null)?.downloadedBytes;
    if (
      transfer.upload ||
      typeof downloadedBytes !== 'number' ||
      !Number.isSafeInteger(downloadedBytes) ||
      downloadedBytes !== transfer.downloadedBytes ||
      (transfer.totalBytes !== undefined && transfer.totalBytes !== downloadedBytes)
    ) {
      failBinaryTransfer(result.requestId, createError('BINARY_TRANSFER_FAILED', 'Binary transfer completed with inconsistent byte counts or an active upload', false));
      return {
        statusCode: 400,
        body: { ok: false, error: createError('BINARY_TRANSFER_FAILED', 'Invalid binary completion', false) }
      };
    }
  }

  if (result.ok) {
    const responseResult = result.meta
      ? {
          ...(typeof result.result === 'object' && result.result !== null ? (result.result as Record<string, unknown>) : { value: result.result }),
          __meta: result.meta
        }
      : result.result;
    settlePendingRequest(result.requestId, createResponseEnvelope(result.requestId, pending.startedAt, responseResult));
  } else {
    settlePendingRequest(result.requestId, createErrorEnvelope(result.requestId, pending.startedAt, sanitizeResultError(result)));
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      accepted: true,
      diagnostics: getDiagnostics()
    }
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let raw = '';

    req.on('data', (chunk: Buffer | string) => {
      raw += chunk.toString();
    });

    req.on('end', () => {
      if (raw.length === 0) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON payload'));
      }
    });

    req.on('error', reject);
  });
}

async function readBinaryBody(req: IncomingMessage): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

async function forwardBinaryChunk(transfer: BinaryTransfer, chunk: Buffer): Promise<void> {
  const res = transfer.response;
  if (res.destroyed || res.writableEnded) throw new Error('Binary response closed');
  if (!res.headersSent) setBinaryHeaders(transfer);
  await new Promise<void>((resolve, reject) => {
    const onClose = () => finish(new Error('Binary response closed'));
    const finish = (error?: Error | null) => {
      res.off('close', onClose);
      res.off('error', finish);
      if (error) reject(error);
      else resolve();
    };
    res.once('close', onClose);
    res.once('error', finish);
    try {
      res.write(chunk, finish);
    } catch (error) {
      finish(error instanceof Error ? error : new Error('Binary response write failed'));
    }
  });
}

async function acceptBinaryUpload(requestId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const transfer = binaryTransfers.get(requestId);
  if (!transfer || !pendingRequests.get(requestId)?.claimed) {
    res.setHeader('Connection', 'close');
    sendJson(res, 404, { ok: false, error: createError('UNKNOWN_REQUEST_ID', `No claimed binary request for ${requestId}`, false) });
    req.resume();
    return;
  }
  if (transfer.upload) {
    res.setHeader('Connection', 'close');
    sendJson(res, 409, { ok: false, error: createError('BAD_REQUEST', 'A binary chunk upload is already active', false) });
    req.resume();
    failBinaryTransfer(requestId, createError('BINARY_TRANSFER_FAILED', 'Concurrent binary chunk uploads are not supported', false));
    return;
  }

  transfer.upload = req;
  try {
    if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/octet-stream') {
      throw new Error('Binary chunks require application/octet-stream');
    }
    const totalHeader = req.headers['x-total-bytes'];
    let totalBytes: number | undefined;
    if (totalHeader !== undefined) {
      if (typeof totalHeader !== 'string' || !/^(0|[1-9]\d*)$/.test(totalHeader) || !Number.isSafeInteger(Number(totalHeader))) {
        throw new Error('Invalid x-total-bytes header');
      }
      totalBytes = Number(totalHeader);
    }
    if (transfer.metadataReceived && totalBytes !== transfer.totalBytes) {
      throw new Error('Binary total byte count changed between chunks');
    }
    transfer.metadataReceived = true;
    transfer.totalBytes = totalBytes;
    if (Number(req.headers['content-length'] ?? 0) > MAX_BINARY_CHUNK_BYTES) {
      throw new Error('Binary chunk exceeds 1 MiB');
    }

    let chunkBytes = 0;
    for await (const raw of req) {
      const chunk = raw as Buffer;
      chunkBytes += chunk.length;
      if (chunkBytes > MAX_BINARY_CHUNK_BYTES) throw new Error('Binary chunk exceeds 1 MiB');
      if (binaryTransfers.get(requestId) !== transfer) throw new Error('Binary transfer is no longer pending');
      const nextBytes = transfer.downloadedBytes + chunk.length;
      if (!Number.isSafeInteger(nextBytes) || (transfer.totalBytes !== undefined && nextBytes > transfer.totalBytes)) {
        throw new Error('Binary transfer exceeds its declared byte count');
      }
      // Retain the final buffer until the result arrives: Content-Length alone must
      // not let clients accept a complete response before the worker reports success.
      if (transfer.heldChunk) await forwardBinaryChunk(transfer, transfer.heldChunk);
      transfer.heldChunk = chunk;
      transfer.downloadedBytes = nextBytes;
    }
    if (binaryTransfers.get(requestId) !== transfer) throw new Error('Binary transfer is no longer pending');
    transfer.upload = undefined;
    sendJson(res, 200, { ok: true });
  } catch (error) {
    if (transfer.upload === req) transfer.upload = undefined;
    failBinaryTransfer(requestId, createError('BINARY_TRANSFER_FAILED', error instanceof Error ? error.message : 'Binary chunk upload failed', false));
    if (!res.destroyed && !res.writableEnded) {
      res.setHeader('Connection', 'close');
      sendJson(res, 400, { ok: false, error: createError('BINARY_TRANSFER_FAILED', error instanceof Error ? error.message : 'Binary chunk upload failed', false) });
      req.resume();
    }
  }
}

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.method) {
    sendJson(res, 400, { error: 'Bad request' });
    return;
  }
  const parsedUrl = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = parsedUrl.pathname;

  if (req.method === 'OPTIONS') {
    setCors(res);
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method === 'GET' && pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      service: 'patreon-extractor-local-bridge-broker',
      version: VERSION,
      hostName: os.hostname(),
      now: nowIso(),
      diagnostics: getDiagnostics()
    });
    return;
  }

  if (req.method === 'POST' && (pathname === '/v1/message' || pathname === '/v2/binary/message')) {
    const startedAt = Date.now();

    try {
      const requestRaw = await readJsonBody(req);
      const error = validateBridgeRequest(requestRaw);
      const candidate = requestRaw as Partial<BridgeRequest>;
      if (error) {
        sendJson(
          res,
          400,
          createErrorEnvelope(
            typeof candidate.requestId === 'string' ? candidate.requestId : 'unknown',
            startedAt,
            createError('BAD_REQUEST', error, false)
          )
        );
        return;
      }

      const request = requestRaw as BridgeRequest;
      const binary = pathname === '/v2/binary/message';
      if (binary !== (request.action === 'fetchBinary')) {
        sendJson(res, 400, createErrorEnvelope(request.requestId, startedAt, createError('BAD_REQUEST', 'fetchBinary requires /v2/binary/message; other actions require /v1/message', false)));
        return;
      }
      if (binary) {
        if (pendingRequests.has(request.requestId)) {
          sendJson(res, 400, createErrorEnvelope(request.requestId, startedAt, createError('BAD_REQUEST', `Duplicate requestId: ${request.requestId}`, false)));
          return;
        }
        if (res.destroyed) return;
        const onDisconnect = () => {
          res.destroy();
          failBinaryTransfer(request.requestId, createError('CLIENT_DISCONNECTED', 'Binary response client disconnected', false));
        };
        binaryTransfers.set(request.requestId, {
          response: res,
          downloadedBytes: 0,
          metadataReceived: false,
          onDisconnect
        });
        res.once('close', onDisconnect);
        res.once('error', onDisconnect);
      }
      const response = await enqueueAndAwaitResult(request);
      if (!binary) sendJson(res, 200, response);
      return;
    } catch (error) {
      sendJson(
        res,
        400,
        createErrorEnvelope(
          'unknown',
          startedAt,
          createError('BAD_REQUEST', error instanceof Error ? error.message : 'Invalid request', false)
        )
      );
      return;
    }
  }

  if (req.method === 'POST' && pathname.startsWith('/v2/worker/binary/')) {
    let requestId: string;
    try {
      requestId = decodeURIComponent(pathname.slice('/v2/worker/binary/'.length));
    } catch {
      res.setHeader('Connection', 'close');
      sendJson(res, 400, { ok: false, error: createError('BAD_REQUEST', 'Invalid binary requestId encoding', false) });
      req.resume();
      return;
    }
    await acceptBinaryUpload(requestId, req, res);
    return;
  }

  if (req.method === 'POST' && pathname === '/v2/worker/claim') {
    try {
      const body = (await readJsonBody(req)) as { workerId?: unknown; waitMs?: unknown; acceptBinary?: unknown };
      const workerId = typeof body.workerId === 'string' ? body.workerId : null;
      const waitMs =
        typeof body.waitMs === 'number' && Number.isInteger(body.waitMs)
          ? Math.min(Math.max(body.waitMs, 100), 15_000)
          : CLAIM_WAIT_MS;

      if (workerId) {
        lastWorkerId = workerId;
      }

      const command = await claimNextCommand(waitMs, body.acceptBinary !== false, res);
      if (res.destroyed) return;
      sendJson(res, 200, {
        ok: true,
        command,
        diagnostics: getDiagnostics()
      });
      return;
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: createError('BAD_REQUEST', error instanceof Error ? error.message : 'Invalid request', false)
      });
      return;
    }
  }

  if (req.method === 'POST' && pathname === '/v2/worker/result') {
    try {
      const result = (await readJsonBody(req)) as WorkerResult;
      if (!result || typeof result.requestId !== 'string' || typeof result.ok !== 'boolean') {
        sendJson(res, 400, {
          ok: false,
          error: createError('BAD_REQUEST', 'Result must include requestId and ok', false)
        });
        return;
      }

      const handled = resolveWithWorkerResult(result);
      sendJson(res, handled.statusCode, handled.body);
      return;
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: createError('BAD_REQUEST', error instanceof Error ? error.message : 'Invalid request', false)
      });
      return;
    }
  }


  if (req.method === 'POST' && pathname === '/v2/worker/heartbeat') {
    try {
      const body = (await readJsonBody(req)) as { workerId?: unknown };
      const workerId = typeof body.workerId === 'string' ? body.workerId : null;
      if (workerId) {
        lastWorkerId = workerId;
      }
      lastWorkerHeartbeat = nowIso();
      sendJson(res, 200, {
        ok: true,
        now: lastWorkerHeartbeat,
        diagnostics: getDiagnostics()
      });
      return;
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: createError('BAD_REQUEST', error instanceof Error ? error.message : 'Invalid request', false)
      });
      return;
    }
  }

  if (req.method === 'POST' && pathname === '/v2/recent-images/saved') {
    try {
      const mimeType = String(req.headers['content-type'] || '').toLowerCase();
      if (!mimeType.startsWith('image/')) {
        sendJson(res, 400, {
          ok: false,
          error: createError('BAD_REQUEST', 'Saved image upload requires image/* content-type', false)
        });
        return;
      }

      const bytes = await readBinaryBody(req);
      if (bytes.length === 0) {
        sendJson(res, 400, {
          ok: false,
          error: createError('BAD_REQUEST', 'Saved image upload body is empty', false)
        });
        return;
      }

      const requestId =
        typeof req.headers['x-image-request-id'] === 'string' && req.headers['x-image-request-id'].length > 0
          ? req.headers['x-image-request-id']
          : undefined;
      const action =
        typeof req.headers['x-image-action'] === 'string' && req.headers['x-image-action'].length > 0
          ? req.headers['x-image-action']
          : undefined;

      pushPendingSavedImage({ mimeType, requestId, action, bytes });

      sendJson(res, 200, {
        ok: true,
        diagnostics: getDiagnostics()
      });
      return;
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: createError('BAD_REQUEST', error instanceof Error ? error.message : 'Invalid saved image upload', false)
      });
      return;
    }
  }

  if (req.method === 'POST' && pathname === '/v2/worker/claim-saved-image') {
    const savedImage = pendingSavedImages.shift() ?? null;
    if (savedImage) {
      claimedSavedImages.set(savedImage.id, savedImage);
    }
    sendJson(res, 200, {
      ok: true,
      image: savedImage
        ? {
            id: savedImage.id,
            capturedAt: savedImage.capturedAt,
            mimeType: savedImage.mimeType,
            requestId: savedImage.requestId,
            action: savedImage.action,
            binaryPath: `/v2/worker/saved-image/${encodeURIComponent(savedImage.id)}`
          }
        : null,
      diagnostics: getDiagnostics()
    });
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/v2/worker/saved-image/')) {
    const id = decodeURIComponent(pathname.replace('/v2/worker/saved-image/', ''));
    const image = claimedSavedImages.get(id);
    if (!image) {
      sendJson(res, 404, {
        ok: false,
        error: createError('NOT_FOUND', `Saved image not found: ${id}`, false)
      });
      return;
    }

    setCors(res);
    res.statusCode = 200;
    res.setHeader('Content-Type', image.mimeType);
    res.setHeader('Cache-Control', 'no-store');
    res.end(image.bytes);
    claimedSavedImages.delete(id);
    return;
  }

  if (req.method === 'POST' && pathname === '/v2/worker/recent-image') {
    try {
      const mimeType = String(req.headers['content-type'] || '').toLowerCase();
      if (!mimeType.startsWith('image/')) {
        sendJson(res, 400, {
          ok: false,
          error: createError('BAD_REQUEST', 'Recent image upload requires image/* content-type', false)
        });
        return;
      }

      const bytes = await readBinaryBody(req);
      if (bytes.length === 0) {
        sendJson(res, 400, {
          ok: false,
          error: createError('BAD_REQUEST', 'Recent image upload body is empty', false)
        });
        return;
      }

      const width = clampImageDimension(typeof req.headers['x-image-width'] === 'string' ? req.headers['x-image-width'] : undefined);
      const height = clampImageDimension(
        typeof req.headers['x-image-height'] === 'string' ? req.headers['x-image-height'] : undefined
      );
      const requestId =
        typeof req.headers['x-image-request-id'] === 'string' && req.headers['x-image-request-id'].length > 0
          ? req.headers['x-image-request-id']
          : undefined;
      const action =
        typeof req.headers['x-image-action'] === 'string' && req.headers['x-image-action'].length > 0
          ? req.headers['x-image-action']
          : undefined;

      pushRecentImage({ mimeType, width, height, requestId, action, bytes });

      sendJson(res, 200, {
        ok: true,
        diagnostics: getDiagnostics()
      });
      return;
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: createError('BAD_REQUEST', error instanceof Error ? error.message : 'Invalid recent image upload', false)
      });
      return;
    }
  }

  if (req.method === 'GET' && pathname.startsWith('/v2/dashboard/recent-images/')) {
    const id = decodeURIComponent(pathname.replace('/v2/dashboard/recent-images/', ''));
    const image = recentImages.find((item) => item.id === id);
    if (!image) {
      sendJson(res, 404, {
        ok: false,
        error: createError('NOT_FOUND', `Recent image not found: ${id}`, false)
      });
      return;
    }

    setCors(res);
    res.statusCode = 200;
    res.setHeader('Content-Type', image.mimeType);
    res.setHeader('Cache-Control', 'no-store');
    res.end(image.bytes);
    return;
  }

  if (req.method === 'POST' && pathname === '/v2/dashboard/recent-images/reset') {
    recentImages.splice(0, recentImages.length);
    pendingSavedImages.splice(0, pendingSavedImages.length);
    claimedSavedImages.clear();
    sendJson(res, 200, {
      ok: true,
      diagnostics: getDiagnostics()
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found' });
});
server.on('connection', (socket) => {
  activeSockets.add(socket);
  socket.on('close', () => {
    activeSockets.delete(socket);
  });
});

let listening = false;

function resetPendingState(): void {
  for (const pending of pendingRequests.values()) {
    settlePendingRequest(
      pending.request.requestId,
      createErrorEnvelope(
        pending.request.requestId,
        pending.startedAt,
        createError('HOST_SHUTDOWN', 'Bridge broker is shutting down', true)
      )
    );
  }
  pendingRequests.clear();
  binaryTransfers.clear();
  inflightRequestIds.clear();
  commandQueue.splice(0, commandQueue.length);

  for (const waiter of claimWaiters.splice(0, claimWaiters.length)) {
    clearTimeout(waiter.timeoutHandle);
    waiter.resolve(null);
  }
  recentImages.splice(0, recentImages.length);
  pendingSavedImages.splice(0, pendingSavedImages.length);
  claimedSavedImages.clear();
}

function dropAllConnections(): void {
  if ('closeAllConnections' in server && typeof server.closeAllConnections === 'function') {
    server.closeAllConnections();
  }
  if ('closeIdleConnections' in server && typeof server.closeIdleConnections === 'function') {
    server.closeIdleConnections();
  }
  for (const socket of activeSockets) {
    socket.destroy();
  }
  activeSockets.clear();
}

export async function startLocalBridgeServer(): Promise<void> {
  if (listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      listening = true;
      console.log(`Local bridge broker listening on http://${HOST}:${PORT}`);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(PORT, HOST);
  });
}

export async function stopLocalBridgeServer(): Promise<void> {
  if (!listening) {
    return;
  }

  resetPendingState();
  dropAllConnections();

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      listening = false;
      resolve();
    });
  });
}

export async function forceStopLocalBridgeServer(): Promise<void> {
  resetPendingState();
  dropAllConnections();
  if (!listening) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finalize = () => {
      if (settled) return;
      settled = true;
      listening = false;
      resolve();
    };

    const timeoutHandle = setTimeout(() => {
      finalize();
    }, 1_000);

    server.close(() => {
      clearTimeout(timeoutHandle);
      finalize();
    });
  });
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entry) {
  void startLocalBridgeServer().catch((error: unknown) => {
    console.error('Failed to start local bridge broker:', error);
    process.exit(1);
  });
}
