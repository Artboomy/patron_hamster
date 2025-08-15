import { chromium, type BrowserContext } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startLocalBridgeServer, stopLocalBridgeServer } from './server.js'
import { startMockSiteServer, type MockSiteServer } from './mock-site-server.js'
import { BridgeActionError, BridgeV2Runtime } from '../bridgeV2.js'
import { BridgePageShim } from '../bridgePageShim.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

function logSuite(message: string): void {
  console.log(`[bridge-e2e] ${message}`)
}

function logCaseStart(index: number, total: number, name: string): void {
  console.log(`\n[bridge-e2e] [${index}/${total}] ${name}`)
}

function logStep(phase: 'Arrange' | 'Act' | 'Assert', message: string): void {
  console.log(`[bridge-e2e]   ${phase}: ${message}`)
}

async function waitForPing(runtime: BridgeV2Runtime, timeoutMs = 30_000): Promise<void> {
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

async function launchExtensionContext(pathToExtension: string): Promise<{
  context: BrowserContext
  userDataDir: string
}> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-e2e-'))
  const headed =
    process.argv.includes('--headed') || process.env.BRIDGE_E2E_HEADED === '1'
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !headed,
    viewport: { width: 1366, height: 900 },
    args: [
      `--disable-extensions-except=${pathToExtension}`,
      `--load-extension=${pathToExtension}`
    ]
  })

  let serviceWorker = context.serviceWorkers()[0]
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent('serviceworker', {
      timeout: 15_000
    })
  }
  assert(Boolean(serviceWorker), 'Extension service worker did not start')

  return { context, userDataDir }
}

async function waitForResponseBodies(bodies: Buffer[], timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (bodies.length > 0) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for shim response listener body data')
}

type TestContext = {
  runtime: BridgeV2Runtime
  mockServer: MockSiteServer
  page: BridgePageShim | null
  tabId: number | null
}

type TestCase = {
  name: string
  run: (ctx: TestContext) => Promise<void>
}

const testCases: TestCase[] = [
  {
    name: 'about:blank race protection keeps evaluate/wait usable',
    run: async (ctx) => {
      // Arrange
      logStep('Arrange', 'open about:blank tab and prepare delayed route')
      const raceUrl = `${ctx.mockServer.baseUrl}/slow?ms=700`
      const raceTab = await ctx.runtime.openTab('about:blank', true)

      // Act
      logStep('Act', 'navigate and immediately run selector wait against delayed page')
      const navigatePromise = ctx.runtime.navigate(raceUrl, raceTab.tabId)
      await ctx.runtime.waitForSelector('#title', 'attached', 10_000, raceTab.tabId)
      await navigatePromise

      // Assert
      logStep('Assert', 'tab can execute evaluate after the race window')
      const title = await ctx.runtime.evaluate<string>('document.title', [], raceTab.tabId)
      assert(title === 'Bridge Mock Page', `Expected race page title, got ${String(title)}`)

      ctx.tabId = raceTab.tabId
      ctx.page = new BridgePageShim(ctx.runtime, raceTab.tabId, raceUrl)
    }
  },
  {
    name: 'shim DOM operations work with clear selector assertions',
    run: async (ctx) => {
      assert(ctx.page && ctx.tabId !== null, 'Expected initialized page from previous test')

      // Arrange
      logStep('Arrange', 'navigate shim page to mock root and wait for stable marker')
      await ctx.page.goto(ctx.mockServer.baseUrl)
      await ctx.page.waitForSelector('#next-link', { state: 'visible', timeout: 10_000 })

      // Act
      logStep('Act', 'run evaluate, count, text extraction and click')
      const pageTitle = await ctx.page.evaluate<string>('document.title')
      const itemCount = await ctx.page.locator('.item').count()
      const secondItemText = await ctx.page.locator('.item').nth(1).innerText()
      await ctx.page.locator('#action-button').click()
      const clicked = await ctx.page.evaluate<string>('document.body.getAttribute("data-clicked") || ""')

      // Assert
      logStep('Assert', 'all values match expected DOM behavior')
      assert(pageTitle === 'Bridge Mock Page', `Expected page title to be Bridge Mock Page, got ${String(pageTitle)}`)
      assert(itemCount === 2, `Expected 2 items, got ${itemCount}`)
      assert(secondItemText.trim() === 'Item 2', `Expected second item text to be Item 2, got ${secondItemText}`)
      assert(clicked === '1', `Expected click marker to be 1, got ${clicked}`)
    }
  },
  {
    name: 'image download path and response body acquisition are correct',
    run: async (ctx) => {
      assert(ctx.page, 'Expected initialized page from previous test')

      // Arrange
      logStep('Arrange', 'attach response listener and prepare temp output directory')
      const responseBodies: Buffer[] = []
      const expected = fs.readFileSync(ctx.mockServer.fixtureImagePath)
      ctx.page.on('response', (response) => {
        void response
          .body()
          .then((body) => {
            responseBodies.push(body)
          })
          .catch(() => {
            return
          })
      })
      const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-download-'))

      try {
        // Act
        logStep('Act', 'click download link and save emitted download')
        const downloadPromise = ctx.page.waitForEvent('download')
        await ctx.page.locator('#download-link').click()
        const resolvedDownload = await downloadPromise
        const downloadedFilePath = path.join(outputDir, 'downloaded.png')
        await resolvedDownload.saveAs(downloadedFilePath)

        // Assert
        logStep('Assert', 'downloaded file and streamed response body equal fixture')
        const saved = fs.readFileSync(downloadedFilePath)
        assert(saved.equals(expected), 'Downloaded image does not match fixture image')
        await waitForResponseBodies(responseBodies)
        assert(
          responseBodies.some((body) => body.equals(expected)),
          'Shim response body stream did not include fixture image payload'
        )
      } finally {
        fs.rmSync(outputDir, { recursive: true, force: true })
      }
    }
  }
]

async function runCase(index: number, total: number, testCase: TestCase, ctx: TestContext): Promise<void> {
  logCaseStart(index, total, testCase.name)
  const startedAt = Date.now()
  await testCase.run(ctx)
  console.log(`[bridge-e2e]   Result: PASS (${Date.now() - startedAt}ms)`)
}

async function run(): Promise<void> {
  const extensionPath = path.resolve(process.cwd(), 'dist/extension-bridge-v2')
  assert(
    fs.existsSync(path.join(extensionPath, 'manifest.json')),
    `Built extension not found at ${extensionPath}. Run yarn build:extension first.`
  )

  logSuite('starting local mock server and bridge broker')
  const mockServer = await startMockSiteServer()
  let browserContext: BrowserContext | null = null
  let userDataDir = ''
  const runtime = new BridgeV2Runtime()

  try {
    await startLocalBridgeServer()

    logSuite('launching chromium with extension')
    const launched = await launchExtensionContext(extensionPath)
    browserContext = launched.context
    userDataDir = launched.userDataDir

    logSuite('waiting for bridge readiness')
    await runtime.ensureReady()
    await waitForPing(runtime)

    const ctx: TestContext = {
      runtime,
      mockServer,
      page: null,
      tabId: null
    }

    let passed = 0
    for (let i = 0; i < testCases.length; i++) {
      await runCase(i + 1, testCases.length, testCases[i], ctx)
      passed += 1
    }

    logSuite(`all tests passed (${passed}/${testCases.length})`)
  } finally {
    logSuite('teardown')
    await runtime.dispose()
    if (browserContext) {
      await browserContext.close()
    }
    if (userDataDir) {
      fs.rmSync(userDataDir, { recursive: true, force: true })
    }
    await stopLocalBridgeServer()
    await mockServer.close()
  }
}

run().catch((error: unknown) => {
  if (error instanceof BridgeActionError) {
    console.error('Bridge action failed during E2E:', error.message)
  } else {
    console.error('Bridge E2E failed:', error)
  }
  process.exit(1)
})
