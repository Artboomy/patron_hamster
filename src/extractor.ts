import type {
  ScraperContext,
  ScraperLocator,
  ScraperPage,
  ScraperResponse
} from './extractor/pageTypes.js'
import {
  getFileChecker,
  normalizeFileName,
  randomMouseMovements,
  patchLinks,
  type AttachmentRef,
  waitForDelay,
  waitForEnter
} from './utils.js'
import fs from 'node:fs'
import path from 'path'
import type { ExtractorCliOptions } from './index.js'
import TurndownService from 'turndown'
import {
  createDownloadProgressReporter,
  downloadFile,
  linkToBuffer,
  resolveOutputFilePath,
  saveBufferToDisk
} from './extractor/utils.js'
import { fileTypeFromBuffer } from 'file-type'
import ora, { oraPromise } from 'ora'

const VISITED_URLS = 'visited.txt'

export const URLS = {
  patreon: {
    login: 'https://www.patreon.com/login',
    host: 'https://www.patreon.com'
  },
  pixivFanbox: {
    login: 'https://accounts.pixiv.net/login',
    // host is dynamic in format *.fanbox.cc
    host: 'https://www.*fanbox.cc'
  },
  substack: {
    login: 'https://substack.com/sign-in',
    // host is dynamic in format *.substack.com
    host: 'https://*.substack.com'
  }
} as const

export function getPatreonPostNameFromPathname(pathname: string): string {
  const postSegment = pathname.split('/posts/').at(1)
  if (postSegment) {
    return postSegment.split('/')[0] || ''
  }
  return pathname.split('/').filter(Boolean).at(-1) || ''
}

export function imageHook(cfg: {
  page: ScraperPage
  savedImages: Record<string, boolean>
  imageIdToName: Record<string, string>
  checkDesiredImage: (url: string) => boolean
  checkFileExists: Extractor['checker']
  getImageId: (url: string) => string
  postName: string
  outDir: string
  timestamp: Date
  tags: string[]
  resize?: ExtractorCliOptions['resize']
}) {
  const {
    page,
    savedImages,
    imageIdToName,
    checkDesiredImage,
    checkFileExists,
    getImageId,
    postName,
    outDir,
    timestamp,
    tags,
    resize
  } = cfg
  const listener: (response: ScraperResponse) => void = async (response) => {
    const url = response.url()

    // Check if the response is an image
    if (
      checkDesiredImage(url) &&
      url.toLowerCase().match(/\.(jpg|jpeg|png|gif|webp|jfif|bmp)/)
    ) {
      try {
        const spinner = ora(`Saving image ${url}`).start()
        const reportProgress = createDownloadProgressReporter(spinner, 'Saving image')

        const imageId = getImageId(url)
        if (savedImages[imageId]) {
          spinner.succeed(`Already saved ${imageId}, skipping`)
          return
        }
        const foundName = checkFileExists(imageId)
        if (foundName) {
          spinner.succeed(`Already saved ${imageId}, skipping`)
          savedImages[imageId] = true
          imageIdToName[imageId] = foundName
          return
        }
        const buffer = await response.body(reportProgress) // Get image data
        if (buffer.length) {
          const { ext, mime } = await fileTypeFromBuffer(buffer).then(
            (i) => i || { ext: 'file', mime: 'unknown' }
          )
          const filename = path.basename(`${postName}-${imageId}.${ext}`)
          const filePath = resolveOutputFilePath(outDir, filename)
          await saveBufferToDisk({
            buffer,
            filePath,
            timestamp,
            tags,
            isImage: true,
            mimeType: mime,
            resize
          })
          spinner.succeed(`Saved ${filename}`)
          savedImages[imageId] = true
          imageIdToName[imageId] = filename
        } else {
          spinner.succeed(`⚠  Ignoring zero-size buffer for ${imageId}`)
        }
      } catch (error) {
        console.error(`🚨 Failed to save image from: ${url}`, error)
      }
    }
  }
  page.on('response', listener)
  return listener
}

export class Extractor {
  site: keyof typeof URLS = 'patreon' as const
  context: ScraperContext
  page: ScraperPage
  sourceUrl: string = ''
  pageUrl: string = ''
  visited: Set<string>
  years: string[]
  turndownService: TurndownService
  stream?: fs.WriteStream
  outDir: string
  lockedCount = 0
  updateMode = false
  pollMode = false
  resize: ExtractorCliOptions['resize']
  selectors: Record<string, string> = {
    postUrls: '[data-tag="post-title"] > a',
    imagesClickable: '[data-tag="post-card"] [data-tag="gallery-image"]',
    bigImage: '[data-tag="lightboxImage"]',
    nextImageButton: '[data-tag="nextImage"]',
    filterHeader: 'h2:has-text("Filter Posts")',
    filterButton:
      '[data-tag="post-feed-filter-toggle"], button[aria-label="post feed filters toggle"]',
    onlyUnblockedFilter:
      'button[role="switch"][aria-label="Show only posts I can access"]',
    yearFilter: 'input[name="post-filter-date"]',
    applyButton: 'button:has-text("Apply filters")',
    loadMoreButton: 'button:text("Load more")',
    loader: '[aria-label="loading more posts"]',
    contentTitle: '[data-tag="post-card"] [data-tag="post-title"]',
    subtitle: '',
    tags: '[data-tag="post-tag"]',
    locked: '',
    noCards: '[data-tag="stream-empty-card"]',
    attachments: '[data-tag="post-attachment-link"]'
  }
  checker: (id: string) => string | null

  constructor(
    page: ScraperPage,
    context: ScraperContext,
    options: ExtractorCliOptions
  ) {
    this.context = context
    this.page = page
    this.visited = new Set()
    this.years = []
    this.turndownService = new TurndownService()
    this.outDir = options.outDir
    this.updateMode = options.updateMode
    this.pollMode = Boolean(options.pollMode)
    this.resize = options.resize
    this.checker = getFileChecker(this.outDir)
    this.loadVisited()
  }

  // may use later
  async _getYears() {
    console.log('Getting available years for filtering')

    await this.page.locator(this.selectors.filterButton).first().click()
    console.log('| Opened filter modal')

    const years: string[] = await this.page
      .locator(this.selectors.yearFilter)
      .evaluateAll((elements) =>
        (elements as Array<{ innerText: string }>).reduce<string[]>(
          (acc, e) => {
            const i = e.innerText || ''
            if (!i.startsWith('20')) return acc
            acc.push(i.split(' ')[0])
            return acc
          },
          []
        )
      )
    console.log(`| Extracted years: ${years.join(', ')}`)

    const filtered = years.filter((i) => !this.years.includes(i))
    console.log(`| Filtered years: ${filtered.join(', ')}`)

    return filtered
  }

  async waitForPosts() {
    await this.cloudflareGuard(this.page, 'waitForPosts')
    if (this.selectors.noCards) {
      const noCards = this.page.locator(this.selectors.noCards)
      if ((await noCards.count()) === 1) {
        console.log('😥 No posts available')
        return
      }
    }
    try {
      await this.page.waitForSelector(this.selectors.postUrls, {
        state: 'attached'
      })
    } catch (e) {
      console.log('Something failed when waiting for posts')
      console.error(e)
      throw e
    }
  }

  async waitForBigImage(page: ScraperPage) {
    await page.waitForSelector(this.selectors.bigImage, { state: 'attached' })
  }

  async setFilter(year: string | unknown) {
    if (typeof year !== 'string') {
      throw new Error('Invalid argument year')
    }
    console.log(`Applying filter by year ${year}`)

    if ((await this.page.locator(this.selectors.filterHeader).count()) === 0) {
      await this.page.waitForSelector(this.selectors.filterButton, {
        state: 'attached',
        timeout: 15_000
      })
      await this.page.locator(this.selectors.filterButton).first().click()
      console.log('| Opened filter modal')
    } else {
      console.log('| Filter modal already open')
    }

    await this.page
      .locator(`${this.selectors.yearFilter}[value="${year}"]`)
      .click()
    console.log(`| Selected ${year} year`)
    await waitForDelay(Math.random() * 1000)

    const onlyAccessible = this.page.locator(this.selectors.onlyUnblockedFilter)
    if ((await onlyAccessible.getAttribute('aria-checked')) !== 'true') {
      await onlyAccessible.click()
    }
    console.log('| Selected only accessible')
    await waitForDelay(Math.random() * 1000)

    const postType = this.pollMode ? 'Poll' : 'Image'
    await this.page
      .locator('button', { hasText: new RegExp(`^${postType} \\(\\d+\\)$`) })
      .click()
    await waitForDelay(Math.random() * 1000)
    // await this.page.locator('p', { hasText: 'Unplayed' }).click()
    // await waitForDelay(Math.random() * 1000)

    await this.page.locator(this.selectors.applyButton).click()
    console.log(`| Applied`)

    await oraPromise(this.waitForPosts(), 'Waiting for posts')
  }

  async randomScroll(page: ScraperPage) {
    await this.cloudflareGuard(page, 'randomScroll', page)
    const randomY = Math.floor(Math.random() * 1000) + 200 // Random offset
    // @ts-ignore page ctx
    await page.evaluate((y) => window.scrollBy(0, y), randomY)
  }

  beforeExtractCheck(...args: Parameters<Extractor['extract']>) {
    const [sourceUrl, year] = args
    if (sourceUrl.endsWith('/posts')) {
      if (!year || year === 'undefined') {
        const error = Error('No year provided')
        // @ts-ignore custom
        error.recoverable = false
        throw error
      }
    }
  }

  isAllPostsUrl(): boolean {
    return this.sourceUrl.endsWith('/posts')
  }

  async extract(sourceUrl: string, rawYear?: string) {
    console.log('🎬 Starting extractor')
    if (this.site === 'pixivFanbox') {
      this.turndownService.keep(['video', 'source'])
    }
    const year = rawYear === 'undefined' ? '' : rawYear
    this.sourceUrl = sourceUrl.split('?')[0]
    this.pageUrl = sourceUrl
    this.beforeExtractCheck(sourceUrl, year)
    if (this.isAllPostsUrl()) {
      if (year) {
        console.log(`| All posts mode. Extracting from year ${year}`)
      } else {
        console.log('| All posts mode')
      }
      return this.withPatreonImagesBlocked(this.page, async () => {
        await this.page.goto(sourceUrl, {
          timeout: 999999
        })
        return this.extractAllPosts(year as string)
      })
    } else {
      console.log('| Single post mode')
      await this.savePost(sourceUrl, path.resolve(this.outDir), this.page)
      return path.resolve(this.outDir)
    }
  }

  async extractAllPosts(year?: string) {
    let page: ScraperPage | null = null
    try {
      try {
        await this.setFilter(year)
      } catch (e) {
        console.log('Failed to set filter')
        console.error(e)
        await waitForEnter()
        throw e
      }
      const dirPath = year
        ? path.resolve(this.outDir, year)
        : path.resolve(this.outDir)
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true })
      }
      let hasMore = true
      let urlCount = 0
      let updateModeThreshold = 0
      while (hasMore) {
        await this.randomScroll(this.page)
        const urls = await this.getPostUrls()
        if (this.site === 'patreon' && urlCount === urls.length) {
          break
        }
        urlCount = urls.length
        for (const url of urls) {
          if (!this.visited.has(url)) {
            await waitForDelay()
            page = page || (await this.context.newPage())
            await this.savePost(url, dirPath, page)
            this.pushVisited(url)
          } else if (this.updateMode) {
            updateModeThreshold += 1
            // fanbox has pinned posts which may result in false updated state
            if (updateModeThreshold > 2) {
              hasMore = false
              console.log('Reached processed post, exiting update mode.')
              break
            }
          }
        }
        if (hasMore) {
          try {
            hasMore = await this.loadMore(this.page)
          } catch (e) {
            console.error(e)
            throw e
          }
        }
      }
      return dirPath
    } finally {
      try {
        await page?.close()
      } finally {
        this.closeStream()
      }
    }
  }

  async cloudflareGuard(
    page: ScraperPage,
    fnName:
      | 'randomScroll'
      | 'getPostDate'
      | 'saveImageOnlyPost'
      | 'getTags'
      | 'waitForPosts',
    ...args: unknown[]
  ) {
    await page.waitForLoadState('domcontentloaded')
    try {
      if (
        (await page.locator('.ray-id, ._challenge_basic_security').count()) > 0
      ) {
        console.log('! Please solve captcha')
        await waitForEnter()
        // @ts-ignore chore
        await this[fnName](...args)
      }
    } catch (e) {
      console.log('! Failed guard, waiting', e)
      await waitForDelay(Math.random() * 1000)
      await this.cloudflareGuard(page, fnName, args)
    }
  }

  async getPostDate(page: ScraperPage) {
    await this.cloudflareGuard(page, 'getPostDate', page)
    const dateStr = await page
      .locator('meta[property="article:published_time"]')
      .getAttribute('content')
    if (!dateStr) throw new Error('Post publication date not found')
    console.log(`| Raw date str: ${dateStr}`)
    return new Date(dateStr)
  }

  async getTags(page: ScraperPage): Promise<string[]> {
    await this.cloudflareGuard(page, 'getTags', page)
    return await page
      .locator(this.selectors.tags)
      .evaluateAll((elements) =>
        (elements as Array<{ innerText: string }>).map((i) => i.innerText)
      )
  }

  async getPollDetails(page: ScraperPage): Promise<{
    choices: string[]
    votesTotal: string | null
  } | null> {
    if (!this.pollMode) {
      return null
    }
    const polls = await page
      .locator('[data-testid="single-column-post-wrapper"]')
      .evaluateAll((elements) =>
        (
          elements as Array<{
            querySelectorAll: (selector: string) => ArrayLike<{
              getAttribute: (name: string) => string | null
            }>
            textContent: string | null
          }>
        )
          .map((element) => ({
            choices: Array.from(
              element.querySelectorAll('[role="radio"][aria-label]')
            )
              .map((choice) => choice.getAttribute('aria-label'))
              .filter((choice): choice is string => Boolean(choice)),
            votesTotal:
              element.textContent?.match(/\b\d[\d,]* votes? total\b/i)?.[0] ??
              null
          }))
          .filter((poll) => poll.choices.length > 0)
      )
    return polls[0] || null
  }

  relativeUrlToAbsoluteUrl(url: string): string {
    const { protocol, host } = new URL(this.sourceUrl)
    const hostname = `${protocol}//${host}`
    return url.startsWith('https:') ? url : hostname + url
  }

  private async withPatreonImagesBlocked<T>(
    page: ScraperPage,
    operation: () => Promise<T>
  ): Promise<T> {
    if (this.site !== 'patreon') return operation()
    try {
      await page.setImageRequestsBlocked(true)
      return await operation()
    } finally {
      await page.setImageRequestsBlocked(false)
    }
  }

  async savePost(
    url: string,
    outDir: string,
    page: ScraperPage
  ): Promise<ScraperPage> {
    console.log(`\nSaving post ${url} into ${outDir}`)
    return this.withPatreonImagesBlocked(page, async () => {
      if (page.url() !== url) {
        await page.goto(this.relativeUrlToAbsoluteUrl(url), {
          timeout: 999999
        })
      }
      await this.randomScroll(page)
      await randomMouseMovements(page)
      await this.saveFullPost(page, outDir)
      return page
    })
  }

  getContentBlock(page: ScraperPage) {
    return page.locator('.patreon-post-content').first()
  }

  async saveImageOnlyPost(cfg: {
    page: ScraperPage
    outDir: string
    timestamp: Date
    tags: string[]
  }) {
    const { page, outDir, timestamp, tags } = cfg
    const checkFileExists = getFileChecker(outDir)
    await this.cloudflareGuard(page, 'saveImageOnlyPost', cfg)
    const name = await this.getPageName(page)
    const id = await this.getPostId(page)
    console.log(`| Post date: ${timestamp}`)
    const imagesToClick = page.locator(this.selectors.imagesClickable)
    const visibleImageIndexes = await imagesToClick.evaluateAll((elements) => {
      function isVisible(el: unknown) {
        const element = el as {
          parentElement: unknown
          nodeType?: number
        } | null
        if (!element || element.nodeType !== 1) return false

        for (
          let node = element as {
            parentElement: unknown
          } | null;
          node;
          node = node.parentElement as { parentElement: unknown } | null
        ) {
          const style = (
            globalThis as unknown as {
              getComputedStyle: (n: unknown) => {
                display: string
                visibility: string
                opacity: string
              }
            }
          ).getComputedStyle(node)
          if (style.display === 'none') return false
          if (style.visibility === 'hidden') return false
          if (style.opacity === '0') return false
        }

        return true
      }

      return elements.reduce<number[]>((acc, el, idx) => {
        if (isVisible(el)) acc.push(idx)
        return acc
      }, [])
    })
    const staticImageUrls = (
      await this.getContentBlock(page)
        .locator('img')
        .evaluateAll((elements) =>
          (
            elements as Array<{
              getAttribute: (attr: string) => string | null
              baseURI: string
            }>
          ).map((el) => {
            const src = el.getAttribute('src')?.trim()
            return src ? new URL(src, el.baseURI).href : null
          })
        )
    ).filter((i): i is string => Boolean(i && i.includes(id)))
    const imageCount = visibleImageIndexes.length
    console.log(
      `Found ${imageCount} clickable images, ${staticImageUrls.length} static images`
    )
    const imageUrls = new Map<string, string>()
    for (const url of staticImageUrls) {
      imageUrls.set(url.split('?')[0].split('/').at(-3) as string, url)
    }
    if (imageCount) {
      console.log(`↓ Collecting ${imageCount} carousel image URLs`)
      await imagesToClick.nth(visibleImageIndexes[0] as number).click({
        force: true
      })
      const carouselUrls = await this.collectPatreonCarouselUrls(page, imageCount)
      for (const url of carouselUrls) {
        // Full-size carousel sources replace inline thumbnails of the same image.
        imageUrls.set(url.split('?')[0].split('/').at(-3) as string, url)
      }
    }
    if (!imageUrls.size) {
      console.log('☠ Found 0 urls')
    }
    const imageIdToName: Record<string, string> = {}
    for (const [imageId, url] of imageUrls) {
      imageIdToName[imageId] = checkFileExists(imageId) || ''
      if (imageIdToName[imageId]) {
        console.log(`Image ${imageId} already exists`)
        continue
      }
      const spinner = ora(`Saving image ${url}`).start()
      try {
        const img = await linkToBuffer(
          page,
          url,
          createDownloadProgressReporter(spinner, 'Saving image')
        )
        imageIdToName[imageId] = await downloadFile(
          outDir,
          `${name}-${imageId}`,
          timestamp,
          tags,
          img,
          this.resize
        )
        spinner.succeed(`Saved ${imageIdToName[imageId]}`)
      } catch (error) {
        spinner.fail(`Failed to save image ${url}`)
        throw error
      }
    }
    return imageIdToName
  }

  private async collectPatreonCarouselUrls(
    page: ScraperPage,
    imageCount: number
  ): Promise<string[]> {
    const urls: string[] = []
    for (let index = 0; index < imageCount; index++) {
      const deadline = Date.now() + 10_000
      let nextUrl: string | undefined
      while (Date.now() < deadline) {
        // Re-query each time: Patreon can reuse the image or replace its node.
        const url = await page.evaluate((selector) => {
          // This callback runs in the browser; the Node build omits DOM types.
          const browserGlobal = globalThis as unknown as {
            document: {
              baseURI: string
              querySelector: (query: string) => {
                getAttribute: (name: string) => string | null
              } | null
            }
          }
          const doc = browserGlobal.document
          const src = doc
            .querySelector(selector as string)
            ?.getAttribute('src')
            ?.trim()
          if (!src) return null
          const source = new URL(src, doc.baseURI)
          return source.protocol === 'https:' || source.protocol === 'http:'
            ? source.href
            : null
        }, this.selectors.bigImage)
        if (url && !urls.includes(url)) {
          nextUrl = url
          break
        }
        await waitForDelay(100)
      }
      if (!nextUrl) {
        throw new Error(
          `Patreon carousel ${page.url()}: timed out waiting for image ${index + 1}/${imageCount} source after ${urls.at(-1) || 'opening the carousel'}`
        )
      }
      urls.push(nextUrl)
      if (index + 1 < imageCount) {
        await page.locator(this.selectors.bigImage).hover()
        const nextButton = page.locator(this.selectors.nextImageButton)
        if (!(await nextButton.count())) {
          throw new Error(
            `Patreon carousel ${page.url()}: missing next button before image ${index + 2}/${imageCount}`
          )
        }
        try {
          await nextButton.click({ force: true })
        } catch (error) {
          throw new Error(
            `Patreon carousel ${page.url()}: failed to advance to image ${index + 2}/${imageCount}`,
            { cause: error }
          )
        }
      }
    }
    return urls
  }

  async iterateCarousel(
    imageCount: number,
    page: ScraperPage,
    nextButton: ScraperLocator
  ) {
    let i = 1
    while (i < imageCount) {
      await oraPromise(
        page.evaluate((selector) => {
          return new Promise<void>((resolve) => {
            // @ts-ignore page ctx
            const img = document.querySelector(selector) as HTMLImageElement
            if (!img) {
              resolve() // Resolve immediately if no image found
              return
            }

            if (img.complete && img.naturalWidth > 0) {
              resolve() // Image is already loaded
            } else {
              img.onload = () => resolve()
              img.onerror = () => resolve() // Resolve even if the image fails to load
            }
          })
        }, this.selectors.bigImage),
        `Waiting for image ${i + 1}/${imageCount} to load`
      )
      await page.locator(this.selectors.bigImage).hover()
      await nextButton.click()
      await waitForDelay(Math.floor(Math.random() * 1000 + 100))
      i++
    }
  }

  async getPostTitle(page: ScraperPage): Promise<string> {
    return await page.locator(this.selectors.contentTitle).first().innerText()
  }

  async getPostSubtitle(page: ScraperPage): Promise<string> {
    if (!this.selectors.subtitle) {
      return ''
    }
    const loc = page.locator(this.selectors.subtitle)
    if ((await loc.count()) > 0) {
      return await loc.innerText()
    }
    return ''
  }

  async getPageName(page: ScraperPage): Promise<string> {
    const pathname = await page.evaluate(() =>
      // @ts-ignore this is browser context
      location.pathname
    )
    return getPatreonPostNameFromPathname(pathname)
  }

  async getPostId(page: ScraperPage): Promise<string> {
    const pathname = await page.evaluate(
      () =>
        // @ts-ignore this is browser context
        location.pathname
    )
    const postSegment = pathname.split('/posts/').at(1)?.split('/')[0]
    if (postSegment) {
      return postSegment.split('-').at(-1) || postSegment
    }
    const fallback = pathname.split('/').filter(Boolean).at(-1) || ''
    return fallback.split('-').at(-1) || fallback
  }


  getAttachmentName(_href: string, filename: string) {
    return filename
  }

  async saveAttachments({
    page,
    outDir,
    timestamp,
    postId
  }: {
    page: ScraperPage
    outDir: string
    timestamp: Date
    postId: string
  }): Promise<AttachmentRef[]> {
    const urlLocator = page.locator(this.selectors.attachments)
    const urls: Array<{ href: string; filename: string }> = (
      await urlLocator.evaluateAll((elements) =>
        (elements as Array<{ href: string; innerText: string }>).map((i) => ({
          href: i.href || '',
          filename: (i.innerText || '').replaceAll(/\s/g, '-')
        }))
      )
    ).map((i) => ({
      href: i.href,
      filename: this.getAttachmentName(i.href, i.filename)
    }))
    if (!urls.length) {
      return []
    }
    console.log(`📦 Found ${urls.length} attachments...`)
    const list: AttachmentRef[] = []
    const attachmentDirName = normalizeFileName(postId)
    const attachmentDir = path.resolve(outDir, attachmentDirName)
    fs.mkdirSync(attachmentDir, { recursive: true })
    const checkFileExists = getFileChecker(attachmentDir)

    for (const { href, filename } of urls) {
      const spinner = ora(`Saving file ${href} to ${filename}.`).start()
      const outputFileName = path.basename(filename)
      const existingFileName = checkFileExists(outputFileName)
      if (existingFileName) {
        spinner.succeed(`File ${existingFileName} already exists, skipping`)
        list.push({
          href,
          fileName: existingFileName,
          path: path.posix.join(attachmentDirName, existingFileName)
        })
        continue
      }
      const fileBuffer = await linkToBuffer(page, href)
      const savedFileName = await downloadFile(
        attachmentDir,
        outputFileName,
        timestamp,
        [],
        fileBuffer,
        this.resize
      )
      list.push({
        href,
        fileName: savedFileName,
        path: path.posix.join(attachmentDirName, savedFileName)
      })
      spinner.succeed()
    }
    return list
  }

  async saveFullPost(page: ScraperPage, outDir: string) {
    await page.waitForSelector(this.selectors.loader, {
      state: 'detached'
    })
    if (this.selectors.locked) {
      if ((await page.locator(this.selectors.locked).count()) > 0) {
        console.log('🔒 Locked post, skipping')
        this.lockedCount += 1
        return
      }
    }
    const name = await this.getPageName(page)
    const postId = await this.getPostId(page)
    const tags = await this.getTags(page)
    const timestamp = await this.getPostDate(page)
    const contentBlock = this.getContentBlock(page)
    const poll = await this.getPollDetails(page)
    const attachments = await this.saveAttachments({
      page,
      outDir,
      timestamp,
      postId
    })
    const imageIdToName = await this.saveImageOnlyPost({
      page,
      outDir,
      timestamp,
      tags
    })
    console.log('| Resulting image map: ', JSON.stringify(imageIdToName))
    const html = patchLinks({
      html: await contentBlock.innerHTML(),
      imageMap: imageIdToName,
      site: this.site,
      attachments
    })
    // fs.writeFileSync('test.html', html, 'utf8')
    const title = await this.getPostTitle(page)
    const subtitle = await this.getPostSubtitle(page)
    const content = this.turndownService.turndown(html)
    let markdown = `# [${title}](${page.url()})
${subtitle ? '\n#### *' + subtitle + '*\n' : ''}
*Date: ${timestamp.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })}*

${content}
    `
    if (poll) {
      markdown += `\n\n ## Poll\n${poll.choices
        .map((choice) => `- ${choice}`)
        .join('\n')}${poll.votesTotal ? `\n\n${poll.votesTotal}` : ''}`
    }
    if (Object.keys(imageIdToName).length) {
      markdown += `\n\n ## Gallery\n${Object.values(imageIdToName).map((i) => `![${i}](${i})\n`)}`
    }
    if (attachments.length) {
      markdown += `\n\n ## Attachments\n ${attachments
        .map((attachment) => `[${attachment.fileName}](${attachment.path})`)
        .join('\n')}`
    }
    if (tags.length) {
      markdown += `\n\n ## Tags\n ${tags.map((t) => '`' + t + '`').join(' ')}`
    }
    const mdPath = resolveOutputFilePath(outDir, name + '.md')
    fs.writeFileSync(mdPath, markdown)
    fs.writeFileSync(
      resolveOutputFilePath(outDir, name + '.json'),
      JSON.stringify({
        title: title,
        date: timestamp.getTime()
      })
    )
    if (timestamp) {
      try {
        fs.utimesSync(mdPath, timestamp, timestamp)
      } catch (e) {
        console.log('❌ Failed to set md time', e)
      }
    }
  }

  loadVisited() {
    try {
      this.visited = new Set(
        fs
          .readFileSync(path.resolve(this.outDir, VISITED_URLS), 'utf8')
          .split('\n')
          .filter(Boolean)
      )
      console.log(`Loaded ${this.visited.size} visited entries`)
    } catch (_e) {
      console.log('Failed to load visited with error', _e)
      this.visited = new Set<string>()
      console.log('Created empty visited set')
    }
  }

  pushVisited(url: string) {
    if (!this.stream) {
      this.stream = fs.createWriteStream(
        path.resolve(this.outDir, VISITED_URLS),
        { flags: 'a' }
      )
    }
    this.stream.write(url + '\n')
    this.visited.add(url)
  }

  closeStream() {
    this.stream?.close()
    this.stream = undefined
  }

  async getPostUrls(): Promise<string[]> {
    console.log('Getting post urls')
    await this.waitForPosts()

    const list = await this.page
      .locator(this.selectors.postUrls)
      .evaluateAll((elements) =>
        (
          elements as Array<{ getAttribute: (attr: string) => string | null }>
        ).map((el) => el.getAttribute('href'))
      )
    const filtered = list.filter((i): i is string => Boolean(i))
    console.log('| Urls from this page: ', list.join(', '))
    return filtered
  }

  getFlags(): Record<string, boolean> {
    try {
      return JSON.parse(fs.readFileSync('flags.json', 'utf8'))
    } catch (_e) {
      return {}
    }
  }

  isLoggedIn(flags: Record<string, boolean>) {
    return flags[this.site]
  }

  async doLogin(options?: { targetUrl?: string }) {
    const flags = this.getFlags()
    const targetUrl =
      typeof options?.targetUrl === 'string' && options.targetUrl
        ? options.targetUrl
        : ''
    if (this.isLoggedIn(flags)) return
    await this.page.goto(targetUrl || URLS[this.site].login)
    console.log('🔑 Please login and press Enter')
    await waitForEnter()
    fs.writeFileSync(
      'flags.json',
      JSON.stringify({ ...flags, [this.site]: true }),
      'utf8'
    )
    if (targetUrl) {
      await this.page.goto(targetUrl)
    }
  }

  getLoadMoreButton(page: ScraperPage) {
    return page.locator('button', { hasText: /^Load more$/ })
  }

  async loadMore(page: ScraperPage) {
    console.log('Loading more pages')
    const button = this.getLoadMoreButton(page)
    if ((await button.count()) === 0) {
      console.log('😲 No next button found')
      return false
    }
    await button.first().scrollIntoViewIfNeeded()
    await oraPromise(button.click(), 'Clicking next button')

    await oraPromise(
      page.waitForSelector(this.selectors.loader, {
        state: 'attached'
      }),
      'Waiting for loader to appear'
    )
    await oraPromise(
      page.waitForSelector(this.selectors.loader, {
        state: 'detached'
      }),
      'Waiting for loader to hide'
    )
    const currentPage = await page.evaluate(
      () =>
        // @ts-ignore page ctx
        location.href
    )
    this.pageUrl = currentPage
    console.log('Loaded next page at', currentPage)
    return true
  }
}
