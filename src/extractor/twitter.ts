import fs from 'node:fs'
import path from 'node:path'
import ora from 'ora'
import TurndownService from 'turndown'
import type { ExtractorCliOptions } from '../index.js'
import { getFileChecker, waitForDelay, waitForEnter } from '../utils.js'
import {
  createDownloadProgressReporter,
  downloadFile,
  linkToBuffer,
  resolveOutputFilePath
} from './utils.js'
import type { ScraperContext, ScraperPage } from './pageTypes.js'

const PHOTO_LINK_SELECTOR =
  '[data-testid="primaryColumn"] a[href*="/status/"][href*="/photo/"]'
const LOGGED_IN_SELECTOR = [
  '[data-testid="SideNav_AccountSwitcher_Button"]',
  '[data-testid="AppTabBar_Profile_Link"]',
  'a[href="/compose/post"]'
].join(', ')
const CLOSE_DETAIL_SELECTOR =
  'button[aria-label="Close"], button[aria-label="Back"], [data-testid="app-bar-back"]'

const LOGIN_SELECTOR =
  '[data-testid="loginButton"], a[href="/i/flow/login"], a[href*="/i/flow/login"]'

const LOGIN_STATE_POLL_MS = 500
const LOGIN_STATE_TIMEOUT_MS = 30_000

type TwitterPhoto = {
  href: string
  imageUrl: string
  statusId: string
  photoNumber: string
  mediaId: string
  isPinned: boolean
}

type TwitterPost = {
  textHtml: string
  timestamp: string
  images: Array<{ alt: string; imageUrl: string }>
}
type TwitterPhotoCandidate = {
  href: string
  imageUrls: Array<string | undefined>
  isPinned: boolean
}

export function pickTwitterMediaUrl(
  candidates: Array<string | undefined>
): string | undefined {
  return candidates.find((url) => url?.includes('pbs.twimg.com/media/'))
}

function originalImageUrl(url: string): string {
  const imageUrl = new URL(url)
  imageUrl.searchParams.set('name', 'orig')
  return imageUrl.href
}

export class TwitterExtractor {
  readonly page: ScraperPage
  readonly turndownService: TurndownService
  readonly context: ScraperContext
  readonly outDir: string
  readonly updateMode: boolean
  readonly resize: ExtractorCliOptions['resize']
  readonly checker: (id: string) => string | null
  pageUrl = ''
  lockedCount = 0
  private sourceUrl = ''

  constructor(
    page: ScraperPage,
    context: ScraperContext,
    options: ExtractorCliOptions
  ) {
    this.page = page
    this.turndownService = new TurndownService()
    this.context = context
    this.outDir = options.outDir
    this.updateMode = options.updateMode
    this.resize = options.resize
    this.checker = getFileChecker(this.outDir)
  }

  async doLogin(options: { targetUrl?: string } = {}): Promise<void> {
    const targetUrl = options.targetUrl
    if (!targetUrl) {
      throw new Error('Twitter media URL is required')
    }
    await this.page.goto(targetUrl, { timeout: 999999 })
    if (await this.waitForLoggedIn()) {
      return
    }

    const loginVisible = (await this.page.locator(LOGIN_SELECTOR).count()) > 0
    console.log(
      loginVisible
        ? '🔑 Twitter login is required. Please login and press Enter'
        : '🔑 Twitter account was not detected. Please login and press Enter'
    )
    await waitForEnter()
    if (!(await this.waitForLoggedIn())) {
      const error = new Error('Twitter login was not detected after confirmation')
      Object.assign(error, { recoverable: false })
      throw error
    }
  }

  async extract(sourceUrl: string): Promise<string> {
    this.sourceUrl = sourceUrl
    this.pageUrl = sourceUrl
    await this.page.goto(sourceUrl, { timeout: 999999 })
    if (!(await this.waitForLoggedIn())) {
      const error = new Error('Twitter login is required before extracting media')
      Object.assign(error, { recoverable: false })
      throw error
    }

    const outputPath = path.resolve(this.outDir)
    fs.mkdirSync(outputPath, { recursive: true })
    const seenPhotos = new Set<string>()
    let idleScrolls = 0
    while (idleScrolls < 3) {
      const photos = await this.getPhotos()
      let newPhotos = 0
      for (const photo of photos) {
        if (seenPhotos.has(photo.href)) {
          continue
        }
        seenPhotos.add(photo.href)
        newPhotos += 1
        if (fs.existsSync(resolveOutputFilePath(outputPath, `${photo.statusId}.md`))) {
          if (this.updateMode && !photo.isPinned) {
            console.log('Reached processed post, exiting update mode.')
            return outputPath
          }
          continue
        }
        await this.openAndSavePost(photo, outputPath)
      }
      idleScrolls = newPhotos === 0 ? idleScrolls + 1 : 0
      if (idleScrolls < 3) {
        await this.page.evaluate(() => {
          const pageWindow = globalThis as unknown as {
            innerHeight: number
            scrollBy(x: number, y: number): void
          }
          pageWindow.scrollBy(0, pageWindow.innerHeight * 1.5)
        })
        await waitForDelay(750)
      }
    }
    return outputPath
  }

  private async isLoggedIn(): Promise<boolean> {
    return (await this.page.locator(LOGGED_IN_SELECTOR).count()) > 0
  }

  private async waitForLoggedIn(): Promise<boolean> {
    await this.page.waitForLoadState('domcontentloaded')
    const attempts = LOGIN_STATE_TIMEOUT_MS / LOGIN_STATE_POLL_MS
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await this.isLoggedIn()) {
        return true
      }
      if ((await this.page.locator(LOGIN_SELECTOR).count()) > 0) {
        return false
      }
      await this.page.waitForTimeout(LOGIN_STATE_POLL_MS)
    }
    return false
  }

  private async getPhotos(): Promise<TwitterPhoto[]> {
    const candidates: TwitterPhotoCandidate[] = await this.page
      .locator(PHOTO_LINK_SELECTOR)
      .evaluateAll((elements) =>
        (elements as Array<{
          href: string
          querySelector(
            selector: string
          ):
            | {
                currentSrc?: string
                src?: string
                style?: { backgroundImage?: string }
              }
            | null
          closest(selector: string):
            | {
                querySelector(
                  socialContextSelector: string
                ): { textContent?: string | null } | null
              }
            | null
        }>).map((anchor) => {
          const image = anchor.querySelector('img')
          const backgroundImage = anchor.querySelector(
            '[style*="background-image"]'
          )?.style?.backgroundImage
          const backgroundImageUrl = backgroundImage?.match(
            /url\(["']?(.*?)["']?\)/
          )?.[1]
          return {
            href: anchor.href,
            imageUrls: [image?.currentSrc, image?.src, backgroundImageUrl],
            isPinned:
              anchor
                .closest('article')
                ?.querySelector('[data-testid="socialContext"]')
                ?.textContent?.trim() === 'Pinned'
          }
        })
      )
    return candidates.reduce<TwitterPhoto[]>((photos, candidate) => {
      const match = candidate.href.match(/\/status\/(\d+)\/photo\/(\d+)/)
      const imageUrl = pickTwitterMediaUrl(candidate.imageUrls)
      if (!match || !imageUrl) {
        return photos
      }
      const mediaId = imageUrl.split('/media/').at(-1)?.split('?')[0]
      if (!mediaId) {
        return photos
      }
      photos.push({
        href: candidate.href,
        imageUrl,
        statusId: match[1],
        photoNumber: match[2],
        mediaId,
        isPinned: candidate.isPinned
      })
      return photos
    }, [])
  }

  private async openAndSavePost(
    photo: TwitterPhoto,
    outputPath: string
  ): Promise<void> {
    const selector =
      `${PHOTO_LINK_SELECTOR}[href*="/status/${photo.statusId}/photo/${photo.photoNumber}"]`
    this.pageUrl = this.sourceUrl
    await this.page.locator(selector).first().click({ force: true })
    await this.waitForDetailImage()
    await this.waitForPostTimestamp(photo.statusId)
    const post = await this.getClickedPost(photo.statusId)
    const timestamp = new Date(post.timestamp)
    if (Number.isNaN(timestamp.getTime())) {
      throw new Error(`Twitter post ${photo.statusId} has no publication date`)
    }
    const imageNames = await this.savePostImages(post, photo, outputPath, timestamp)
    const title = post.images.find((image) => image.alt && image.alt !== 'Image')?.alt || ''
    const content = this.turndownService.turndown(post.textHtml)
    let markdown = `# [${title || 'Twitter post'}](${photo.href})

*Date: ${timestamp.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })}*

${content}`
    if (imageNames.length) {
      markdown += `\n\n ## Gallery\n${imageNames.map((name) => `![${name}](${name})`).join('\n')}`
    }
    if (this.handle) {
      markdown += `\n\n ## Tags\n \`${this.handle}\``
    }
    const markdownPath = resolveOutputFilePath(outputPath, `${photo.statusId}.md`)
    fs.writeFileSync(markdownPath, markdown)
    fs.writeFileSync(
      resolveOutputFilePath(outputPath, `${photo.statusId}.json`),
      JSON.stringify({ title, date: timestamp.getTime() })
    )
    fs.utimesSync(markdownPath, timestamp, timestamp)
    await this.page.locator(CLOSE_DETAIL_SELECTOR).first().click({ force: true })
    this.page.expectUrl(this.sourceUrl)
    await this.page.waitForSelector(PHOTO_LINK_SELECTOR, { state: 'attached' })
    this.pageUrl = this.sourceUrl
  }

  private async waitForDetailImage(): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const loaded = await this.page.evaluate(() => {
        // @ts-ignore page context
        const pageDocument = document as {
          querySelectorAll(
            selector: string
          ): ArrayLike<{ complete: boolean; naturalWidth: number }>
        }
        return Array.from(
          pageDocument.querySelectorAll('[aria-label="Image"] img')
        ).some((node) => node.complete && node.naturalWidth > 0)
      })
      if (loaded) {
        return
      }
      await this.page.waitForTimeout(250)
    }
    throw new Error('Twitter image did not load within 10 seconds')
  }

  private async waitForPostTimestamp(statusId: string): Promise<void> {
    await this.page.waitForSelector(
      `article a[href*="/status/${statusId}"] time[datetime]`,
      { state: 'attached', timeout: 10_000 }
    )
  }

  private async getClickedPost(statusId: string): Promise<TwitterPost> {
    return this.page.evaluate((postStatusId) => {
      // @ts-ignore page context
      const pageDocument = document
      const text = pageDocument.querySelector('[data-testid="tweetText"]')
      const time = pageDocument.querySelector(
        `article a[href*="/status/${postStatusId}"] time[datetime]`
      )
      const images = Array.from<{
        querySelector(selector: string): {
          currentSrc?: string
          src?: string
          alt?: string
          style?: { backgroundImage?: string }
        } | null
      }>(pageDocument.querySelectorAll('[aria-label="Image"]')).reduce<
        Array<{ alt: string; imageUrl: string }>
      >((result, container) => {
        const image = container.querySelector('img')
        const backgroundImage = container.querySelector(
          '[style*="background-image"]'
        )?.style?.backgroundImage
        const backgroundImageUrl = backgroundImage?.match(
          /url\(["']?(.*?)["']?\)/
        )?.[1]
        const imageUrl = [image?.currentSrc, image?.src, backgroundImageUrl].find(
          (url) => url?.includes('pbs.twimg.com/media/')
        )
        if (imageUrl) {
          result.push({ alt: image?.alt || '', imageUrl })
        }
        return result
      }, [])
      return {
        textHtml: text?.innerHTML || '',
        timestamp: time?.getAttribute('datetime') || '',
        images
      }
    }, statusId)
  }

  private async savePostImages(
    post: TwitterPost,
    photo: TwitterPhoto,
    outputPath: string,
    timestamp: Date
  ): Promise<string[]> {
    const names: string[] = []
    for (const [index, image] of post.images.entries()) {
      const mediaId = image.imageUrl.split('/media/').at(-1)?.split('?')[0]
      if (!mediaId) continue
      const imageId = `${photo.statusId}-${mediaId}`
      const existing = this.checker(imageId)
      if (existing) {
        names.push(existing)
        continue
      }
      const imageUrl = originalImageUrl(image.imageUrl)
      const spinner = ora(`Saving ${imageUrl}`).start()
      try {
        const buffer = await linkToBuffer(
          this.page,
          imageUrl,
          createDownloadProgressReporter(spinner, 'Saving image')
        )
        const saved = await downloadFile(
          outputPath,
          `${imageId}-${index + 1}`,
          timestamp,
          [this.handle],
          buffer,
          this.resize
        )
        names.push(saved)
        spinner.succeed(`Saved ${imageUrl} to ${saved}`)
      } catch (error) {
        spinner.fail(`Failed to save ${imageUrl}: ${String(error)}`)
        throw error
      }
    }
    return names
  }

  private get handle(): string {
    return new URL(this.sourceUrl).pathname.split('/').filter(Boolean)[0] || 'twitter'
  }
}
