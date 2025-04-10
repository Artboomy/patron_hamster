import {
  BrowserContext,
  Locator,
  Page,
  Response as PlaywrightResponse
} from 'rebrowser-playwright'
import {
  getFileChecker,
  parseDate,
  randomMouseMovements,
  patchLinks,
  waitForDelay,
  waitForEnter,
  waitForObjLen
} from './utils.js'
import fs from 'node:fs'
import path from 'path'
import minimist from 'minimist'
import TurndownService from 'turndown'
import { StoredCookies } from './extractor/types.js'
import {
  downloadFile,
  linkToBuffer,
  saveBufferToDisk
} from './extractor/utils.js'
import { saveCookies } from './saveCookies.js'
import { fileTypeFromBuffer } from 'file-type'
import ora, { oraPromise } from 'ora'
import { imageExtensions } from './constants.js'

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

export function imageHook(cfg: {
  page: Page
  savedImages: Record<string, boolean>
  imageIdToName: Record<string, string>
  checkDesiredImage: (url: string) => boolean
  checkFileExists: Extractor['checker']
  getImageId: (url: string) => string
  postName: string
  outDir: string
  timestamp: Date
  tags: string[]
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
    tags
  } = cfg
  const listener: (response: PlaywrightResponse) => void = async (response) => {
    const url = response.url()

    // Check if the response is an image
    if (
      checkDesiredImage(url) &&
      url.toLowerCase().match(/\.(jpg|jpeg|png|gif|webp|jfif|bmp)/)
    ) {
      try {
        const spinner = ora(`Saving image ${url}`).start()
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
        const buffer = await response.body() // Get image data
        if (buffer.length) {
          const { ext } = await fileTypeFromBuffer(buffer).then(
            (i) => i || { ext: 'file', mime: 'unknown' }
          )
          const filename = `${postName}-${imageId}.${ext}`
          const filePath = path.resolve(outDir, filename)
          await saveBufferToDisk({
            buffer,
            filePath,
            timestamp,
            tags,
            isImage: true
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
  context: BrowserContext
  page: Page
  sourceUrl: string = ''
  pageUrl: string = ''
  visited: Set<string>
  years: string[]
  turndownService: TurndownService
  stream?: fs.WriteStream
  outDir: string
  lockedCount = 0
  updateMode = false
  selectors: Record<string, string> = {
    postUrls: '[data-tag="post-title"] > a',
    imagesClickable:
      '[data-tag="post-card"] .image-grid > img, [data-tag="post-card"]  .image-carousel > img',
    bigImage: '[data-tag="lightboxImage"]',
    nextImageButton: '[data-tag="nextImage"]',
    filterHeader: '[data-tag="filter-dialog-modal-title"]',
    filterButton: '[data-tag="post-feed-consolidated-filters-toggle"]',
    onlyUnblockedFilter: 'input[value="UNLOCKED_POSTS_ONLY"]',
    yearFilter: 'fieldset[name="consolidated-date-filter"] p',
    applyButton: '[data-tag="dialog-action-primary"]',
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

  constructor(page: Page, context: BrowserContext) {
    this.context = context
    this.page = page
    this.visited = new Set()
    this.years = []
    this.turndownService = new TurndownService()
    const args = minimist(process.argv.slice(2))
    this.outDir = args.dir
    this.updateMode = args.update
    this.checker = getFileChecker(this.outDir)
    this.loadVisited()
  }

  // may use later
  async _getYears() {
    console.log('Getting available years for filtering')

    await this.page.locator(this.selectors.filterButton).click()
    console.log('| Opened filter modal')

    const years: string[] = await this.page
      .locator(this.selectors.yearFilter)
      .evaluateAll((elements) =>
        elements.reduce((acc, e) => {
          const i = e.innerText
          if (!i.startsWith('20')) return acc
          acc.push(i.split(' ')[0])
          return acc
        }, [])
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

  async waitForBigImage(page: Page) {
    await page.waitForSelector(this.selectors.bigImage, { state: 'attached' })
  }

  async setFilter(year: string | unknown) {
    if (typeof year !== 'string') {
      throw new Error('Invalid argument year')
    }
    console.log(`Applying filter by year ${year}`)

    if ((await this.page.locator(this.selectors.filterHeader).count()) === 0) {
      await this.page.locator(this.selectors.filterButton).click()
      console.log('| Opened filter modal')
    } else {
      console.log('| Filter modal already open')
    }

    await this.page
      .locator(this.selectors.yearFilter, {
        hasText: new RegExp(`^${year} \\(\\d+\\)$`)
      })
      .click()
    console.log(`| Selected ${year} year`)
    await waitForDelay(Math.random() * 1000)

    await this.page.locator(this.selectors.onlyUnblockedFilter).click()
    console.log('| Selected only accessible')
    await waitForDelay(Math.random() * 1000)

    await this.page.locator('button', { hasText: /^Image \(\d+\)$/ }).click()
    await waitForDelay(Math.random() * 1000)
    // await this.page.locator('p', { hasText: 'Unplayed' }).click()
    // await waitForDelay(Math.random() * 1000)

    await this.page.locator(this.selectors.applyButton).click()
    console.log(`| Applied`)

    await oraPromise(this.waitForPosts(), 'Waiting for posts')
  }

  async randomScroll(page: Page) {
    await this.cloudflareGuard(page, 'randomScroll', page)
    const randomY = Math.floor(Math.random() * 1000) + 200 // Random offset
    // @ts-ignore page ctx
    await page.evaluate((y) => window.scrollBy(0, y), randomY)
  }

  beforeExtractCheck(...args: Parameters<Extractor['extract']>) {
    const [sourceUrl, year] = args
    if (sourceUrl.endsWith('/posts')) {
      if (!year || year === 'undefined') {
        throw Error('No year provided')
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
      await this.page.goto(sourceUrl, {
        timeout: 999999
      })
      return this.extractAllPosts(year as string)
    } else {
      console.log('| Single post mode')
      await this.savePost(sourceUrl, path.resolve(this.outDir), this.page)
      return path.resolve(this.outDir)
    }
  }

  async extractAllPosts(year?: string) {
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
      let page: Page | null = null
      for (const url of urls) {
        if (!this.visited.has(url)) {
          await waitForDelay()
          page = page || (await this.context.newPage())
          await randomMouseMovements(page)
          page = await this.savePost(url, dirPath, page)
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
    this.closeStream()
    return dirPath
  }

  async cloudflareGuard(
    page: Page,
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
        await saveCookies(this.context)
        // @ts-ignore chore
        await this[fnName](...args)
      }
    } catch (e) {
      console.log('! Failed guard, waiting', e)
      await waitForDelay(Math.random() * 1000)
      await this.cloudflareGuard(page, fnName, args)
    }
  }

  async getPostDate(page: Page) {
    await this.cloudflareGuard(page, 'getPostDate', page)
    const dateStr = await page
      .locator('[data-tag="post-card"] [data-tag="post-details"]')
      .locator('xpath=../../div[1]/div[1]/div[2]')
      .locator('p')
      .innerText()
    console.log(`| Raw date str: ${dateStr}`)
    return parseDate(dateStr)
  }

  async getTags(page: Page): Promise<string[]> {
    await this.cloudflareGuard(page, 'getTags', page)
    return await page
      .locator(this.selectors.tags)
      .evaluateAll((elements) => elements.map((i) => i.innerText))
  }

  relativeUrlToAbsoluteUrl(url: string): string {
    const { protocol, host } = new URL(this.sourceUrl)
    const hostname = `${protocol}//${host}`
    return url.startsWith('https:') ? url : hostname + url
  }

  async savePost(url: string, outDir: string, page: Page): Promise<Page> {
    console.log(`\nSaving post ${url} into ${outDir}`)
    if (page.url() !== url) {
      await page.goto(this.relativeUrlToAbsoluteUrl(url), {
        timeout: 999999
      })
    }
    await this.randomScroll(page)
    await randomMouseMovements(page)
    await this.saveFullPost(page, outDir)
    return page
  }

  getContentBlock(page: Page) {
    return page
      .locator('[data-tag="post-details"]')
      .locator('xpath=../../div[1]/div[2]')
      .first()
  }

  async saveImageOnlyPost(cfg: {
    page: Page
    outDir: string
    timestamp: Date
    tags: string[]
  }) {
    const { page, outDir, timestamp, tags } = cfg
    await this.cloudflareGuard(page, 'saveImageOnlyPost', cfg)
    const name = await this.getPageName(page)
    const id = await page.evaluate(() =>
      // @ts-ignore this is browser context
      location.pathname.replace('/posts/', '').split('-').at(-1)
    )
    console.log(`| Post date: ${timestamp}`)
    const savedImages: Record<string, boolean> = {}
    const imageIdToName: Record<string, string> = {}
    imageHook({
      page,
      savedImages,
      imageIdToName,
      checkDesiredImage: (url: string) =>
        url.includes('eyJxIjoxMDAsIndlYnAiOjB9') && url.includes(id),
      checkFileExists: (i: string) => this.checker(i),
      getImageId: (u: string) => u.split('?')[0].split('/').at(-3) as string,
      postName: name,
      outDir,
      timestamp,
      tags
    })
    const imagesToClick = page.locator(this.selectors.imagesClickable)
    const staticImageUrls = (
      await this.getContentBlock(page)
        .locator('img')
        .evaluateAll((elements) => elements.map((el) => el.getAttribute('src')))
    ).filter((i) => i.includes(id))
    const imageCount = await imagesToClick.count()
    console.log(
      `Found ${imageCount} clickable images, ${staticImageUrls.length} static images`
    )
    if (staticImageUrls.length > 0) {
      for (const url of staticImageUrls) {
        const imageId = url.split('?')[0].split('/').at(-3) as string
        imageIdToName[imageId] = this.checker(imageId) || ''
        if (!imageIdToName[imageId]) {
          const img = await linkToBuffer(page, url)
          imageIdToName[imageId] = await downloadFile(
            url,
            outDir,
            `${name}-${imageId}`,
            timestamp,
            tags,
            img
          )
        } else {
          console.log(`Image ${imageId} already exists`)
        }
      }
    }
    if (imageCount) {
      console.log(`↓ Downloading ${imageCount} multiple images`)
      await imagesToClick.nth(0).click({ force: true })
      // wait for initial carousel load
      await this.waitForBigImage(page)
      const nextButton = page.locator(this.selectors.nextImageButton)
      const hasNextButton = (await nextButton.count()) > 0
      if (hasNextButton) {
        await this.iterateCarousel(imageCount, page, nextButton)
      }
    } else {
      console.log('☠ Found 0 urls')
      await this.cloudflareGuard(page, 'saveImageOnlyPost', page, outDir)
    }
    await waitForDelay(Math.random() * 1000)
    await oraPromise(
      waitForObjLen(savedImages, imageCount),
      'Waiting for images to finish loading'
    )
    return imageIdToName
  }

  async iterateCarousel(imageCount: number, page: Page, nextButton: Locator) {
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

  async getPostTitle(page: Page): Promise<string> {
    return await page.locator(this.selectors.contentTitle).innerText()
  }

  async getPostSubtitle(page: Page): Promise<string> {
    if (!this.selectors.subtitle) {
      return ''
    }
    const loc = page.locator(this.selectors.subtitle)
    if ((await loc.count()) > 0) {
      return await loc.innerText()
    }
    return ''
  }

  async getPageName(page: Page): Promise<string> {
    return await page.evaluate(() =>
      // @ts-ignore this is browser context
      location.pathname.replace('/posts/', '')
    )
  }

  getAttachmentName(_href: string, filename: string) {
    return filename
  }

  async saveAttachments({
    page,
    outDir,
    timestamp
  }: {
    page: Page
    outDir: string
    timestamp: Date
  }): Promise<string[]> {
    const urlLocator = page.locator(this.selectors.attachments)
    const urls: Array<{ href: string; filename: string }> = (
      await urlLocator.evaluateAll((elements) =>
        elements.map((i) => ({
          href: i.href,
          filename: i.innerText.replaceAll(/\s/g, '-')
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
    const list: string[] = []

    let i = 0
    for (const { href, filename } of urls) {
      const spinner = ora(`Saving file ${href} to ${filename}.`).start()
      if (this.checker(filename)) {
        spinner.succeed(`File ${filename} already exists, skipping`)
        list.push(filename)
        continue
      }
      if (imageExtensions.some((z) => href.endsWith(z))) {
        // console.log(`Direct download for ${href}`)
        const img = await linkToBuffer(page, href)
        await downloadFile(href, outDir, filename, timestamp, [], img)
      } else {
        const [download] = await Promise.all([
          page.waitForEvent('download'),
          urlLocator.nth(i).click()
        ])
        await download.saveAs(path.resolve(outDir, filename))
        fs.utimesSync(path.resolve(outDir, filename), timestamp, timestamp)
      }
      list.push(filename)
      spinner.succeed()
      i++
    }
    return list
  }

  async saveFullPost(page: Page, outDir: string) {
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
    const tags = await this.getTags(page)
    const timestamp = await this.getPostDate(page)
    const contentBlock = this.getContentBlock(page)
    const attachments = await this.saveAttachments({ page, outDir, timestamp })
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
    if (Object.keys(imageIdToName).length) {
      markdown += `\n\n ## Gallery\n${Object.values(imageIdToName).map((i) => `![${i}](${i})\n`)}`
    }
    if (attachments.length) {
      markdown += `\n\n ## Attachments\n ${attachments.map((i) => `[${i}](${i})`).join('\n')}`
    }
    if (tags.length) {
      markdown += `\n\n ## Tags\n ${tags.map((t) => '`' + t + '`').join(' ')}`
    }
    const mdPath = path.resolve(outDir, name + '.md')
    fs.writeFileSync(mdPath, markdown)
    fs.writeFileSync(
      path.resolve(outDir, name + '.json'),
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
      console.log(`Loaded ${this.visited.size} entries`)
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
      .evaluateAll((elements) => elements.map((el) => el.getAttribute('href')))
    console.log('| Urls from this page: ', list.join(', '))
    return list
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

  async doLogin(cookies: StoredCookies) {
    const flags = this.getFlags()
    if (this.isLoggedIn(flags)) {
      return this.context.addCookies(cookies)
    }
    await this.page.goto(URLS[this.site].login)
    console.log('🔑 Please login and press Enter')
    await waitForEnter()
    fs.writeFileSync(
      'flags.json',
      JSON.stringify({ ...flags, [this.site]: true }),
      'utf8'
    )
    return this.context.addCookies(cookies)
  }

  getLoadMoreButton(page: Page) {
    return page.locator('button', { hasText: /^Load more$/ })
  }

  async loadMore(page: Page) {
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
