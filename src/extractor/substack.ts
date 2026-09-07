import { Extractor, imageHook } from '../extractor.js'
import type { ScraperPage } from './pageTypes.js'
import ora, { oraPromise } from 'ora'
import type { AttachmentRef } from '../utils.js'
import {
  humanLikeScrollToBottom,
  waitForDelay,
  waitForObjLen
} from '../utils.js'
import { createDownloadProgressReporter, downloadFile, linkToBuffer } from './utils.js'

export class SubstackExtractor extends Extractor {
  site = 'substack' as const

  selectors = {
    date: '.post-header',
    contentTitle: '.post-title',
    postUrls: '[data-testid="post-preview-title"]',
    subtitle: '.subtitle',
    contentBlock: '.available-content',
    loader: '[class^="loadingContainerList"]',
    imagesClickable: '.image-link.is-viewable-img',
    imageAnchor: '.image-link:not(.is-viewable-img)',
    bigImage: '[class^="imgContainer"] img',
    nextImageButton: '[class*="modalImageSidebar"]'
  }
  beforeExtractCheck(..._args: Parameters<Extractor['beforeExtractCheck']>) {
    // pass
  }

  isAllPostsUrl(): boolean {
    return this.sourceUrl.endsWith('/archive')
  }

  async setFilter() {
    // pass
  }

  async getTags(_page: ScraperPage): Promise<string[]> {
    return []
  }

  async getPostDate(page: ScraperPage): Promise<Date> {
    const str = await page.evaluate((selector) => {
      // @ts-ignore page ctx
      const el = document.querySelector(selector)
      return el.innerText
        .split('\n')
        .find((i: string) => i && i.match(/\w+\s\d+,\s\d+/))
    }, this.selectors.date)

    if (typeof str === 'string') {
      const date = new Date(str)
      if (!isNaN(date.getTime())) {
        return date
      }
    }
    return new Date()
  }
  getContentBlock(page: ScraperPage) {
    return page.locator(this.selectors.contentBlock)
  }

  async getPageName(page: ScraperPage): Promise<string> {
    return await page.evaluate(
      () =>
        // @ts-ignore this is browser context
        location.pathname.split('/').at(-1) || ''
    )
  }

  async saveImageOnlyPost(cfg: {
    page: ScraperPage
    outDir: string
    timestamp: Date
    tags: string[]
  }): Promise<Record<string, string>> {
    const { page, outDir, timestamp, tags } = cfg
    const name = await this.getPageName(page)
    await this.cloudflareGuard(page, 'saveImageOnlyPost', cfg)
    console.log(`| Post date: ${timestamp}`)
    const savedImages: Record<string, boolean> = {}
    const imageIdToName: Record<string, string> = {}
    const getImageId = (url: string) =>
      url.split('/').at(-1)?.split('%2F').at(-1)?.split('.')[0] as string
    const listener = imageHook({
      page,
      savedImages,
      imageIdToName,
      checkDesiredImage: (url: string) =>
        url.includes('f_auto,q_auto:good,fl_progressive:steep'),
      checkFileExists: (i: string) => this.checker(i),
      getImageId,
      postName: name,
      outDir,
      timestamp,
      tags
    })
    const imagesToClick = page.locator(this.selectors.imagesClickable)
    const imageCount = await imagesToClick.count()
    console.log(`Found ${imageCount} clickable images`)
    if (imageCount) {
      console.log(`↓ Downloading ${imageCount} multiple images`)
      await imagesToClick.nth(0).click({ force: true })
      // wait for initial carousel load
      await oraPromise(
        this.waitForBigImage(page),
        'Waiting for preview to open'
      )
      await page.locator(this.selectors.bigImage).hover()
      const nextButton = page
        .locator(this.selectors.nextImageButton)
        .first()
        .locator('button')
      const hasNextButton = (await nextButton.count()) > 0
      if (hasNextButton) {
        await this.iterateCarousel(imageCount, page, nextButton)
      } else {
        console.log('Only 1 image')
      }
    }
    const links: string[] = await page
      .locator(this.selectors.imageAnchor)
      .evaluateAll((elements) =>
        (elements as Array<{ href: string }>).map((i) => i.href)
      )
    const idUrlPairs: Array<[string, string]> = links.map((s) => [
      getImageId(s),
      s
    ])
    for (const [imageId, url] of idUrlPairs) {
      const spinner = ora(`Saving ${url}`).start()
      imageIdToName[imageId] = this.checker(imageId) || ''
      if (!imageIdToName[imageId]) {
        const img = await linkToBuffer(
          page,
          url,
          5,
          createDownloadProgressReporter(spinner, 'Saving image')
        )
        imageIdToName[imageId] = await downloadFile(
          url,
          outDir,
          `${name}-${imageId}`,
          timestamp,
          tags,
          img
        ).catch((e) => {
          spinner.fail(`Failed to save ${url}: ${String(e)}`)
          throw e
        })
        spinner.succeed(`Saved ${url} to ${imageIdToName[imageId]}`)
      } else {
        spinner.succeed(
          `Image ${url} already exists as ${imageIdToName[imageId]}`
        )
      }
    }

    await waitForDelay(Math.random() * 1000)
    await oraPromise(
      waitForObjLen(savedImages, imageCount),
      'Waiting for images to finish loading'
    )
    page.off('response', listener)
    return imageIdToName
  }

  async saveAttachments(_cfg: {
    page: ScraperPage
    outDir: string
    timestamp: Date
    postId: string
  }): Promise<AttachmentRef[]> {
    return []
  }

  async loadMore(page: ScraperPage): Promise<boolean> {
    console.log('Loading more pages')
    await oraPromise(
      humanLikeScrollToBottom(page),
      'Scrolling to load more posts'
    )
    const spinner = ora('Waiting for loader to appear').start()
    try {
      await page.waitForSelector(this.selectors.loader, {
        state: 'attached',
        timeout: 1000
      })
      spinner.succeed()
    } catch (_e) {
      spinner.succeed('No loader found.')
      return true
    }

    await oraPromise(
      page.waitForSelector(this.selectors.loader, {
        state: 'detached'
      }),
      'Waiting for loader to hide'
    )
    console.log('Loaded next page')
    return true
  }
}
