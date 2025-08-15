import { chromium } from 'rebrowser-playwright'
import { Cookie } from 'rebrowser-playwright'
import * as fs from 'fs'
import minimist from 'minimist'
import type { ParsedArgs } from 'minimist'
import { waitForDelay, waitForEnter } from './utils.js'
import { Extractor } from './extractor.js'
import path from 'path'
import { runCache } from './cache.js'
import { FanboxExtractor } from './extractor/fanbox.js'
import { fileName, saveCookies } from './saveCookies.js'
import { oraPromise } from 'ora'
const cacheDir = path.resolve('./playwright-cache')

import { exec } from 'child_process'
import { clearInterval } from 'node:timers'
import { SubstackExtractor } from './extractor/substack.js'
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

async function runTocHtml(dirPath: string) {
  const command = `yarn run toc:html --dir "${dirPath}"`

  // Wrap exec in a Promise so we can await it:
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(error) // Reject on error
        return
      }
      // Otherwise resolve with stdout & stderr if needed
      resolve({ stdout, stderr })
    })
  })
}

function prepareDir(dirName: string) {
  const { update } = minimist(process.argv.slice(2))
  if (!fs.existsSync(dirName)) {
    if (update) {
      const e = Error('Update should be running only with existing dir')
      // @ts-ignore nonrecovery errors
      e.recoverable = false
      throw e
    }
    fs.mkdirSync(dirName)
    console.log(`Created output directory ${dirName}`)
  } else {
    console.log(`Directory ${dirName} already exists`)
  }
}

let isFinished = false
let cacheId: NodeJS.Timeout | null = null
let pageUrl: string = ''

function resolveSite(url: string): 'patreon' | 'pixivFanbox' | 'substack' {
  if (url.includes('patreon')) {
    return 'patreon'
  }
  if (url.includes('fanbox')) {
    return 'pixivFanbox'
  }
  if (url.includes('substack')) {
    return 'substack'
  }
  throw Error('Unsupported url')
}

function createExtractor(
  site: 'patreon' | 'pixivFanbox' | 'substack',
  page: ScraperPage,
  context: ScraperContext
) {
  if (site === 'patreon') {
    return new Extractor(page, context)
  }
  if (site === 'pixivFanbox') {
    return new FanboxExtractor(page, context)
  }
  if (site === 'substack') {
    return new SubstackExtractor(page, context)
  }
  throw Error('Unsupported url')
}

async function runV2(args: ParsedArgs): Promise<void> {
  const { url, year } = args
  const site = resolveSite(String(url))
  const bridgeV2 = new BridgeV2Runtime()
  let extractor: Extractor | FanboxExtractor | SubstackExtractor | null = null
  try {
    await oraPromise(startLocalBridgeServer(), 'Starting in-process v2 bridge')
    await oraPromise(bridgeV2.ensureReady(), 'Connecting to in-process v2 bridge')
    await oraPromise(bridgeV2.ping(), 'Pinging v2 local bridge')
    const context = new BridgeContextShim(bridgeV2)
    context.setDefaultTimeout(50_000)
    const page = await context.newPage()
    extractor = createExtractor(site, page, context)
    await oraPromise(
      extractor.doLogin([], { skipCookies: true }),
      'Waiting for login'
    )
    if (pageUrl) {
      console.log(`⏯  Continuing from ${pageUrl}`)
    }
    const finalDir = await extractor.extract(pageUrl || String(url), String(year))
    await oraPromise(runTocHtml(finalDir), 'Generating html gallery...')
    if (extractor.lockedCount) {
      console.log(`${extractor.lockedCount} locked posts were not downloaded`)
    }
    console.log('💯 Extractor finished.')
    await context.close()
  } catch (e) {
    if (e instanceof BridgeActionError) {
      console.error('V2 bridge action failed:', e.message)
    }
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

export async function main() {
  const args = minimist(process.argv.slice(2))
  const { server, username, password, dir, url, year, v2 } = args
  const useV2 = Boolean(v2)
  if (useV2) {
    if (!url) {
      console.error('No url provided')
      return
    }
    prepareDir(dir)
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
  prepareDir(dir)
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
  cacheId = await runCache(context, site)
  context.setDefaultTimeout(50_000)

  const page = await context.newPage()
  const extractor = createExtractor(
    site,
    page as unknown as ScraperPage,
    context as unknown as ScraperContext
  )
  await oraPromise(extractor.doLogin(preparedCookies), 'Loading cookies')

  await saveCookies(context as unknown as ScraperContext)

  try {
    if (pageUrl) {
      console.log(`⏯  Continuing from ${pageUrl}`)
    }
    const finalDir = await extractor.extract(pageUrl || url, String(year))
    await oraPromise(runTocHtml(finalDir), 'Generating html gallery...')
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
const args = minimist(process.argv.slice(2))
if (args.recover) {
  console.log('Running in auto-recover mode. Press Ctrl+C at any time to close')
  while (repeats > 0) {
    try {
      await main()
      break
    } catch (e) {
      if (cacheId) {
        clearInterval(cacheId)
      }
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
} else {
  main()
}
