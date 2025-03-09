import { BrowserContext, Page } from 'rebrowser-playwright'
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
import { URLS } from './fanbox/constants.js'
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

export class Extractor {
  site: keyof typeof URLS = 'patreon' as const
  context: BrowserContext
  page: Page
  sourceUrl: string = ''
  visited: Set<string>
  years: string[]
  turndownService: TurndownService
  stream?: fs.WriteStream
  outDir: string
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

  async extract(sourceUrl: string, rawYear?: string) {
    console.log('🎬 Starting extractor')
    if (this.site === 'pixivFanbox') {
      this.turndownService.keep(['video', 'source'])
    }
    const year = rawYear === 'undefined' ? '' : rawYear
    this.sourceUrl = sourceUrl.split('?')[0]
    this.beforeExtractCheck(sourceUrl, year)
    if (this.sourceUrl.endsWith('/posts')) {
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
    while (hasMore) {
      await this.randomScroll(this.page)
      const urls = await this.getPostUrls()
      let page: Page | null = null
      for (const url of urls) {
        if (!this.visited.has(url)) {
          await waitForDelay()
          page = page || (await this.context.newPage())
          await randomMouseMovements(page)
          page = await this.savePost(url, dirPath, page)
          this.pushVisited(url)
        }
      }
      try {
        hasMore = await this.loadMore(this.page)
      } catch (e) {
        console.error(e)
        throw e
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
      .locator('[data-tag="post-details"]')
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
    page.on('response', async (response) => {
      const url = response.url()

      // Check if the response is an image
      if (
        url.includes('eyJxIjoxMDAsIndlYnAiOjB9') &&
        url.includes(id) &&
        url.toLowerCase().match(/\.(jpg|jpeg|png|gif|webp|jfif|bmp)/)
      ) {
        try {
          const spinner = ora(`Saving image ${url}`).start()
          const imageId = url.split('?')[0].split('/').at(-3) as string
          if (savedImages[imageId]) {
            spinner.succeed(`Already saved ${imageId}, skipping`)
            return
          }
          const foundName = this.checker(imageId)
          if (foundName) {
            spinner.succeed(`Already saved ${imageId}, skipping`)
            savedImages[imageId] = true
            imageIdToName[imageId] = foundName
            return
          }
          const buffer = await response.body() // Get image data
          const { ext } = await fileTypeFromBuffer(buffer).then(
            (i) => i || { ext: 'file', mime: 'unknown' }
          )
          const filename = `${name}-${imageId}.${ext}`
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
        } catch (error) {
          console.error(`🚨 Failed to save image from: ${url}`, error)
        }
      }
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
        let i = 1
        while (i < imageCount) {
          console.log(`⏲ Waiting for image ${i + 1}/${imageCount} to load`)
          await page.evaluate((selector) => {
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
          }, this.selectors.bigImage)
          // console.log('→ Clicking next button')
          await nextButton.click()
          // console.log('→ Clicked next button')
          await waitForDelay(Math.floor(Math.random() * 1000 + 100))
          i++
        }
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

  async getPostTitle(page: Page) {
    return await page.locator(this.selectors.contentTitle).innerText()
  }

  async getPageName(page: Page) {
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
  }) {
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
    const title = await this.getPostTitle(page)
    const content = this.turndownService.turndown(html)
    let markdown = `# [${title}](${page.url()})

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
    if (timestamp) {
      try {
        // console.log('* Setting file time to', mdPath, timestamp)
        fs.utimesSync(mdPath, timestamp, timestamp)
      } catch (e) {
        console.log('* Failed to set md time', e)
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
    console.log(
      'Loaded next page at',
      await page.evaluate(
        () =>
          // @ts-ignore page ctx
          location.href
      )
    )
    return true
  }
}
