import { chromium } from 'rebrowser-playwright'
import { Cookie } from 'rebrowser-playwright'
import * as fs from 'fs'
import minimist from 'minimist'
import type { ParsedArgs } from 'minimist'
import { waitForDelay, waitForEnter } from './utils.js'
import { Extractor } from './extractor.js'
import path from 'path'
import { generateGalleryHtml } from './galleryHtml.js'
import { runCache } from './cache.js'
import { FanboxExtractor } from './extractor/fanbox.js'
import { fileName, saveCookies } from './saveCookies.js'
import { oraPromise } from 'ora'
import open from 'open'
const cacheDir = path.resolve('./playwright-cache')

import { clearInterval } from 'node:timers'
import { pathToFileURL } from 'node:url'
import { SubstackExtractor } from './extractor/substack.js'
import { TwitterExtractor } from './extractor/twitter.js'
import { BridgeV2Runtime } from './bridgeV2.js'
import { BridgeContextShim } from './bridgePageShim.js'
import type { ScraperContext, ScraperPage } from './extractor/pageTypes.js'
import {
  startLocalBridgeServer,
  stopLocalBridgeServer
} from './local-bridge/server.js'
import { BridgeActionError } from './bridgeV2.js'
function readCookies(): Cookie[] {
  try {
    return JSON.parse(fs.readFileSync(fileName, 'utf8'))
  } catch (_e) {
    return []
  }
}
type LaunchArgs = ParsedArgs & {
  dir?: string
  patreon?: string
  twitter?: string
  recover?: boolean
  trace?: boolean
  update?: boolean
  url?: string
  v1?: boolean
  year?: string | number
}

export function resolveLaunchArgs(rawArgs: ParsedArgs): LaunchArgs {
  const args: LaunchArgs = { ...rawArgs }
  if (args.patreon !== undefined) {
    if (args.url) {
      throw new Error('Use either --url or --patreon, not both')
    }
    if (typeof args.patreon !== 'string') {
      throw new Error('No Patreon creator provided')
    }
    const creator = args.patreon.trim().replace(/^\/+|\/+$/g, '')
    if (!creator) {
      throw new Error('No Patreon creator provided')
    }
    if (creator.includes('/') || creator.includes('\\')) {
      throw new Error('Patreon creator must be a creator name, not a path or URL')
    }
    args.url = `https://www.patreon.com/c/${encodeURIComponent(creator)}/posts`
    args.dir ??= path.join('output', creator)
  }
  if (args.twitter !== undefined) {
    if (args.url) {
      throw new Error('Use either --url or --twitter, not both')
    }
    if (typeof args.twitter !== 'string') {
      throw new Error('No Twitter handle provided')
    }
    const handle = args.twitter.trim().replace(/^@/, '')
    if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
      throw new Error('Twitter handle must contain 1–15 letters, numbers, or underscores')
    }
    args.url = `https://x.com/${handle}/media?filter=photo`
    args.dir ??= path.join('output', handle)
  }
  if (!args.url) {
    throw new Error('No url provided')
  }
  if (!args.dir) {
    throw new Error('No dir provided')
  }
  return args
}

export type ExtractorCliOptions = {
  outDir: string
  updateMode: boolean
}

async function generateDefaultGallery(dirPath: string): Promise<string> {
  const outputHtmlFile = generateGalleryHtml(dirPath)
  console.log(`Gallery generated: ${outputHtmlFile}`)
  try {
    await open(outputHtmlFile)
  } catch (error) {
    console.error('Failed to open gallery using the default app:', error)
  }
  return outputHtmlFile
}

function prepareDir(dirName: string, updateMode: boolean) {
  if (!fs.existsSync(dirName)) {
    if (updateMode) {
      const e = Error('Update should be running only with existing dir')
      // @ts-ignore nonrecovery errors
      e.recoverable = false
      throw e
    }
    fs.mkdirSync(dirName, { recursive: true })
    console.log(`Created output directory ${dirName}`)
    return
  }
  console.log(`Directory ${dirName} already exists`)
}

let isFinished = false
let cacheId: NodeJS.Timeout | null = null
let pageUrl: string = ''

function resolveSite(
  url: string
): 'patreon' | 'pixivFanbox' | 'substack' | 'twitter' {
  if (url.includes('patreon')) {
    return 'patreon'
  }
  if (url.includes('fanbox')) {
    return 'pixivFanbox'
  }
  if (url.includes('substack')) {
    return 'substack'
  }
  if (new URL(url).hostname === 'x.com') {
    return 'twitter'
  }
  throw Error('Unsupported url')
}

function createExtractor(
  site: 'patreon' | 'pixivFanbox' | 'substack' | 'twitter',
  page: ScraperPage,
  context: ScraperContext,
  options: ExtractorCliOptions
) {
  if (site === 'patreon') {
    return new Extractor(page, context, options)
  }
  if (site === 'pixivFanbox') {
    return new FanboxExtractor(page, context, options)
  }
  if (site === 'substack') {
    return new SubstackExtractor(page, context, options)
  }
  if (site === 'twitter') {
    return new TwitterExtractor(page, context, options)
  }
  throw Error('Unsupported url')
}

async function runV2(args: LaunchArgs): Promise<void> {
  const { url, year, trace } = args
  const site = resolveSite(String(url))
  const traceFilePath = trace ? path.resolve(String(args.dir), 'bridge.trace') : ''
  const bridgeV2 = new BridgeV2Runtime({ traceFilePath })
  let extractor:
    | Extractor
    | FanboxExtractor
    | SubstackExtractor
    | TwitterExtractor
    | null = null
  if (traceFilePath) {
    fs.writeFileSync(traceFilePath, '', 'utf8')
    console.log(`Writing bridge trace to ${traceFilePath}`)
  }
  try {
    console.log(`| V2 bridge base URL: ${process.env.BRIDGE_BASE_URL || 'http://127.0.0.1:17353'}`)
    await oraPromise(startLocalBridgeServer(), 'Starting in-process v2 bridge')
    await oraPromise(bridgeV2.ensureReady(), 'Connecting to in-process v2 bridge')
    const bridgeHealth = await bridgeV2.inspectHealth()
    console.log(
      `| V2 bridge health after connect: ${JSON.stringify({
        status: bridgeHealth.status,
        diagnostics: bridgeHealth.diagnostics,
        error: bridgeHealth.error
      })}`
    )
    await oraPromise(bridgeV2.ping(), 'Pinging v2 local bridge')
    console.log('| V2 bridge ping succeeded')
    const context = new BridgeContextShim(bridgeV2)
    context.setDefaultTimeout(50_000)
    const page = await context.newPage()
    extractor = createExtractor(site, page, context, {
      outDir: String(args.dir),
      updateMode: Boolean(args.update)
    })
    await oraPromise(
      extractor.doLogin([], { skipCookies: true, targetUrl: String(url) }),
      'Waiting for login'
    )
    if (pageUrl) {
      console.log(`⏯  Continuing from ${pageUrl}`)
    }
    const finalDir = await extractor.extract(pageUrl || String(url), String(year))
    await oraPromise(generateDefaultGallery(finalDir), 'Generating Twitter-style gallery...')
    if (extractor.lockedCount) {
      console.log(`${extractor.lockedCount} locked posts were not downloaded`)
    }
    console.log('💯 Extractor finished.')
    await context.close()
  } catch (e) {
    const bridgeHealth = await bridgeV2.inspectHealth().catch((healthError) => ({
      baseUrl: process.env.BRIDGE_BASE_URL || 'http://127.0.0.1:17353',
      ok: false,
      status: null,
      body: null,
      diagnostics: null,
      error: healthError instanceof Error ? healthError.message : String(healthError)
    }))
    if (e instanceof BridgeActionError) {
      console.error('V2 bridge action failed:', e.message)
      console.error(
        'V2 bridge action details:',
        JSON.stringify({
          action: e.action,
          requestId: e.requestId,
          code: e.code,
          details: e.details
        })
      )
    }
    console.error(
      'V2 bridge health snapshot:',
      JSON.stringify({
        baseUrl: bridgeHealth.baseUrl,
        ok: bridgeHealth.ok,
        status: bridgeHealth.status,
        diagnostics: bridgeHealth.diagnostics,
        error: bridgeHealth.error,
        body: bridgeHealth.body
      })
    )
    if (extractor) {
      pageUrl = extractor.pageUrl
      if (extractor.lockedCount) {
        console.log(`There were ${extractor.lockedCount} locked posts up to now`)
      }
    }
    throw e
  } finally {
    await bridgeV2.dispose()
    await stopLocalBridgeServer()
  }
}

export async function main(args: LaunchArgs) {
  const { server, username, password, dir, url, year, v1, update } = args
  if (!v1) {
    prepareDir(String(dir), Boolean(update))
    return runV2(args)
  }
  if (!url) {
    console.error('No url provided')
    return
  }
  if (server && username && password) {
    console.log(
      `Provided proxy config: ${server}, user=${username}, password=<MASKED>`
    )
  }
  prepareDir(String(dir), Boolean(update))
  console.log('Launching Chrome browser')
  const preparedCookies = readCookies()
  const extensionPaths: string[] = []
  const adblockExtensionPath = path.resolve('./extensions/adblock')
  const hasAdblockExtension =
    fs.existsSync(adblockExtensionPath) &&
    fs.readdirSync(adblockExtensionPath).length > 0
  if (hasAdblockExtension) {
    extensionPaths.push(adblockExtensionPath)
  }
  const cfg: Parameters<(typeof chromium)['launchPersistentContext']>[1] = {
    headless: false,
    // @see https://github.com/ultrafunkamsterdam/undetected-chromedriver/issues/1388#issuecomment-1631477896
    // required to pass cloudflare checks for some reason
    args: [
      '--auto-open-devtools-for-tabs',
      '--disable-features=ServiceWorker',
      '--enable-features=WebRTC-H264WithOpenH264FFmpeg',
      '--disable-blink-features=AutomationControlled'
    ],
    serviceWorkers: 'block',
    viewport: null,
    channel: 'chrome'
  }
  if (extensionPaths.length > 0) {
    const csv = extensionPaths.join(',')
    cfg.args = [
      ...(cfg.args || []),
      `--disable-extensions-except=${csv}`,
      `--load-extension=${csv}`
    ]
  }
  if (server && username) {
    cfg.proxy = {
      server,
      username,
      password
    }
  }
  const context = await chromium.launchPersistentContext(cacheDir, cfg)
  const site = resolveSite(String(url))
  if (site === 'twitter') {
    throw new Error('Twitter extraction requires the v2 bridge; omit --v1')
  }
  cacheId = await runCache(context, site)
  context.setDefaultTimeout(50_000)

  const page = await context.newPage()
  const extractor = createExtractor(
    site,
    page as unknown as ScraperPage,
    context as unknown as ScraperContext,
    {
      outDir: String(dir),
      updateMode: Boolean(update)
    }
  )
  await oraPromise(extractor.doLogin(preparedCookies), 'Loading cookies')

  await saveCookies(context as unknown as ScraperContext)

  try {
    if (pageUrl) {
      console.log(`⏯  Continuing from ${pageUrl}`)
    }
    const finalDir = await extractor.extract(pageUrl || url, String(year))
    await oraPromise(generateDefaultGallery(finalDir), 'Generating Twitter-style gallery...')
  } catch (e) {
    pageUrl = extractor.pageUrl
    if (extractor.lockedCount) {
      console.log(`There were ${extractor.lockedCount} locked posts up to now`)
    }
    await context.close()
    throw e
  }
  if (extractor.lockedCount) {
    console.log(`${extractor.lockedCount} locked posts were not downloaded`)
  }
  console.log('💯 Extractor finished. Press Enter to close the browser.')
  await saveCookies(context as unknown as ScraperContext)
  isFinished = true
  waitForEnter().then(() => {
    context.close().finally(() => {
      process.exit()
    })
  })
}
let repeats = 50

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = resolveLaunchArgs(minimist(process.argv.slice(2)))
  if (args.recover === false) {
    await main(args)
  } else {
    console.log('Running in auto-recover mode. Press Ctrl+C at any time to close')
    while (repeats > 0) {
      try {
        await main(args)
        break
      } catch (e) {
        clearInterval(cacheId ?? undefined)
        if (isFinished) {
          process.exit()
        }
        // @ts-ignore nonrecovery errors
        if (e.recoverable === false) {
          console.log('Nonrecoverable error', e)
          process.exit(1)
        }
        console.log('🔃  Failure, restarting', e)
        repeats -= 1
        await waitForDelay(1000)
      }
    }
  }
}
