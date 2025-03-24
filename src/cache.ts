import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import {
  APIResponse,
  BrowserContext,
  Frame,
  Request,
  Route
} from 'rebrowser-playwright'
import { waitForDelay } from './utils.js'

// ----- 1) Define a global in-memory cache -----
interface CacheEntry {
  buffer: Buffer
  contentType: string // optional for fulfilling responses
}

const inMemoryCache = new Map<string, CacheEntry>()

// ----- 2) Utility to generate a cache key from a request URL, ignoring query params -----
function getCacheKey(url: string): string {
  // Strip query (and hash) to get just origin+pathname
  const { origin, pathname } = new URL(url)
  // Combine them
  const strippedUrl = origin + pathname
  // Hash to avoid illegal filename characters
  return crypto.createHash('sha256').update(strippedUrl).digest('hex')
}

// Optional: guess file extension from the pathname
function guessFileExtension(urlOrPath: string): string {
  const ext = path.extname(urlOrPath)
  return ext || '.bin'
}

// Optional: guess mime type from extension
function guessMimeTypeByExtension(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.jpeg':
    case '.jpg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.gif':
      return 'image/gif'
    case '.svg':
      return 'image/svg+xml'
    case '.css':
      return 'text/css'
    case '.js':
      return 'application/javascript'
    case '.html':
      return 'text/html'
    default:
      return 'application/octet-stream'
  }
}

// ----- 3) Warm up the in-memory cache from disk -----
function warmupCache(cacheDir: string) {
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true })
    return
  }
  const files = fs.readdirSync(cacheDir)
  for (const file of files) {
    // console.log(`Loading file ${i}/${files.length}`)
    const filePath = path.join(cacheDir, file)
    if (!fs.lstatSync(filePath).isFile()) continue

    // Example: assume our files are named <hash><ext>
    // So everything up to the first dot is the hash (or you can parse it differently)
    const ext = path.extname(file)
    const hash = path.basename(file, ext) // remove the extension from the filename

    const buffer = fs.readFileSync(filePath)
    const contentType = guessMimeTypeByExtension(ext)

    // Store in memory keyed by <hash>
    inMemoryCache.set(hash, { buffer, contentType })
  }
  console.log(`| Loaded ${files.length} cached files`)
}

function patreonCacheHandler(route: Route) {
  const request: Request = route.request()
  const rawUrl = request.url()

  const { origin, pathname } = new URL(rawUrl)
  // Combine them
  const url = origin + pathname
  // Find the top-most  frame (the "main" frame)
  let topFrame = request.frame()
  while (topFrame?.parentFrame()) {
    topFrame = topFrame.parentFrame() as Frame
  }

  // Get the top-level URL
  const topUrl = topFrame?.url() || ''
  const isPostsPage = topUrl.endsWith('/posts')
  const match = topUrl.match(/(\d+)$/)
  const pageId = match ? match[1] : null
  const isGif = pathname.toLowerCase().endsWith('.gif')
  if (isGif && ((pageId && !url.includes(pageId)) || isPostsPage)) {
    // console.log('! Ignoring rogue gif')
    route.fulfill({
      status: 200,
      // Indicate it's a valid GIF, but actually empty
      headers: { 'Content-Type': 'image/gif' },
      body: Buffer.from([])
    })
    return false
  }
  if (isGif) {
    route.continue()
    return false
  }
  return true
}
const regexCover = /fanbox\/public\/images\/post\/\d+\/cover/
const regexIcon = /fanbox\/public\/images\/user\/\d+\/icon/
const regexPlanCover = /fanbox\/public\/images\/plan\/\d+\/cover/
// prevent pixiv images from loading on main page
function pixivFanboxCacheHandler(route: Route) {
  const request: Request = route.request()
  let topFrame = request.frame()
  while (topFrame?.parentFrame()) {
    topFrame = topFrame.parentFrame() as Frame
  }

  // Get the top-level URL
  const topUrl = topFrame?.url() || ''
  const isPostsPage = topUrl.endsWith('/posts')
  const rawUrl = request.url()
  const urlObject = new URL(rawUrl)
  urlObject.search = '' // Removes all query string parameters

  const urlWithoutSearchParams = urlObject.toString()
  // avoid loading images on a table of contents page
  if (
    ['fanbox.cc/images/', 'pximg.net'].some((i) =>
      urlWithoutSearchParams.includes(i)
    ) &&
    ['svg', 'png', 'jpg', 'jpeg', 'gif'].some((i) =>
      urlWithoutSearchParams.endsWith(i)
    ) &&
    isPostsPage
  ) {
    route.fulfill({
      status: 200,
      // Indicate it's a valid GIF, but actually empty
      headers: { 'Content-Type': 'image/gif' },
      body: Buffer.from([])
    })
    return false
  }
  // avoid fetching extra images
  if (
    rawUrl.match(regexCover) ||
    rawUrl.match(regexIcon) ||
    rawUrl.match(regexPlanCover)
  ) {
    route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'image/jpg' },
      body: Buffer.from([])
    })
    return false
  }
  return true
}

// ads blocking
async function trackingHandler(context: BrowserContext) {
  await context.route('**://*doubleclick.net/**', (route) => {
    // console.log(`Blocking: ${route.request().url()}`)
    route.abort()
  })
  await context.route('**://analytics.google.com/**', (route) => {
    // console.log(`Blocking: ${route.request().url()}`)
    route.abort()
  })
  await context.route('**://*googletagmanager.com/**', (route) => {
    route.abort()
  })
  await context.route('**://*googleoptimize.com/**', (route) => {
    route.abort()
  })

  await context.route('**://*twitter.com/**', (route) => {
    // console.log(`Blocking: ${route.request().url()}`)
    route.abort()
  })
  await context.route('**://*vimeo.com/**', (route) => {
    // console.log(`Blocking: ${route.request().url()}`)
    route.abort()
  })
  await context.route('https://static.ads-twitter.com/uwt.js', (route) => {
    // console.log(`Blocking: ${route.request().url()}`)
    route.abort()
  })
}
function ensureCacheDir(site: string) {
  const dir = path.resolve(`./custom-cache/${site}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ----- 4) The main function with Playwright logic -----
export async function runCache(
  context: BrowserContext,
  site: 'patreon' | 'pixivFanbox'
) {
  const cacheDir = ensureCacheDir(site)

  // Warm up the in-memory cache before launching
  warmupCache(cacheDir)
  await trackingHandler(context)
  const count = {
    total: 0,
    hit: 0
  }
  const reporter = setInterval(() => {
    console.log(
      `\nCache hit rate ${count.hit}/${count.total}, ${((count.hit * 100) / count.total).toFixed(2)}%`
    )
  }, 60_000)
  // ----- 5) Route all requests -----
  await context.route(
    '**/*.{js,css,jpg,jpeg,png,gif,svg}*',
    async (route: Route) => {
      const request: Request = route.request()
      const rawUrl = request.url()
      // console.log('route', rawUrl)
      if (rawUrl.includes('twitter')) {
        return route.abort()
      }
      if (
        !['fanbox', 'patreon', 'pximg', 'pixiv'].some((s) => rawUrl.includes(s))
      ) {
        // console.log('Uncachable url', rawUrl)
        return route.continue()
      }
      try {
        if (site === 'pixivFanbox' && !pixivFanboxCacheHandler(route)) {
          return
        }
      } catch (_e) {
        // pass
      }
      let topFrame
      // Find the top-most  frame (the "main" frame)
      try {
        topFrame = request.frame()
        while (topFrame?.parentFrame()) {
          topFrame = topFrame.parentFrame() as Frame
        }
      } catch (_) {
        // pass
      }

      // Get the top-level URL
      const topUrl = topFrame?.url() || ''

      const { origin, pathname } = new URL(rawUrl)
      // Combine them
      const url = origin + pathname
      if (rawUrl.includes('cloudflare') || rawUrl.includes('challenge')) {
        // console.log('No caching for cloudflare')
        return route.continue()
      }
      if (url.includes('json')) {
        // console.log('No json caching')
        return route.continue()
      }
      if (topUrl.includes('login')) {
        // console.log('No login caching')
        return route.continue()
      }
      count.total += 1
      const key = getCacheKey(url) // e.g. hashed origin+pathname
      const ext = guessFileExtension(url) // e.g. .jpeg
      const cacheFileName = key + ext
      const cacheFilePath = path.resolve(cacheDir, cacheFileName)

      // 1) Check in-memory cache
      const inMemEntry = inMemoryCache.get(key)
      if (inMemEntry) {
        count.hit += 1
        // console.log('Served from memory', url)
        // Fulfill from memory
        await waitForDelay(Math.random() * 50)
        return route.fulfill({
          status: 200,
          headers: { 'Content-Type': inMemEntry.contentType },
          body: inMemEntry.buffer
        })
      }

      // 2) Check disk cache if not in memory
      if (fs.existsSync(cacheFilePath)) {
        count.hit += 1
        // console.log('Served from disk', rawUrl)
        const diskBuffer = fs.readFileSync(cacheFilePath)
        const diskContentType = guessMimeTypeByExtension(ext)

        // Put it into in-memory cache
        inMemoryCache.set(key, {
          buffer: diskBuffer,
          contentType: diskContentType
        })

        return route.fulfill({
          status: 200,
          headers: { 'Content-Type': diskContentType },
          body: diskBuffer
        })
      }

      if (site === 'patreon' && !patreonCacheHandler(route)) {
        // console.log('no caching for', rawUrl)
        return
      }

      // 3) Not in memory or on disk => fetch from network
      try {
        const response: APIResponse = await route.fetch()
        const contentLength = parseInt(
          response.headers()['content-length'] || '0',
          10
        )
        // Decide on a limit – say 10 MB
        const TEN_MB = 10 * 1024 * 1024
        if (contentLength > TEN_MB) {
          // console.log('! Not caching huge request', url)
          // Just fulfill directly without caching
          return route.fulfill({
            status: response.status(),
            headers: response.headers(),
            body: await response.body()
          })
        }
        const buffer: Buffer = await response.body()
        const fetchedContentType =
          response.headers()['content-type'] || guessMimeTypeByExtension(ext)

        // console.log('write to file', rawUrl)
        // Write to disk
        fs.writeFile(cacheFilePath, buffer, (e) => {
          if (e) {
            console.log('Failed to write', cacheFilePath, e)
          }
        })

        // Add to in-memory cache
        inMemoryCache.set(key, { buffer, contentType: fetchedContentType })

        // Fulfill
        await route.fulfill({
          status: response.status(),
          headers: response.headers(),
          body: buffer
        })
      } catch (_e) {
        // console.log('Failure to fetch route', e)
        return route.continue()
      }
    }
  )
  return reporter
}
