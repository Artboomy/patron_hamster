import * as fs from 'fs'
import checkbox from '@inquirer/checkbox'
import minimist from 'minimist'
import type { ParsedArgs } from 'minimist'
import { waitForDelay } from './utils.js'
import { Extractor } from './extractor.js'
import path from 'path'
import { generateGalleryHtml } from './galleryHtml.js'
import { FanboxExtractor } from './extractor/fanbox.js'
import { oraPromise } from 'ora'
import open from 'open'
import { pathToFileURL } from 'node:url'
import { SubstackExtractor } from './extractor/substack.js'
import { TwitterExtractor } from './extractor/twitter.js'
import { BridgeV2Runtime } from './bridgeV2.js'
import { BridgeContextShim } from './bridgePageShim.js'
import type { ScraperContext, ScraperPage } from './extractor/pageTypes.js'
import type { ResizeBounds } from './scripts/resizeImage.js'
import {
  startLocalBridgeServer,
  stopLocalBridgeServer
} from './local-bridge/server.js'
import { BridgeActionError } from './bridgeV2.js'
type LaunchArgs = ParsedArgs & {
  dir?: string
  patreon?: string
  twitter?: string
  recover?: boolean
  trace?: boolean
  update?: boolean
  poll?: boolean
  url?: string
  year?: string | number
  resize?: ResizeBounds
}

type UpdateSite = 'patreon' | 'pixivFanbox' | 'substack' | 'twitter'

export type UpdateTarget = {
  name: string
  outDir: string
  site: UpdateSite
  url: string
}

function updateUrlFromPostUrl(postUrl: string): {
  site: UpdateSite
  url: string
} | null {
  const parsed = new URL(postUrl)
  if (parsed.hostname === 'x.com') {
    const handle = parsed.pathname.split('/').filter(Boolean)[0]
    return handle
      ? { site: 'twitter', url: `https://x.com/${handle}/media?filter=photo` }
      : null
  }
  if (parsed.hostname.includes('patreon.com')) {
    const postsIndex = parsed.pathname.indexOf('/posts/')
    return postsIndex === -1
      ? null
      : {
          site: 'patreon',
          url: `${parsed.origin}${parsed.pathname.slice(0, postsIndex)}/posts`
        }
  }
  if (parsed.hostname.endsWith('.fanbox.cc')) {
    return { site: 'pixivFanbox', url: `${parsed.origin}/posts` }
  }
  if (parsed.hostname.endsWith('.substack.com')) {
    return { site: 'substack', url: `${parsed.origin}/archive` }
  }
  return null
}

function findFirstMarkdownFile(dirPath: string): string | null {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      const nestedFile = findFirstMarkdownFile(entryPath)
      if (nestedFile) {
        return nestedFile
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      return entryPath
    }
  }
  return null
}

export function discoverUpdateTargets(outputDir = path.resolve('output')): UpdateTarget[] {
  if (!fs.existsSync(outputDir)) {
    return []
  }
  return fs
    .readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry): UpdateTarget[] => {
      const outDir = path.join(outputDir, entry.name)
      const visitedPath = path.join(outDir, 'visited.txt')
      const postUrl = fs.existsSync(visitedPath)
        ? fs
            .readFileSync(visitedPath, 'utf8')
            .split('\n')
            .find(Boolean)
        : (() => {
            const markdownPath = findFirstMarkdownFile(outDir)
            return markdownPath
              ? fs
                  .readFileSync(markdownPath, 'utf8')
                  .match(/\]\((https?:\/\/[^)\s]+)\)/)?.[1]
              : undefined
          })()
      if (!postUrl) {
        return []
      }
      try {
        const target = updateUrlFromPostUrl(postUrl)
        return target
          ? [{ name: entry.name, outDir, site: target.site, url: target.url }]
          : []
      } catch {
        return []
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

export function resolveUpdateTargetChoices(
  choices: readonly (UpdateTarget | 'all' | 'exit')[],
  targets: readonly UpdateTarget[]
): UpdateTarget[] {
  if (choices.includes('exit')) {
    return []
  }
  return choices.includes('all')
    ? [...targets]
    : choices.filter(
        (choice): choice is UpdateTarget =>
          choice !== 'all' && choice !== 'exit'
      )
}

async function selectUpdateTargets(
  targets: UpdateTarget[]
): Promise<UpdateTarget[]> {
  if (targets.length === 0) {
    console.log('No downloaded creators found in output.')
    return []
  }
  const choices = await checkbox<UpdateTarget | 'all' | 'exit'>({
    message: 'Select creators to update (Space toggles, Enter confirms)',
    choices: [
      { name: 'Exit without updating', value: 'exit' as const },
      { name: 'Update all creators', value: 'all' as const },
      ...targets.map((target) => ({
        name: `${target.name} (${target.site})`,
        value: target
      }))
    ],
    shortcuts: { all: null, invert: null }
  })
  return resolveUpdateTargetChoices(choices, targets)
}

function assertPollSupported(args: Pick<LaunchArgs, 'poll' | 'url'>): void {
  if (
    args.poll &&
    args.url &&
    resolveSite(String(args.url)) !== 'patreon'
  ) {
    throw new Error('The --poll option is only supported for Patreon')
  }
}

export function resolveLaunchArgs(rawArgs: ParsedArgs): LaunchArgs {
  const args: LaunchArgs = { ...rawArgs }
  if (rawArgs.resize === undefined || rawArgs.resize === false) {
    delete args.resize
  } else if (rawArgs.resize === true) {
    args.resize = { width: 4000, height: 4000 }
  } else {
    if (typeof rawArgs.resize !== 'string' || !/^\d+:\d+$/.test(rawArgs.resize)) {
      throw new Error('--resize requires positive integer dimensions w:h, or no value for 4000:4000')
    }
    const [width, height] = rawArgs.resize.split(':').map(Number)
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
      throw new Error('--resize requires positive safe integer dimensions w:h')
    }
    args.resize = { width, height }
  }
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
  if (args.update && args.year === undefined) {
    args.year = new Date().getFullYear()
  }
  assertPollSupported(args)
  if (!args.url && !args.update) {
    throw new Error('No url provided')
  }
  if (!args.dir && !args.update) {
    throw new Error('No dir provided')
  }
  return args
}

export type ExtractorCliOptions = {
  outDir: string
  updateMode: boolean
  pollMode?: boolean
  resize?: ResizeBounds
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
  const context = new BridgeContextShim(bridgeV2)
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
    const page = await context.newPage()
    extractor = createExtractor(site, page, context, {
      outDir: String(args.dir),
      updateMode: Boolean(args.update),
      pollMode: Boolean(args.poll),
      resize: args.resize
    })
    await oraPromise(
      extractor.doLogin({ targetUrl: String(url) }),
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
    try {
      try {
        await context.close()
      } finally {
        await bridgeV2.dispose()
      }
    } finally {
      await stopLocalBridgeServer()
    }
  }
}

async function updateDownloadedCreators(args: LaunchArgs): Promise<void> {
  const targets = await selectUpdateTargets(discoverUpdateTargets())
  for (const target of targets) {
    console.log(`Updating ${target.name} (${target.site})`)
    pageUrl = ''
    await main({
      ...args,
      dir: target.outDir,
      url: target.url,
      update: true
    })
  }
}

export async function main(args: LaunchArgs) {
  if (args.update && !args.url) {
    return updateDownloadedCreators(args)
  }
  assertPollSupported(args)
  prepareDir(String(args.dir), Boolean(args.update))
  return runV2(args)
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
