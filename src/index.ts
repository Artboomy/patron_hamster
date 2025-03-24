import { chromium } from 'rebrowser-playwright'
import { Cookie } from 'rebrowser-playwright'
import * as fs from 'fs'
import minimist from 'minimist'
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
  if (!fs.existsSync(dirName)) {
    fs.mkdirSync(dirName)
    console.log(`Created output directory ${dirName}`)
  } else {
    console.log(`Directory ${dirName} already exists`)
  }
}

let isFinished = false
let cacheId: NodeJS.Timeout | null = null
let pageUrl: string = ''
export async function main() {
  const args = minimist(process.argv.slice(2))
  const { server, username, password, dir, url, year } = args
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
  const extensionPath = path.resolve('./extensions/adblock')
  const existsAndNotEmpty =
    fs.existsSync(extensionPath) && fs.readdirSync(extensionPath).length > 0
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
  if (existsAndNotEmpty) {
    cfg.args = [
      ...(cfg.args || []),
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
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
  let site: 'patreon' | 'pixivFanbox'
  if (url.includes('patreon')) {
    site = 'patreon'
  } else if (url.includes('fanbox')) {
    site = 'pixivFanbox'
  } else {
    console.warn('Unrecognized site')
    process.exit(0)
  }
  cacheId = await runCache(context, site)
  context.setDefaultTimeout(50_000)

  const page = await context.newPage()

  let extractor
  if (site === 'patreon') {
    extractor = new Extractor(page, context)
  } else if (site === 'pixivFanbox') {
    extractor = new FanboxExtractor(page, context)
  } else {
    throw Error('Unsupported url')
  }
  await oraPromise(extractor.doLogin(preparedCookies), 'Loading cookies')

  await saveCookies(context)

  try {
    if (pageUrl) {
      console.log(`⏯  Continuing from ${pageUrl}`)
    }
    const finalDir = await extractor.extract(pageUrl || url, String(year))
    await oraPromise(runTocHtml(finalDir), 'Generating html gallery...')
  } catch (e) {
    pageUrl = extractor.pageUrl
    await context.close()
    throw e
  }
  console.log('💯 Extractor finished. Press Enter to close the browser.')
  await saveCookies(context)
  isFinished = true
  waitForEnter().then(() => {
    context.close()
    process.exit()
  })
}
let repeats = 50
const args = minimist(process.argv.slice(2))
if (args.recover) {
  console.log('Running in auto-recover mode. Press Ctrl+C at any time to close')
  while (repeats > 0) {
    try {
      await main()
    } catch (e) {
      if (cacheId) {
        clearInterval(cacheId)
      }
      if (isFinished) {
        process.exit()
      }
      console.log('🔃  Failure, restarting', e)
      repeats -= 1
      await waitForDelay(1000)
    }
  }
} else {
  main()
}
