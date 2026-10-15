import fs from 'node:fs'

const BRIDGE_HOST = process.env.BRIDGE_HOST || '127.0.0.1'
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT || 17353)
const BRIDGE_BASE_URL =
  process.env.BRIDGE_BASE_URL || `http://${BRIDGE_HOST}:${BRIDGE_PORT}`

type BridgeError = {
  code: string
  message: string
  retryable: boolean
  details?: unknown
}

type BridgeResponse<TResult = unknown> = {
  requestId: string
  ok: boolean
  result?: TResult
  error?: BridgeError
}
export type BridgeDownloadProgress = {
  downloadedBytes: number
  totalBytes?: number
}


export class BridgeActionError extends Error {
  action: string
  requestId: string
  code: string
  details?: unknown

  constructor(params: {
    action: string
    requestId: string
    code: string
    message: string
    details?: unknown
  }) {
    const detailsPart =
      params.details === undefined
        ? ''
        : ` details=${JSON.stringify(params.details)}`
    super(
      `[bridge:${params.action}] requestId=${params.requestId} code=${params.code} message="${params.message}"${detailsPart}`
    )
    this.name = 'BridgeActionError'
    this.action = params.action
    this.requestId = params.requestId
    this.code = params.code
    this.details = params.details
  }
}

type ListTabsResult = {
  tabs: Array<{
    tabId: number
    windowId: number
    url: string
    title: string
    active: boolean
  }>
}

type HeapUsage = {
  tabId: number
  url: string
  usedSize: number
  totalSize: number
  embedderHeapUsedSize?: number
  backingStorageSize?: number
}

function waitForDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createRequestId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

const DOM_ACTION_TIMEOUT_MS = 12_000
const IMAGE_FETCH_TIMEOUT_MS = 600_000
const HEAP_REPORT_INTERVAL_MS = 10_000
const HEAP_REPORT_TIMEOUT_MS = 5_000

const DOM_ACTION_POLL_MS = 150

function isAboutBlank(url: string): boolean {
  return !url || url === 'about:blank'
}

function normalizeComparablePath(pathname: string): string {
  if (!pathname || pathname === '/') {
    return '/'
  }
  return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
}

function normalizePatreonPath(host: string, pathname: string): string {
  if (host !== 'patreon.com' && !host.endsWith('.patreon.com')) {
    return pathname
  }
  const segments = pathname.split('/')
  if (segments[1] === 'c' || segments[1] === 'cw') {
    return `/${segments.slice(2).join('/')}`
  }
  return pathname
}

export function expectedUrlMatches(actualUrl: string, expectedUrl: string): boolean {
  try {
    const actual = new URL(actualUrl)
    const expected = new URL(expectedUrl)
    if (actual.host !== expected.host) {
      return false
    }
    const actualPath = normalizeComparablePath(
      normalizePatreonPath(actual.host, actual.pathname)
    )
    const expectedPath = normalizeComparablePath(
      normalizePatreonPath(expected.host, expected.pathname)
    )
    if (expectedPath === '/') {
      return true
    }
    return actualPath === expectedPath || actualPath.startsWith(`${expectedPath}/`)
  } catch {
    return false
  }
}

function isTabMissingError(error: unknown): boolean {
  if (!(error instanceof BridgeActionError)) {
    return false
  }
  return error.code === 'TAB_NOT_FOUND' || error.message.includes('No tab with id')
}

export class BridgeV2Runtime {
  private activeTabId: number | null = null
  private expectedTabUrls = new Map<number, string>()
  private tabIdAliases = new Map<number, number>()
  private readonly traceFilePath: string | null
  private readonly binaryTransfers = new Set<Promise<Buffer>>()
  private readonly imageBlockedTabIds = new Set<number>()
  private readonly imageBlockingOperations = new Set<Promise<void>>()
  private readonly ownedTabIds = new Set<number>()
  private readonly heapReports = new Map<number, Promise<void>>()
  private heapReportTimer: NodeJS.Timeout | null = null
  private disposed = false
  constructor(options?: { traceFilePath?: string }) {
    this.traceFilePath =
      typeof options?.traceFilePath === 'string' &&
      options.traceFilePath.trim().length > 0
        ? options.traceFilePath
        : null
  }

  private appendTrace(entry: Record<string, unknown>): void {
    if (!this.traceFilePath) {
      return
    }
    fs.appendFileSync(
      this.traceFilePath,
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      'utf8'
    )
  }

  private startHeapReporting(): void {
    if (!this.traceFilePath || this.heapReportTimer || this.disposed) return
    this.heapReportTimer = setInterval(() => {
      for (const tabId of this.ownedTabIds) {
        void this.reportHeapUsage(tabId, 'interval').catch((error) => {
          console.warn(`Cannot write heap trace for tab ${tabId}: ${String(error)}`)
        })
      }
    }, HEAP_REPORT_INTERVAL_MS)
    this.heapReportTimer.unref()
  }

  private stopHeapReporting(): void {
    if (this.heapReportTimer) clearInterval(this.heapReportTimer)
    this.heapReportTimer = null
  }

  private async reportHeapUsage(tabId: number, reason: string): Promise<void> {
    if (!this.traceFilePath) return
    const pending = this.heapReports.get(tabId)
    if (pending) return pending
    const report = (async () => {
      try {
        const usage = await this.sendRequest<HeapUsage>(
          'getHeapUsage',
          { tabId },
          HEAP_REPORT_TIMEOUT_MS
        )
        this.appendTrace({ phase: 'heap-usage', reason, ...usage })
      } catch (error) {
        this.appendTrace({
          phase: 'heap-usage-error',
          reason,
          tabId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    })()
    this.heapReports.set(tabId, report)
    try {
      await report
    } finally {
      this.heapReports.delete(tabId)
    }
  }

  async inspectHealth(): Promise<{
    baseUrl: string
    ok: boolean
    status: number | null
    body: string | null
    diagnostics: unknown
    error: string | null
  }> {
    try {
      const response = await fetch(`${BRIDGE_BASE_URL}/health`)
      const body = await response.text().catch(() => '')
      let diagnostics: unknown = null
      try {
        const parsed: unknown = body ? JSON.parse(body) : null
        if (parsed && typeof parsed === 'object' && 'diagnostics' in parsed) {
          diagnostics = parsed.diagnostics
        }
      } catch {
        diagnostics = null
      }
      return {
        baseUrl: BRIDGE_BASE_URL,
        ok: response.ok,
        status: response.status,
        body: body || null,
        diagnostics,
        error: null
      }
    } catch (error) {
      return {
        baseUrl: BRIDGE_BASE_URL,
        ok: false,
        status: null,
        body: null,
        diagnostics: null,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }


  private resolveTabId(tabId: number): number {
    let current = tabId
    const visited = new Set<number>()
    while (this.tabIdAliases.has(current) && !visited.has(current)) {
      visited.add(current)
      current = this.tabIdAliases.get(current) as number
    }
    return current
  }

  private rememberTabAlias(fromTabId: number, toTabId: number): void {
    if (fromTabId !== toTabId) {
      this.tabIdAliases.set(fromTabId, toTabId)
    }
  }

  private async waitForHealth(timeoutMs = 10_000): Promise<void> {
    const startedAt = Date.now()
    let lastStatus: number | null = null
    let lastBody: string | null = null
    let lastError: string | null = null
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const healthResponse = await fetch(`${BRIDGE_BASE_URL}/health`)
        lastStatus = healthResponse.status
        lastBody = await healthResponse.text().catch(() => '')
        if (healthResponse.ok) {
          this.appendTrace({
            phase: 'health-ok',
            baseUrl: BRIDGE_BASE_URL,
            status: lastStatus,
            body: lastBody
          })
          return
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
      await waitForDelay(200)
    }
    throw new Error(
      `Timed out waiting for local bridge at ${BRIDGE_BASE_URL}; lastStatus=${String(lastStatus)}; lastError=${lastError || 'none'}; lastBody=${lastBody || 'none'}`
    )
  }

  async ensureReady(): Promise<void> {
    await this.waitForHealth()
  }

  async sendRequest<TResult = unknown>(
    action: string,
    payload: Record<string, unknown>,
    timeoutMs = 30_000
  ): Promise<TResult> {
    const requestId = createRequestId(`req_${action}`)
    const request = {
      version: '1.0',
      requestId,
      action,
      payload,
      timeoutMs,
      sentAt: new Date().toISOString()
    }
    this.appendTrace({ phase: 'request', request })
    const response = await fetch(`${BRIDGE_BASE_URL}/v1/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request)
    })
    const responseText = await response.text()
    this.appendTrace({
      phase: 'response',
      action,
      requestId,
      httpStatus: response.status,
      body: responseText
    })
    if (!response.ok) {
      throw new BridgeActionError({
        action,
        requestId,
        code: 'HTTP_ERROR',
        message: `HTTP ${response.status}${responseText ? ` body=${responseText}` : ''}`
      })
    }
    const body = JSON.parse(responseText) as BridgeResponse<TResult>
    if (!body.ok) {
      throw new BridgeActionError({
        action,
        requestId: body.requestId || requestId,
        code: body.error?.code ?? 'UNKNOWN',
        message: body.error?.message ?? 'Unknown bridge error',
        details: body.error?.details
      })
    }
    return body.result as TResult
  }

  async ping(): Promise<void> {
    await this.sendRequest('ping', { echo: 'scraper-core-v2' })
  }

  async warmupUrl(url: string): Promise<void> {
    const opened = await this.openTab(url, true)
    this.activeTabId = opened.tabId
    this.expectedTabUrls.set(opened.tabId, url)
    await this.sendRequest('navigate', { tabId: opened.tabId, url })
  }

  async openTab(url: string, active = true): Promise<{ tabId: number }> {
    if (this.disposed) throw new Error('Bridge runtime is disposed')
    const opened = await this.sendRequest<{ tabId: number }>('openTab', { url, active })
    this.ownedTabIds.add(opened.tabId)
    this.startHeapReporting()
    if (!isAboutBlank(url)) {
      this.expectedTabUrls.set(opened.tabId, url)
    }
    if (active) {
      this.activeTabId = opened.tabId
    }
    return opened
  }

  async closeTab(tabId: number): Promise<void> {
    // Never resolve recovery aliases here: they can point at a user's own tab.
    if (!this.ownedTabIds.has(tabId)) return
    await this.reportHeapUsage(tabId, 'before-close')
    await this.sendRequest('closeTab', { tabId })
    this.ownedTabIds.delete(tabId)
    this.imageBlockedTabIds.delete(tabId)
    this.expectedTabUrls.delete(tabId)
    for (const [from, to] of this.tabIdAliases) {
      if (from === tabId || to === tabId) this.tabIdAliases.delete(from)
    }
    if (this.activeTabId === tabId) this.activeTabId = null
    if (this.ownedTabIds.size === 0) this.stopHeapReporting()
  }

  async ensureActiveTab(preferredUrl?: string): Promise<number> {
    const listed = await this.sendRequest<ListTabsResult>('listTabs', {})
    const tabs = listed.tabs || []
    const preferred = preferredUrl
      ? tabs.find((tab) => tab.url.includes(new URL(preferredUrl).host))
      : undefined
    const active = tabs.find((tab) => tab.active)
    const picked = preferred || active
    if (picked) {
      this.activeTabId = picked.tabId
      if (!isAboutBlank(picked.url)) {
        this.expectedTabUrls.set(picked.tabId, picked.url)
      }
      await this.sendRequest('activateTab', { tabId: picked.tabId })
      return picked.tabId
    }
    const opened = await this.openTab(preferredUrl || 'about:blank', true)
    return opened.tabId
  }

  getTabIdOrThrow(): number {
    if (this.activeTabId === null) {
      throw new Error('No active V2 tab bound')
    }
    return this.activeTabId
  }

  async navigate(url: string, tabId?: number): Promise<void> {
    const targetTabId = this.resolveTabId(tabId || this.getTabIdOrThrow())
    this.expectedTabUrls.set(targetTabId, url)
    await this.sendRequest('navigate', {
      tabId: targetTabId,
      url
    })
  }

  async setImageRequestsBlocked(blocked: boolean, tabId?: number): Promise<void> {
    if (blocked && this.disposed) {
      throw new Error('Bridge runtime is disposed')
    }
    const requestedTabId = tabId ?? this.getTabIdOrThrow()
    const targetTabId = !blocked && this.imageBlockedTabIds.has(requestedTabId)
      ? requestedTabId
      : this.resolveTabId(requestedTabId)
    // Track before sending so disposal can clean up even if the response is lost.
    if (blocked) this.imageBlockedTabIds.add(targetTabId)
    const operation = (async () => {
      if (!blocked) await this.reportHeapUsage(targetTabId, 'before-unblock')
      await this.sendRequest('setImageRequestsBlocked', {
        tabId: targetTabId,
        blocked
      })
      if (!blocked) this.imageBlockedTabIds.delete(targetTabId)
    })()
    this.imageBlockingOperations.add(operation)
    try {
      await operation
    } finally {
      this.imageBlockingOperations.delete(operation)
    }
    if (blocked) await this.reportHeapUsage(targetTabId, 'images-blocked')
  }

  expectUrl(url: string, tabId?: number): void {
    this.expectedTabUrls.set(tabId || this.getTabIdOrThrow(), url)
  }

  async getUrl(tabId?: number): Promise<string> {
    const targetTabId = this.resolveTabId(tabId || this.getTabIdOrThrow())
    const result = await this.sendRequest<{ url: string }>('getUrl', {
      tabId: targetTabId
    })
    return result.url
  }

  private async getUrlByTabId(tabId: number): Promise<string> {
    const result = await this.sendRequest<{ url: string }>('getUrl', { tabId })
    return result.url
  }

  private async waitForDomActionReady(params: {
    action: string
    tabId: number
    timeoutMs?: number
  }): Promise<number> {
    const { action } = params
    const timeoutMs = params.timeoutMs || DOM_ACTION_TIMEOUT_MS
    const startedAt = Date.now()
    const requestedTabId = params.tabId
    let activeTabId = this.resolveTabId(requestedTabId)
    const expectedUrl = this.expectedTabUrls.get(activeTabId)
    let lastUrl = ''
    let lastProbeError: string | null = null
    let stableUrlStreak = 0

    while (Date.now() - startedAt < timeoutMs) {
      try {
        lastUrl = await this.getUrlByTabId(activeTabId)
      } catch (error) {
        if (isTabMissingError(error)) {
          try {
            activeTabId = await this.ensureActiveTab(expectedUrl)
            this.rememberTabAlias(requestedTabId, activeTabId)
            if (expectedUrl) {
              this.expectedTabUrls.set(activeTabId, expectedUrl)
            }
            continue
          } catch (_recoverError) {
            // fall through to regular retry logging
          }
        }
        lastProbeError =
          error instanceof Error ? error.message : String(error)
        await waitForDelay(DOM_ACTION_POLL_MS)
        continue
      }

      const expectedMatch = !expectedUrl || expectedUrlMatches(lastUrl, expectedUrl)
      if (!isAboutBlank(lastUrl) && expectedMatch) {
        stableUrlStreak += 1
        try {
          await this.sendRequest(
            'evaluate',
            {
              tabId: activeTabId,
              expression:
                '(() => ({ href: location.href, readyState: document.readyState }))()',
              args: [],
              returnByValue: true,
              executionWorld: 'MAIN'
            },
            2_000
          )
          return activeTabId
        } catch (error) {
          // If URL is stable for multiple polls, proceed even when probe is flaky.
          if (stableUrlStreak >= 2) {
            return activeTabId
          }
          if (isTabMissingError(error)) {
            try {
              activeTabId = await this.ensureActiveTab(expectedUrl)
              this.rememberTabAlias(requestedTabId, activeTabId)
              if (expectedUrl) {
                this.expectedTabUrls.set(activeTabId, expectedUrl)
              }
              continue
            } catch (_recoverError) {
              // fall through to regular retry logging
            }
          }
          lastProbeError =
            error instanceof Error ? error.message : String(error)
        }
      } else {
        stableUrlStreak = 0
      }
      await waitForDelay(DOM_ACTION_POLL_MS)
    }

    throw new BridgeActionError({
      action,
      requestId: createRequestId(`req_${action}_ready`),
      code: 'TAB_NOT_READY',
      message: 'Timed out waiting for a script-ready tab',
      details: {
        action,
        tabId: activeTabId,
        timeoutMs,
        expectedUrl: expectedUrl || null,
        lastUrl: lastUrl || null,
        lastProbeError
      }
    })
  }

  async waitForSelector(
    selector: string,
    state: 'attached' | 'detached' | 'visible' | 'hidden' = 'attached',
    timeoutMs = 30_000,
    tabId?: number
  ): Promise<void> {
    const requestedTabId = tabId || this.getTabIdOrThrow()
    const targetTabId = await this.waitForDomActionReady({
      action: 'waitForSelector',
      tabId: this.resolveTabId(requestedTabId),
      timeoutMs
    })
    await this.sendRequest(
      'waitForSelector',
      {
        tabId: targetTabId,
        selector,
        state
      },
      timeoutMs
    )
  }

  async click(selector: string, index = 0, tabId?: number): Promise<void> {
    const requestedTabId = tabId || this.getTabIdOrThrow()
    const targetTabId = await this.waitForDomActionReady({
      action: 'click',
      tabId: this.resolveTabId(requestedTabId)
    })
    await this.sendRequest('click', {
      tabId: targetTabId,
      selector,
      index
    })
  }

  async count(selector: string, tabId?: number): Promise<number> {
    const requestedTabId = tabId || this.getTabIdOrThrow()
    const targetTabId = await this.waitForDomActionReady({
      action: 'count',
      tabId: this.resolveTabId(requestedTabId)
    })
    const result = await this.sendRequest<{ count: number }>('count', {
      tabId: targetTabId,
      selector
    })
    return result.count
  }

  async innerText(selector: string, index = 0, tabId?: number): Promise<string> {
    const requestedTabId = tabId || this.getTabIdOrThrow()
    const targetTabId = await this.waitForDomActionReady({
      action: 'innerText',
      tabId: this.resolveTabId(requestedTabId)
    })
    const result = await this.sendRequest<{ text: string }>('innerText', {
      tabId: targetTabId,
      selector,
      index
    })
    return result.text
  }

  async evaluate<TResult = unknown>(
    expression: string,
    args: unknown[] = [],
    tabId?: number
  ): Promise<TResult> {
    const requestedTabId = tabId || this.getTabIdOrThrow()
    const targetTabId = await this.waitForDomActionReady({
      action: 'evaluate',
      tabId: this.resolveTabId(requestedTabId)
    })
    const result = await this.sendRequest<{ value: TResult }>('evaluate', {
      tabId: targetTabId,
      expression,
      args,
      returnByValue: true,
      executionWorld: 'MAIN'
    })
    return result.value
  }

  async sleep(durationMs: number): Promise<void> {
    await this.sendRequest('sleep', { durationMs })
  }

  async fetchAsBuffer(
    url: string,
    tabId?: number,
    onProgress?: (progress: BridgeDownloadProgress) => void
  ): Promise<Buffer> {
    void tabId
    if (this.disposed) {
      throw new Error('Bridge runtime is disposed')
    }
    const transfer = this.receiveBinary(url, onProgress)
    this.binaryTransfers.add(transfer)
    try {
      return await transfer
    } finally {
      this.binaryTransfers.delete(transfer)
    }
  }

  private async receiveBinary(
    url: string,
    onProgress?: (progress: BridgeDownloadProgress) => void
  ): Promise<Buffer> {
    const requestId = createRequestId('req_fetchBinary')
    const request = {
      version: '1.0',
      requestId,
      action: 'fetchBinary',
      payload: { url },
      timeoutMs: IMAGE_FETCH_TIMEOUT_MS,
      sentAt: new Date().toISOString()
    }
    this.appendTrace({ phase: 'request', request })
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS)
    let downloadedBytes = 0
    try {
      const response = await fetch(`${BRIDGE_BASE_URL}/v2/binary/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal
      })
      if (!response.ok) {
        const body = (await response.json()) as BridgeResponse
        throw new BridgeActionError({
          action: 'fetchBinary',
          requestId,
          code: body.error?.code ?? 'HTTP_ERROR',
          message: body.error?.message ?? `HTTP ${response.status}`,
          details: body.error?.details
        })
      }
      if (!response.body || response.headers.get('content-type') !== 'application/octet-stream') {
        throw new Error('Bridge returned an invalid binary response')
      }
      const length = Number(response.headers.get('content-length'))
      const totalBytes = response.headers.has('content-length') &&
        Number.isSafeInteger(length) && length >= 0 ? length : undefined
      const buffer = totalBytes === undefined ? null : Buffer.allocUnsafe(totalBytes)
      const chunks: Uint8Array[] = []
      const reader = response.body.getReader()
      onProgress?.({ downloadedBytes, totalBytes })
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (buffer) {
          if (downloadedBytes + value.byteLength > buffer.length) {
            throw new Error('Binary response exceeds its declared length')
          }
          buffer.set(value, downloadedBytes)
        } else {
          chunks.push(value)
        }
        downloadedBytes += value.byteLength
        onProgress?.({ downloadedBytes, totalBytes })
      }
      if (totalBytes !== undefined && downloadedBytes !== totalBytes) {
        throw new Error('Binary response ended before its declared length')
      }
      this.appendTrace({ phase: 'response', action: 'fetchBinary', requestId, downloadedBytes })
      return buffer ?? Buffer.concat(chunks, downloadedBytes)
    } catch (error) {
      if (error instanceof BridgeActionError) throw error
      throw new BridgeActionError({
        action: 'fetchBinary',
        requestId,
        code: controller.signal.aborted ? 'LOCAL_TIMEOUT' : 'BINARY_TRANSFER_FAILED',
        message: error instanceof Error ? error.message : String(error),
        details: { url, downloadedBytes }
      })
    } finally {
      clearTimeout(timeout)
      controller.abort()
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.stopHeapReporting()
    await Promise.allSettled(this.binaryTransfers)
    await Promise.allSettled(this.imageBlockingOperations)
    await Promise.allSettled(this.heapReports.values())
    const closed = await Promise.allSettled(
      Array.from(this.ownedTabIds, (tabId) => this.closeTab(tabId))
    )
    const restored = await Promise.allSettled(
      Array.from(this.imageBlockedTabIds, (tabId) =>
        this.setImageRequestsBlocked(false, tabId)
      )
    )
    const errors = [...closed, ...restored]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason)
    if (errors.length) throw new AggregateError(errors, 'Cannot dispose bridge tabs')
    this.expectedTabUrls.clear()
    this.tabIdAliases.clear()
    this.activeTabId = null
  }
}
