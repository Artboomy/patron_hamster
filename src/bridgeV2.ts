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

function waitForDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createRequestId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

const DOM_ACTION_TIMEOUT_MS = 12_000
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

function expectedUrlMatches(actualUrl: string, expectedUrl: string): boolean {
  try {
    const actual = new URL(actualUrl)
    const expected = new URL(expectedUrl)
    if (actual.host !== expected.host) {
      return false
    }
    const actualPath = normalizeComparablePath(actual.pathname)
    const expectedPath = normalizeComparablePath(expected.pathname)
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
    const opened = await this.sendRequest<{ tabId: number }>('openTab', { url, active })
    if (!isAboutBlank(url)) {
      this.expectedTabUrls.set(opened.tabId, url)
    }
    if (active) {
      this.activeTabId = opened.tabId
    }
    return opened
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
    const opened = await this.sendRequest<{ tabId: number }>('openTab', {
      url: preferredUrl || 'about:blank',
      active: true
    })
    this.activeTabId = opened.tabId
    if (preferredUrl && !isAboutBlank(preferredUrl)) {
      this.expectedTabUrls.set(opened.tabId, preferredUrl)
    }
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

  async fetchAsBase64(url: string, tabId?: number): Promise<string> {
    void tabId
    const result = await this.sendRequest<{ base64: string }>('fetchBinary', {
      url
    })
    return result.base64
  }

  async dispose(): Promise<void> {
    return
  }
}
