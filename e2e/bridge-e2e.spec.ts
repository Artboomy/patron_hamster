import { test, expect, chromium } from '@playwright/test'
import type { BrowserContext, CDPSession } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import http from 'node:http'
import sharp from 'sharp'
import type * as ExtractorModule from '../src/extractor.js'
import type * as BridgePageModule from '../src/bridgePageShim.js'

const E2E_BRIDGE_PORT = '17363'
process.env.BRIDGE_PORT = E2E_BRIDGE_PORT
process.env.BRIDGE_BASE_URL = `http://127.0.0.1:${E2E_BRIDGE_PORT}`

type MockServer = {
  baseUrl: string
  fixtureImagePath: string
  close: () => Promise<void>
}

type RuntimeLike = {
  ensureReady: () => Promise<void>
  ping: () => Promise<void>
  openTab: (url: string, active?: boolean) => Promise<{ tabId: number }>
  closeTab: (tabId: number) => Promise<void>
  setImageRequestsBlocked: (blocked: boolean, tabId?: number) => Promise<void>
  sendRequest: <T = unknown>(action: string, payload?: Record<string, unknown>, timeoutMs?: number) => Promise<T>
  navigate: (url: string, tabId?: number) => Promise<void>
  waitForSelector: (
    selector: string,
    state?: 'attached' | 'detached' | 'visible' | 'hidden',
    timeoutMs?: number,
    tabId?: number
  ) => Promise<void>
  evaluate: <T = unknown>(expression: string, args?: unknown[], tabId?: number) => Promise<T>
  fetchAsBuffer: (
    url: string,
    tabId?: number,
    onProgress?: (progress: { downloadedBytes: number; totalBytes?: number }) => void
  ) => Promise<Buffer>
  dispose: () => Promise<void>
}

type PageShimLike = {
  goto: (url: string) => Promise<void>
  waitForSelector: (
    selector: string,
    options?: { state?: 'attached' | 'detached' | 'visible' | 'hidden'; timeout?: number }
  ) => Promise<void>
  evaluate: <T = unknown>(pageFunction: string | ((arg?: unknown) => T), arg?: unknown) => Promise<T>
  locator: (
    selector: string,
    options?: { hasText?: string | RegExp }
  ) => {
    count: () => Promise<number>
    nth: (index: number) => { innerText: () => Promise<string> }
    click: () => Promise<void>
  }
  on: (event: 'response', listener: (response: { body: () => Promise<Buffer> }) => void) => void
  waitForEvent: (event: 'download') => Promise<{ saveAs: (filePath: string) => Promise<void> }>
}

function distModuleUrl(modulePathFromRoot: string): string {
  return pathToFileURL(path.resolve(process.cwd(), modulePathFromRoot)).href
}

async function waitForPing(runtime: RuntimeLike, timeoutMs = 30_000): Promise<void> {
  const startedAt = Date.now()
  let lastError: unknown = null
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await runtime.ping()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }
  throw new Error(`Timed out waiting for bridge worker ping: ${String(lastError)}`)
}

async function settleWithTimeout(
  label: string,
  fn: () => Promise<void>,
  timeoutMs = 15_000
): Promise<void> {
  await Promise.race([
    fn(),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    })
  ])
}

async function trySettleWithTimeout(
  label: string,
  fn: () => Promise<void>,
  timeoutMs = 15_000
): Promise<boolean> {
  try {
    await settleWithTimeout(label, fn, timeoutMs)
    return true
  } catch (error) {
    console.warn(
      `[bridge-e2e] teardown warning: ${label} failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return false
  }
}

test.describe('Bridge E2E', () => {
  let context: BrowserContext | null = null
  let userDataDir = ''
  let runtime: RuntimeLike | null = null
  let page: PageShimLike | null = null
  let tabId: number | null = null
  let mockServer: MockServer | null = null
  let stopLocalBridgeServer: (() => Promise<void>) | null = null
  let forceStopLocalBridgeServer: (() => Promise<void>) | null = null

  test.beforeAll(async () => {
    const { startMockSiteServer } = (await import(
      distModuleUrl('dist/local-bridge/mock-site-server.js')
    )) as {
      startMockSiteServer: () => Promise<MockServer>
    }

    const bridgeServer = (await import(
      distModuleUrl('dist/local-bridge/server.js')
    )) as {
      startLocalBridgeServer: () => Promise<void>
      stopLocalBridgeServer: () => Promise<void>
      forceStopLocalBridgeServer: () => Promise<void>
    }

    await test.step('Arrange: start mock server and local bridge broker', async () => {
      mockServer = await startMockSiteServer()
      await bridgeServer.startLocalBridgeServer()
      stopLocalBridgeServer = bridgeServer.stopLocalBridgeServer
      forceStopLocalBridgeServer = bridgeServer.forceStopLocalBridgeServer
    })
  })

  test.beforeEach(async () => {
    if (!mockServer) {
      throw new Error('Mock server is not initialized')
    }

    const { BridgeV2Runtime } = (await import(
      distModuleUrl('dist/bridgeV2.js')
    )) as {
      BridgeV2Runtime: new () => RuntimeLike
    }

    const extensionPath = path.resolve(process.cwd(), 'dist/extension-bridge-v2')
    expect(fs.existsSync(path.join(extensionPath, 'manifest.json'))).toBe(true)

    await test.step('Arrange: launch Chromium with extension loaded', async () => {
      userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-e2e-'))
      context = await chromium.launchPersistentContext(userDataDir, {
        channel: 'chromium',
        headless: test.info().project.use.headless ?? true,
        viewport: { width: 1366, height: 900 },
        args: [
          `--disable-extensions-except=${extensionPath}`,
          `--load-extension=${extensionPath}`
        ]
      })

      let serviceWorker = context.serviceWorkers()[0]
      if (!serviceWorker) {
        serviceWorker = await context.waitForEvent('serviceworker', {
          timeout: 15_000
        })
      }
      expect(serviceWorker).toBeTruthy()
    })

    await test.step('Arrange: initialize runtime and wait for bridge ping', async () => {
      runtime = new BridgeV2Runtime()
      await runtime.ensureReady()
      await waitForPing(runtime)
    })

    page = null
    tabId = null
  })

  test.afterEach(async () => {
    if (runtime) {
      await runtime.dispose()
      runtime = null
    }
    if (context) {
      await context.close()
      context = null
    }
    if (userDataDir) {
      fs.rmSync(userDataDir, { recursive: true, force: true })
      userDataDir = ''
    }
  })

  test.afterAll(async () => {
    await test.step('Teardown: stop local services', async () => {
      if (stopLocalBridgeServer) {
        const graceful = await trySettleWithTimeout(
          'stopLocalBridgeServer',
          stopLocalBridgeServer
        )
        if (!graceful && forceStopLocalBridgeServer) {
          await settleWithTimeout(
            'forceStopLocalBridgeServer',
            forceStopLocalBridgeServer,
            5_000
          )
        }
      }
      if (mockServer) {
        await settleWithTimeout('mockServer.close', mockServer.close, 5_000)
      }
    })
  })

  test('race protection: about:blank -> delayed page remains script-usable', async () => {
    if (!runtime || !mockServer) throw new Error('Runtime fixtures not initialized')

    await test.step('Arrange: open about:blank tab and delayed route URL', async () => {
      const raceUrl = `${mockServer.baseUrl}/slow?ms=700`
      const opened = await runtime.openTab('about:blank', true)
      tabId = opened.tabId

      await test.step('Act: navigate and immediately wait for selector', async () => {
        const navigatePromise = runtime.navigate(raceUrl, tabId as number)
        await runtime.waitForSelector('#title', 'attached', 10_000, tabId as number)
        await navigatePromise
      })
    })

    await test.step('Assert: evaluate returns expected title after race window', async () => {
      const title = await runtime.evaluate<string>('document.title', [], tabId as number)
      expect(title).toBe('Bridge Mock Page')
    })

    const { BridgePageShim } = (await import(
      distModuleUrl('dist/bridgePageShim.js')
    )) as {
      BridgePageShim: new (runtime: RuntimeLike, tabId: number, initialUrl?: string) => PageShimLike
    }

    page = new BridgePageShim(runtime, tabId as number, `${mockServer.baseUrl}/slow?ms=700`)
  })

  test('dom operations: evaluate/count/text/click', async () => {
    if (!runtime || !mockServer) throw new Error('Runtime fixtures not initialized')

    const { BridgePageShim } = (await import(
      distModuleUrl('dist/bridgePageShim.js')
    )) as {
      BridgePageShim: new (runtime: RuntimeLike, tabId: number, initialUrl?: string) => PageShimLike
    }

    await test.step('Arrange: open tab and create page shim', async () => {
      const opened = await runtime.openTab(mockServer.baseUrl, true)
      tabId = opened.tabId
      page = new BridgePageShim(runtime, tabId, mockServer.baseUrl)
      await page.waitForSelector('#next-link', { state: 'visible', timeout: 10_000 })
    })

    await test.step('Act: perform DOM operations', async () => {
      const pageTitle = await page!.evaluate<string>('document.title')
      const itemCount = await page!.locator('.item').count()
      const secondItemText = await page!.locator('.item').nth(1).innerText()
      await page!.locator('#action-button').click()
      const clicked = await page!.evaluate<string>(
        'document.body.getAttribute("data-clicked") || ""'
      )

      await test.step('Assert: values are correct', async () => {
        expect(pageTitle).toBe('Bridge Mock Page')
        expect(itemCount).toBe(2)
        expect(secondItemText.trim()).toBe('Item 2')
        expect(clicked).toBe('1')
      })
    })
  })

  test('throwing evaluations release exception graphs while image interception stays attached', async () => {
    if (!runtime || !context || !mockServer) throw new Error('Runtime fixtures not initialized')
    test.setTimeout(90_000)
    const imageBytes = fs.readFileSync(mockServer.fixtureImagePath)
    let imageRequests = 0
    const server = http.createServer((req, res) => {
      if (req.url?.startsWith('/image.png')) {
        imageRequests += 1
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
        res.end(imageBytes)
      } else {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<!doctype html><title>Heap fixture</title><main id="ready">Ready</main>')
      }
    })
    const listening = Promise.withResolvers<void>()
    server.listen(0, '127.0.0.1', listening.resolve)
    await listening.promise
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture address')
    const url = `http://127.0.0.1:${address.port}/`
    let cdp: CDPSession | undefined
    try {
      const opened = await runtime.openTab(url, true)
      await runtime.waitForSelector('#ready', 'attached', 10_000, opened.tabId)
      const browserPage = context.pages().find((candidate) => candidate.url() === url)
      if (!browserPage) throw new Error('Heap fixture tab was not created')
      const unrelatedPage = await context.newPage()
      await unrelatedPage.goto('about:blank')

      type HeapUsage = {
        tabId: number
        url: string
        usedSize: number
        totalSize: number
        embedderHeapUsedSize?: number
        backingStorageSize?: number
      }
      const readHeap = async (): Promise<HeapUsage> => {
        const heap = await runtime!.sendRequest<HeapUsage>('getHeapUsage', { tabId: opened.tabId })
        expect(heap.tabId).toBe(opened.tabId)
        expect(heap.url).toBe(url)
        expect(heap.usedSize).toBeGreaterThan(0)
        expect(heap.totalSize).toBeGreaterThanOrEqual(heap.usedSize)
        for (const size of [heap.embedderHeapUsedSize, heap.backingStorageSize]) {
          if (size !== undefined) expect(size).toBeGreaterThanOrEqual(0)
        }
        return heap
      }
      // Exercise the ordinary acquire/release path before retaining interception.
      await readHeap()
      expect(await runtime.evaluate('({ nested: [1, "two", null], ok: true })', [], opened.tabId))
        .toEqual({ nested: [1, 'two', null], ok: true })

      // HeapProfiler is unavailable to chrome.debugger. Only this secondary
      // Playwright CDP session forces GC, never the production heap action.
      cdp = await context.newCDPSession(browserPage)
      await runtime.setImageRequestsBlocked(true, opened.tabId)
      const postGcHeap = async (): Promise<number> => {
        await cdp!.send('HeapProfiler.collectGarbage')
        return (await readHeap()).usedSize
      }
      const loadImage = (id: string): Promise<string> => runtime!.evaluate<string>(
        `(() => {
          const { promise, resolve } = Promise.withResolvers();
          const image = new Image();
          image.onload = () => resolve('loaded');
          image.onerror = () => resolve('blocked');
          image.src = args[0];
          return promise;
        })()`,
        [`${url}image.png?${id}`],
        opened.tabId
      )
      expect(await loadImage('before')).toBe('blocked')
      const baseline = await postGcHeap()
      for (let batch = 0; batch < 2; batch += 1) {
        for (let index = 0; index < 8; index += 1) {
          await expect(runtime.evaluate(
            `(() => {
              const error = new Error('retained-array-regression');
              error.retained = new Array(1_000_000).fill(args[0]);
              throw error;
            })()`,
            [batch * 8 + index],
            opened.tabId
          )).rejects.toThrow(/retained-array-regression/)
        }
        // Each batch would retain at least ~32 MiB if exception handles leaked.
        expect(await postGcHeap()).toBeLessThan(baseline + 12 * 1024 * 1024)
        expect(await loadImage(`after-${batch}`)).toBe('blocked')
        expect(imageRequests).toBe(0)
      }
      expect(await runtime.evaluate('({ answer: 42, values: [false, null] })', [], opened.tabId))
        .toEqual({ answer: 42, values: [false, null] })
      await runtime.setImageRequestsBlocked(false, opened.tabId)
      expect(await loadImage('restored')).toBe('loaded')
      expect(imageRequests).toBe(1)
      await cdp.detach()
      cdp = undefined

      for (const action of ['closeTab', 'getHeapUsage']) {
        for (const invalidTabId of [null, '1', -1, 1.5]) {
          await expect(runtime.sendRequest(action, { tabId: invalidTabId }))
            .rejects.toMatchObject({ code: 'INVALID_PAYLOAD' })
        }
      }
      // Closing an actively intercepted tab must leave no paused requests or
      // debugger attachment, and must never close an unrelated browser tab.
      await runtime.setImageRequestsBlocked(true, opened.tabId)
      expect(await runtime.sendRequest('closeTab', { tabId: opened.tabId }))
        .toEqual({ tabId: opened.tabId, closed: true })
      await expect.poll(() => browserPage.isClosed()).toBe(true)
      expect(await runtime.sendRequest('closeTab', { tabId: opened.tabId }))
        .toEqual({ tabId: opened.tabId, closed: true })
      await runtime.closeTab(opened.tabId)
      expect(unrelatedPage.isClosed()).toBe(false)
      await expect(runtime.sendRequest('getHeapUsage', { tabId: opened.tabId }))
        .rejects.toMatchObject({ code: 'TAB_NOT_FOUND' })
    } finally {
      if (cdp) await cdp.detach().catch(() => undefined)
      server.closeAllConnections()
      const closed = Promise.withResolvers<void>()
      server.close(() => closed.resolve())
      await closed.promise
    }
  })

  test('context close and runtime disposal close only scraper-owned tabs', async () => {
    if (!runtime || !context || !mockServer) throw new Error('Runtime fixtures not initialized')
    // Load compiled modules only after configuring the isolated test broker.
    const { BridgeContextShim } = await import(distModuleUrl('dist/bridgePageShim.js')) as typeof BridgePageModule
    const unrelated = await context.newPage()
    await unrelated.goto(`${mockServer.baseUrl}/?unrelated`)
    const browserContext = context
    const initialPages = new Set(browserContext.pages())
    const scraperContext = new BridgeContextShim(runtime as never)
    const first = await scraperContext.newPage()
    const firstUrl = `${mockServer.baseUrl}/?owned=context-first`
    await first.goto(firstUrl)
    await first.waitForSelector('#title')
    const second = await scraperContext.newPage()
    const secondUrl = `${mockServer.baseUrl}/?owned=context-second`
    await second.goto(secondUrl)
    await second.waitForSelector('#title')
    const firstBrowserPage = browserContext.pages().find((candidate) => candidate.url() === firstUrl)
    const secondBrowserPage = browserContext.pages().find((candidate) => candidate.url() === secondUrl)
    if (!firstBrowserPage || !secondBrowserPage) throw new Error('Context-owned tabs were not created')
    await secondBrowserPage.close()
    await scraperContext.close()
    await scraperContext.close()
    await expect.poll(() => firstBrowserPage.isClosed()).toBe(true)
    expect(secondBrowserPage.isClosed()).toBe(true)
    expect(new Set(browserContext.pages())).toEqual(initialPages)
    expect(await unrelated.title()).toBe('Bridge Mock Page')

    const disposalContext = new BridgeContextShim(runtime as never)
    const live = await disposalContext.newPage()
    const liveUrl = `${mockServer.baseUrl}/?owned=dispose-live`
    await live.goto(liveUrl)
    await live.waitForSelector('#title')
    const removed = await disposalContext.newPage()
    const removedUrl = `${mockServer.baseUrl}/?owned=dispose-removed`
    await removed.goto(removedUrl)
    await removed.waitForSelector('#title')
    const liveBrowserPage = browserContext.pages().find((candidate) => candidate.url() === liveUrl)
    const removedBrowserPage = browserContext.pages().find((candidate) => candidate.url() === removedUrl)
    if (!liveBrowserPage || !removedBrowserPage) throw new Error('Disposal-owned tabs were not created')
    await removedBrowserPage.close()
    await runtime.dispose()
    await runtime.dispose()
    await disposalContext.close()
    await expect.poll(() => liveBrowserPage.isClosed()).toBe(true)
    expect(removedBrowserPage.isClosed()).toBe(true)
    expect(new Set(browserContext.pages())).toEqual(initialPages)
    expect(unrelated.isClosed()).toBe(false)
    expect(await unrelated.title()).toBe('Bridge Mock Page')
  })

  test('image acquisition: download and binary fetch match fixture', async () => {
    if (!runtime || !mockServer) throw new Error('Runtime fixtures not initialized')

    const { BridgePageShim } = (await import(
      distModuleUrl('dist/bridgePageShim.js')
    )) as {
      BridgePageShim: new (runtime: RuntimeLike, tabId: number, initialUrl?: string) => PageShimLike
    }

    let imageUrl = ''
    await test.step('Arrange: open mock page and prepare fixture/output', async () => {
      const opened = await runtime.openTab(mockServer.baseUrl, true)
      tabId = opened.tabId
      page = new BridgePageShim(runtime, tabId, mockServer.baseUrl)
      await page.waitForSelector('#download-link', { state: 'visible', timeout: 10_000 })
      imageUrl = await page.evaluate<string>((selector) => {
        const image = document.querySelector(String(selector))
        return image instanceof HTMLImageElement ? image.src : ''
      }, '#sample-image')
      expect(imageUrl).toContain('/assets/protected.png')
    })

    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-download-'))
    try {
      await test.step('Act: page-context fetch fails but bridge fetchAsBuffer succeeds', async () => {
        await expect(
          runtime!.evaluate<number>(
            `((targetUrl) => fetch(targetUrl, { credentials: 'include' })
              .then((res) => res.arrayBuffer())
              .then((buf) => buf.byteLength))(args[0])`,
            [imageUrl],
            tabId as number
          )
        ).rejects.toThrow(/Failed to fetch/)

        const progressUpdates: Array<{ downloadedBytes: number; totalBytes?: number }> = []
        const decoded = await runtime!.fetchAsBuffer(
          `${imageUrl}?progress=1`,
          tabId as number,
          (progress) => progressUpdates.push(progress)
        )
        const expected = fs.readFileSync(mockServer.fixtureImagePath)
        expect(decoded.equals(expected)).toBe(true)
        expect(progressUpdates.some(({ totalBytes }) => totalBytes === expected.length)).toBe(true)
      })

      await test.step('Assert: triggered download saves the fixture image', async () => {
        const downloadPromise = page!.waitForEvent('download')
        await page!.locator('#download-link').click()
        const download = await downloadPromise
        await download.saveAs(path.join(outputDir, 'downloaded.png'))

        const expected = fs.readFileSync(mockServer.fixtureImagePath)
        const saved = fs.readFileSync(path.join(outputDir, 'downloaded.png'))
        expect(saved.equals(expected)).toBe(true)
      })
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true })
    }
  })

  test('tab commands and shutdown remain coordinated with saturated binary transfers', async () => {
    if (!runtime || !mockServer) throw new Error('Runtime fixtures not initialized')
    const opened = await runtime.openTab(mockServer.baseUrl, true)
    await runtime.waitForSelector('#title', 'attached', 10_000, opened.tabId)
    const expected = Buffer.alloc(2 * 1024 * 1024 + 17, 0x5a)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started: string[] = []
    const server = http.createServer(async (req, res) => {
      started.push(req.url || '')
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': expected.length
      })
      res.write(expected.subarray(0, 1024 * 1024))
      await gate
      res.end(expected.subarray(1024 * 1024))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture address')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const transfers = [1, 2, 3].map((id) => runtime!.fetchAsBuffer(`${baseUrl}/${id}`))
    const results = Promise.all(transfers)
    // Attach failure handling immediately; teardown still releases all pending source responses.
    void results.catch(() => undefined)
    try {
      await expect.poll(() => started.length).toBe(2)
      await settleWithTimeout('DOM command while binary slots are occupied', async () => {
        await runtime!.waitForSelector('#title', 'attached', 5_000, opened.tabId)
        expect(await runtime!.evaluate('document.title', [], opened.tabId)).toBe('Bridge Mock Page')
      }, 8_000)
      expect(started.length).toBe(2)
      let disposed = false
      const closing = runtime.dispose().then(() => { disposed = true })
      await Promise.resolve()
      expect(disposed).toBe(false)
      release()
      const buffers = await results
      for (const buffer of buffers) expect(buffer.equals(expected)).toBe(true)
      await closing
      expect(disposed).toBe(true)
      expect(started.sort()).toEqual(['/1', '/2', '/3'])
    } finally {
      release()
      await Promise.allSettled(transfers)
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('binary transfer rejects truncated sources and handles empty and failed sources', async () => {
    if (!runtime) throw new Error('Runtime fixtures not initialized')
    let truncate!: () => void
    const gate = new Promise<void>((resolve) => { truncate = resolve })
    const server = http.createServer(async (req, res) => {
      if (req.url === '/missing') {
        res.writeHead(404)
        res.end()
      } else if (req.url === '/empty') {
        res.writeHead(200, { 'content-length': 0 })
        res.end()
      } else {
        res.writeHead(200, { 'content-length': 2 * 1024 * 1024 })
        res.write(Buffer.alloc(1024 * 1024, 0x42))
        await gate
        res.destroy()
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture address')
    const baseUrl = `http://127.0.0.1:${address.port}`
    try {
      await expect(runtime.fetchAsBuffer(`${baseUrl}/missing`)).rejects.toMatchObject({ code: 'HTTP_ERROR' })
      const partial = runtime.fetchAsBuffer(`${baseUrl}/truncated`, undefined, ({ downloadedBytes }) => {
        if (downloadedBytes > 0) truncate()
      })
      await expect(partial).rejects.toMatchObject({ code: 'BINARY_TRANSFER_FAILED' })
      expect(await runtime.fetchAsBuffer(`${baseUrl}/empty`)).toEqual(Buffer.alloc(0))
    } finally {
      truncate()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  for (const failSecondImage of [false, true]) {
    test(`Patreon collects blocked carousel URLs before downloading and restores images after ${failSecondImage ? 'failure' : 'success'}`, async () => {
      if (!runtime || !mockServer) throw new Error('Runtime fixtures not initialized')
      const html = fs.readFileSync('test-fixtures/patreon/carousel.html', 'utf8')
      const imageBytes = failSecondImage
        ? fs.readFileSync(mockServer.fixtureImagePath)
        : await sharp({ create: { width: 120, height: 80, channels: 4, background: '#80402080' } }).png().toBuffer()
      const slides: number[] = []
      const requests: Array<{ path: string; destination: string; slide: number | undefined }> = []
      const server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        if (url.pathname === '/slide') {
          slides.push(Number(url.searchParams.get('index')))
          res.end('ok')
        } else if (url.pathname.endsWith('.png')) {
          requests.push({
            path: url.pathname,
            destination: String(req.headers['sec-fetch-dest'] || ''),
            slide: slides.at(-1)
          })
          if (failSecondImage && url.pathname.includes('/image-two/')) {
            res.writeHead(404)
            res.end()
          } else {
            res.writeHead(200, { 'content-type': 'image/png', 'content-length': imageBytes.length })
            res.end(imageBytes)
          }
        } else {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end(html)
        }
      })
      const listening = Promise.withResolvers<void>()
      server.listen(0, '127.0.0.1', listening.resolve)
      await listening.promise
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing fixture address')
      const baseUrl = `http://127.0.0.1:${address.port}`
      const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patreon-carousel-'))
      fs.writeFileSync(path.join(outputDir, 'visited.txt'), '')
      try {
        // Load compiled modules after bridge environment setup; static imports would capture the default broker port.
        const { Extractor } = await import(distModuleUrl('dist/extractor.js')) as typeof ExtractorModule
        const { BridgePageShim } = await import(distModuleUrl('dist/bridgePageShim.js')) as typeof BridgePageModule
        const opened = await runtime.openTab('about:blank')
        const postPage = new BridgePageShim(runtime as never, opened.tabId)
        const extractor = new Extractor(postPage, {} as never, {
          outDir: outputDir,
          updateMode: false,
          resize: failSecondImage ? undefined : { width: 60, height: 30 }
        })
        extractor.sourceUrl = baseUrl
        const saving = extractor.savePost('/fixture/posts/synthetic-gallery-700001', outputDir, postPage)
        if (failSecondImage) {
          await expect(saving).rejects.toMatchObject({ action: 'fetchBinary', code: 'HTTP_ERROR' })
        } else {
          await saving
          const markdown = fs.readFileSync(path.join(outputDir, 'synthetic-gallery-700001.md'), 'utf8')
          for (const id of ['image-one', 'image-two', 'image-three']) {
            const fileName = `synthetic-gallery-700001-${id}.png`
            expect(await sharp(path.join(outputDir, fileName)).metadata()).toMatchObject({ width: 45, height: 30, hasAlpha: true })
            expect(markdown).toContain(fileName)
          }
        }
        expect(slides).toEqual([0, 1, 2])
        const expectedIds = failSecondImage ? ['image-one', 'image-two'] : ['image-one', 'image-two', 'image-three']
        expect(requests.map((request) => request.path)).toEqual(expectedIds.map(
          (id) => `/media/p/post/700001/${id}/eyJxIjoxMDAsIndlYnAiOjB9/1.png`
        ))
        // Every network image transfer starts after discovery, and none is a browser Image request.
        expect(requests.every((request) => request.slide === 2 && request.destination !== 'image')).toBe(true)
        if (failSecondImage) {
          expect(fs.readFileSync(path.join(outputDir, 'synthetic-gallery-700001-image-one.png')).equals(imageBytes)).toBe(true)
          expect(fs.existsSync(path.join(outputDir, 'synthetic-gallery-700001-image-two.png'))).toBe(false)
          expect(fs.existsSync(path.join(outputDir, 'synthetic-gallery-700001-image-three.png'))).toBe(false)
        }
        const restored = await runtime.evaluate<number>(
          `(() => {
            const { promise, resolve, reject } = Promise.withResolvers();
            const image = new Image();
            image.onload = () => resolve(image.naturalWidth);
            image.onerror = () => reject(new Error('Image requests remained blocked'));
            image.src = args[0];
            return promise;
          })()`,
          [`${baseUrl}/restored.png`],
          opened.tabId
        )
        expect(restored).toBe(failSecondImage ? 1 : 120)
        expect(requests.at(-1)).toMatchObject({ path: '/restored.png', destination: 'image' })
      } finally {
        server.closeAllConnections()
        const closed = Promise.withResolvers<void>()
        server.close(() => closed.resolve())
        await closed.promise
        fs.rmSync(outputDir, { recursive: true, force: true })
      }
    })
  }

  for (const failPostDownload of [false, true]) {
    test(`Patreon blocks feed previews through filtering and pagination, restoring after ${failPostDownload ? 'post failure' : 'completion'}`, async () => {
      if (!runtime || !mockServer) throw new Error('Runtime fixtures not initialized')
      const feedHtml = fs.readFileSync('test-fixtures/patreon/feed.html')
      const postHtml = fs.readFileSync('test-fixtures/patreon/carousel.html')
      const imageBytes = fs.readFileSync(mockServer.fixtureImagePath)
      const imageRequests: string[] = []
      let nextPageRequests = 0
      const server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        if (url.pathname === '/feed-next') {
          nextPageRequests++
          setTimeout(() => res.end('next page'), 1_500)
        } else if (url.pathname === '/slide') {
          res.end('ok')
        } else if (url.pathname.endsWith('.png')) {
          imageRequests.push(url.pathname)
          if (url.pathname.startsWith('/media/')) {
            res.writeHead(404)
            res.end()
          } else {
            res.writeHead(200, { 'content-type': 'image/png' })
            res.end(imageBytes)
          }
        } else {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end(url.pathname === '/fixture/posts' ? feedHtml : postHtml)
        }
      })
      const listening = Promise.withResolvers<void>()
      server.listen(0, '127.0.0.1', listening.resolve)
      await listening.promise
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing fixture address')
      const baseUrl = `http://127.0.0.1:${address.port}`
      const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patreon-feed-'))
      const postUrls = ['/fixture/posts/seen-710001', '/fixture/posts/synthetic-gallery-700001']
      fs.writeFileSync(path.join(outputDir, 'visited.txt'), (failPostDownload ? postUrls.slice(0, 1) : postUrls).join('\n'))
      // Compiled bridge modules must load after the test broker environment is configured.
      const { Extractor } = await import(distModuleUrl('dist/extractor.js')) as typeof ExtractorModule
      const { BridgeContextShim } = await import(distModuleUrl('dist/bridgePageShim.js')) as typeof BridgePageModule
      const scraperContext = new BridgeContextShim(runtime as never)
      const feedPage = await scraperContext.newPage()
      const extractor = new Extractor(feedPage, scraperContext, { outDir: outputDir, updateMode: false })
      try {
        const extraction = extractor.extract(`${baseUrl}/fixture/posts`, '2025')
        if (failPostDownload) {
          await expect(extraction).rejects.toMatchObject({ action: 'fetchBinary', code: 'HTTP_ERROR' })
          expect(imageRequests).toEqual(['/media/p/post/700001/image-one/eyJxIjoxMDAsIndlYnAiOjB9/1.png'])
        } else {
          expect(await extraction).toBe(path.join(outputDir, '2025'))
          expect(imageRequests).toEqual([])
        }
        expect(nextPageRequests).toBe(1)
        expect(await extractor.getPostUrls()).toEqual(postUrls)
        expect(await feedPage.evaluate(`({
          year: document.body.dataset.year,
          type: document.body.dataset.mediaType,
          accessible: document.querySelector('[role="switch"]').getAttribute('aria-checked')
        })`)).toEqual({ year: '2025', type: 'image', accessible: 'true' })
        expect(await feedPage.evaluate(`(() => {
          const { promise, resolve, reject } = Promise.withResolvers();
          const image = new Image();
          image.onload = () => resolve(image.naturalWidth);
          image.onerror = () => reject(new Error('Feed images remained blocked'));
          image.src = args[0];
          return promise;
        })()`, `${baseUrl}/restored-feed.png`)).toBe(1)
        expect(imageRequests.at(-1)).toBe('/restored-feed.png')
      } finally {
        extractor.closeStream()
        await scraperContext.close()
        server.closeAllConnections()
        const closed = Promise.withResolvers<void>()
        server.close(() => closed.resolve())
        await closed.promise
        fs.rmSync(outputDir, { recursive: true, force: true })
      }
    })
  }
})
