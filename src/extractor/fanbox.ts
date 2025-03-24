import { Extractor } from '../extractor.js'
import { Page } from 'rebrowser-playwright'
import { downloadFile, linkToBuffer } from './utils.js'
import ora from 'ora'

function parseFormattedDate(dateString: string) {
  // Remove the ordinal suffix (e.g., "13th" -> "13")
  const cleanDateString = dateString.replace(/(\d+)(st|nd|rd|th)/, '$1')

  // Parse using Date constructor
  return new Date(cleanDateString)
}

export class FanboxExtractor extends Extractor {
  site = 'pixivFanbox' as const
  selectors = {
    tags: '[class^="TagList__Wrapper"]',
    date: '[class^="styled__PostHeadBottom"]',
    contentTitle: '[class^="styled__PostTitle"]',
    contentBlock: '[class^="Body__PostBodyText"]',
    richContentBlock: '[class^="styled__EditorWrapper"]',
    imageAnchor: '[class^="PostImage__Anchor"]',
    postUrls:
      '[class^="CreatorPostItem__Wrapper"], [class^="CardPostItem__Wrapper"]',
    nextPage: '[class^="Pagination__SelectedItemWrapper"] + a',
    loader:
      '[class^="CreatorPostItem__DummyWrapper"], [class^="ProgressBar__StyledLoadingBar"]',
    locked: '[class^="FeeRequiredSign"]',
    attachments: '[class^="FileContent__DownloadLink"]'
  }
  beforeExtractCheck() {
    // pass
  }

  async setFilter() {
    // pass
  }

  async getTags(page: Page): Promise<string[]> {
    await this.cloudflareGuard(page, 'getTags', page)
    const text = page.locator(this.selectors.tags)
    if ((await text.count()) === 0) {
      return []
    }

    return (await text.innerText({ timeout: 300 })).split('\n')
  }

  async getPostDate(page: Page): Promise<Date> {
    await this.cloudflareGuard(page, 'getPostDate', page)
    const dateStr = await page.locator(this.selectors.date).innerText()
    if (!dateStr) {
      return new Date()
    }
    try {
      return parseFormattedDate(dateStr.split('・')[0])
    } catch (e) {
      console.warn(`Failed to parse date from ${dateStr}:`, e)
      return new Date()
    }
  }

  async getPostTitle(page: Page) {
    return await page.locator(this.selectors.contentTitle).innerText()
  }

  getContentBlock(page: Page) {
    return page.locator(
      `${this.selectors.contentBlock}, ${this.selectors.richContentBlock}`
    )
  }

  async getPageName(page: Page) {
    return await page.evaluate(
      () =>
        // @ts-ignore this is browser context
        location.pathname.split('/').at(-1) || ''
    )
  }

  async saveImageOnlyPost(cfg: {
    page: Page
    outDir: string
    timestamp: Date
    tags: string[]
  }): Promise<Record<string, string>> {
    const { page, outDir, timestamp, tags } = cfg
    const name = await this.getPageName(page)
    await this.cloudflareGuard(page, 'saveImageOnlyPost', cfg)
    const links: string[] = await page
      .locator(this.selectors.imageAnchor)
      .evaluateAll((elements) => elements.map((i) => i.href))
    const imageIdToName: Record<string, string> = {}
    const idUrlPairs: Array<[string, string]> = links
      .map((s) => [s.split('/').at(-1)?.split('.')[0], s])
      .filter(([id]) => !!id) as Array<[string, string]>
    for (const [imageId, url] of idUrlPairs) {
      const spinner = ora(`Saving ${url}`).start()
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
    return imageIdToName
  }

  getLoadMoreButton(page: Page) {
    return page.locator(this.selectors.nextPage).first()
  }

  getAttachmentName(href: string, filename: string) {
    return href.split('/').at(-1) || filename
  }
}
