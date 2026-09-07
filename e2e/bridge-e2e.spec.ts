import { test, expect, chromium, type BrowserContext } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

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
  navigate: (url: string, tabId?: number) => Promise<void>
  waitForSelector: (
    selector: string,
    state?: 'attached' | 'detached' | 'visible' | 'hidden',
    timeoutMs?: number,
    tabId?: number
  ) => Promise<void>
  evaluate: <T = unknown>(expression: string, args?: unknown[], tabId?: number) => Promise<T>
  fetchAsBase64: (
    url: string,
    tabId?: number,
    onProgress?: (progress: { downloadedBytes: number; totalBytes?: number }) => void
  ) => Promise<string>
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

  test('image acquisition: download and base64 fetch match fixture', async () => {
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
      await test.step('Act: page-context fetch fails but bridge fetchAsBase64 succeeds', async () => {
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
        const base64 = await runtime!.fetchAsBase64(
          `${imageUrl}?progress=1`,
          tabId as number,
          (progress) => progressUpdates.push(progress)
        )
        const decoded = Buffer.from(base64, 'base64')
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
})
