import { BridgeV2Runtime } from './bridgeV2.js'
import fs from 'node:fs'
import type {
  DownloadProgress,
  ScraperContext,
  ScraperDownload,
  ScraperLocator,
  ScraperMouse,
  ScraperPage,
  ScraperResponse,
  WaitForSelectorState
} from './extractor/pageTypes.js'

type LocatorStep = {
  selector: string
  hasText?: string
  hasTextRegexSource?: string
  hasTextRegexFlags?: string
}

type LocatorIndex = number | 'first' | null

function serializeHasText(
  hasText: string | RegExp | undefined
): Pick<LocatorStep, 'hasText' | 'hasTextRegexSource' | 'hasTextRegexFlags'> {
  if (typeof hasText === 'string') {
    return { hasText }
  }
  if (hasText instanceof RegExp) {
    return {
      hasTextRegexSource: hasText.source,
      hasTextRegexFlags: hasText.flags
    }
  }
  return {}
}

function parseSelector(selector: string): {
  selector: string
  hasText?: string
} {
  const match = selector.match(/:has-text\(\s*(["'])(.*?)\1\s*\)/)

  if (!match) {
    return { selector }
  }

  return {
    selector: selector.replace(match[0], ''),
    hasText: match[2]
  }
}

function locatorResolverExpression(): string {
  return `(() => {
    const [chain, indexMode] = args;
    const collectByXpath = (root, xpath) => {
      const out = [];
      const snapshot = document.evaluate(
        xpath,
        root,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null
      );
      for (let i = 0; i < snapshot.snapshotLength; i++) {
        const item = snapshot.snapshotItem(i);
        if (item && item.nodeType === Node.ELEMENT_NODE) out.push(item);
      }
      return out;
    };
    const applyTextFilter = (elements, step) => {
      if (step.hasText !== undefined) {
        return elements.filter((el) => (el.innerText || '').includes(step.hasText));
      }
      if (step.hasTextRegexSource) {
        const re = new RegExp(step.hasTextRegexSource, step.hasTextRegexFlags || '');
        return elements.filter((el) => re.test((el.innerText || '').trim()));
      }
      return elements;
    };
    let roots = [document];
    for (const step of chain) {
      const next = [];
      for (const root of roots) {
        let found = [];
        if (step.selector.startsWith('xpath=')) {
          found = collectByXpath(root, step.selector.slice(6));
        } else {
          found = Array.from(root.querySelectorAll(step.selector));
        }
        next.push(...applyTextFilter(found, step));
      }
      roots = next;
    }
    if (indexMode === 'first') {
      roots = roots.length ? [roots[0]] : [];
    } else if (typeof indexMode === 'number') {
      roots = roots[indexMode] ? [roots[indexMode]] : [];
    }
    return roots;
  })()`
}

class BridgeDownloadShim implements ScraperDownload {
  private readonly runtime: BridgeV2Runtime
  private readonly tabId: number
  private readonly href: string

  constructor(runtime: BridgeV2Runtime, tabId: number, href: string) {
    this.runtime = runtime
    this.tabId = tabId
    this.href = href
  }

  async saveAs(filePath: string): Promise<void> {
    const buffer = await this.runtime.fetchAsBuffer(this.href, this.tabId)
    fs.writeFileSync(filePath, buffer)
  }
}

class NoopMouse implements ScraperMouse {
  async move(
    _x: number,
    _y: number,
    _options?: { steps?: number }
  ): Promise<void> {
    return
  }
}

export class BridgeLocatorShim implements ScraperLocator {
  private readonly runtime: BridgeV2Runtime
  private readonly tabId: number
  private readonly page: BridgePageShim
  private readonly chain: LocatorStep[]
  private readonly indexMode: LocatorIndex

  constructor(cfg: {
    runtime: BridgeV2Runtime
    tabId: number
    page: BridgePageShim
    chain: LocatorStep[]
    indexMode?: LocatorIndex
  }) {
    this.runtime = cfg.runtime
    this.tabId = cfg.tabId
    this.page = cfg.page
    this.chain = cfg.chain
    this.indexMode = cfg.indexMode ?? null
  }

  locator(
    selector: string,
    options?: {
      hasText?: string | RegExp
    }
  ): ScraperLocator {
    const parsed = parseSelector(selector)

    const step: LocatorStep = {
      selector: parsed.selector,
      ...serializeHasText(options?.hasText ?? parsed.hasText)
    }
    return new BridgeLocatorShim({
      runtime: this.runtime,
      tabId: this.tabId,
      page: this.page,
      chain: [...this.chain, step],
      indexMode: null
    })
  }

  first(): ScraperLocator {
    return new BridgeLocatorShim({
      runtime: this.runtime,
      tabId: this.tabId,
      page: this.page,
      chain: this.chain,
      indexMode: 'first'
    })
  }

  nth(index: number): ScraperLocator {
    return new BridgeLocatorShim({
      runtime: this.runtime,
      tabId: this.tabId,
      page: this.page,
      chain: this.chain,
      indexMode: index
    })
  }

  private async resolveElements(): Promise<number> {
    return this.runtime.evaluate<number>(
      `(() => {
        const elements = ${locatorResolverExpression()};
        return elements.length;
      })()`,
      [this.chain, this.indexMode],
      this.tabId
    )
  }

  async count(): Promise<number> {
    return this.resolveElements()
  }

  async click(_options?: { force?: boolean }): Promise<void> {
    const clickResult = await this.runtime.evaluate<{
      clicked: boolean
      href: string | null
      imageSrc: string | null
    }>(
      `(() => {
        const elements = ${locatorResolverExpression()};
        const target = elements[0];
        if (!target) return { clicked: false, href: null, imageSrc: null };
        target.scrollIntoView({ block: 'center' });
        target.click();
        const href = target instanceof HTMLAnchorElement ? target.href : null;
        const imageSrc = target instanceof HTMLImageElement ? target.src : null;
        return { clicked: true, href, imageSrc };
      })()`,
      [this.chain, this.indexMode],
      this.tabId
    )
    if (!clickResult.clicked) {
      const currentUrl = await this.runtime
        .getUrl(this.tabId)
        .catch(() => 'unknown')
      const descriptor = this.chain
        .map((i) => {
          if (i.hasText !== undefined) {
            return `${i.selector} [hasText="${i.hasText}"]`
          }
          if (i.hasTextRegexSource) {
            return `${i.selector} [hasText=/${i.hasTextRegexSource}/${i.hasTextRegexFlags || ''}]`
          }
          return i.selector
        })
        .join(' -> ')
      throw new Error(
        `Locator click failed: element not found for ${descriptor}. tabId=${this.tabId} url=${currentUrl}`
      )
    }
    if (clickResult.href) {
      this.runtime.expectUrl(clickResult.href, this.tabId)
      this.page.emitDownload(clickResult.href)
    }
    await this.page.emitVisibleImageResponses()
  }

  async hover(): Promise<void> {
    await this.runtime.evaluate(
      `(() => {
        const elements = ${locatorResolverExpression()};
        const target = elements[0];
        if (!target) return false;
        const ev = new MouseEvent('mouseover', { bubbles: true, cancelable: true });
        target.dispatchEvent(ev);
        return true;
      })()`,
      [this.chain, this.indexMode],
      this.tabId
    )
  }

  async innerText(_options?: { timeout?: number }): Promise<string> {
    return this.runtime.evaluate<string>(
      `(() => {
        const elements = ${locatorResolverExpression()};
        const target = elements[0];
        return target ? (target.innerText || '') : '';
      })()`,
      [this.chain, this.indexMode],
      this.tabId
    )
  }

  async innerHTML(): Promise<string> {
    return this.runtime.evaluate<string>(
      `(() => {
        const elements = ${locatorResolverExpression()};
        const target = elements[0];
        return target ? (target.innerHTML || '') : '';
      })()`,
      [this.chain, this.indexMode],
      this.tabId
    )
  }

  async getAttribute(name: string): Promise<string | null> {
    return this.runtime.evaluate<string | null>(
      `(() => {
      const elements = ${locatorResolverExpression()};
      const target = elements[0];
      return target ? target.getAttribute(args[2]) : null;
    })()`,
      [this.chain, this.indexMode, name],
      this.tabId
    )
  }

  async evaluateAll<TResult>(
    pageFunction: (elements: unknown[]) => TResult
  ): Promise<TResult> {
    return this.runtime.evaluate<TResult>(
      `(() => {
        const elements = ${locatorResolverExpression()};
        const fn = ${pageFunction.toString()};
        return fn(elements);
      })()`,
      [this.chain, this.indexMode],
      this.tabId
    )
  }

  async scrollIntoViewIfNeeded(): Promise<void> {
    await this.runtime.evaluate(
      `(() => {
        const elements = ${locatorResolverExpression()};
        const target = elements[0];
        if (target) {
          target.scrollIntoView({ block: 'center' });
        }
      })()`,
      [this.chain, this.indexMode],
      this.tabId
    )
  }
}

export class BridgePageShim implements ScraperPage {
  private readonly runtime: BridgeV2Runtime
  private readonly tabId: number
  private currentUrl: string
  private readonly responseListeners = new Set<
    (response: ScraperResponse) => void
  >()
  private readonly pendingResponses = new Set<Promise<void>>()
  private readonly downloadWaiters: Array<(download: ScraperDownload) => void> =
    []
  private pendingDownload: ScraperDownload | null = null
  private closePromise: Promise<void> | null = null
  mouse: ScraperMouse = new NoopMouse()

  constructor(
    runtime: BridgeV2Runtime,
    tabId: number,
    initialUrl = 'about:blank'
  ) {
    this.runtime = runtime
    this.tabId = tabId
    this.currentUrl = initialUrl
  }

  locator(
    selector: string,
    options?: {
      hasText?: string | RegExp
    }
  ): ScraperLocator {
    const parsed = parseSelector(selector)

    const step: LocatorStep = {
      selector: parsed.selector,
      ...serializeHasText(options?.hasText ?? parsed.hasText)
    }
    return new BridgeLocatorShim({
      runtime: this.runtime,
      tabId: this.tabId,
      page: this,
      chain: [step]
    })
  }

  async waitForSelector(
    selector: string,
    options?: {
      state?: WaitForSelectorState
      timeout?: number
    }
  ): Promise<void> {
    await this.runtime.waitForSelector(
      selector,
      options?.state || 'attached',
      options?.timeout,
      this.tabId
    )
  }

  async goto(
    url: string,
    _options?: {
      timeout?: number
    }
  ): Promise<void> {
    await this.runtime.navigate(url, this.tabId)
    this.currentUrl = url
  }

  async setImageRequestsBlocked(blocked: boolean): Promise<void> {
    await this.runtime.setImageRequestsBlocked(blocked, this.tabId)
  }

  url(): string {
    return this.currentUrl
  }

  expectUrl(url: string): void {
    this.runtime.expectUrl(url, this.tabId)
    this.currentUrl = url
  }

  async evaluate<TResult>(
    pageFunction: ((arg?: unknown) => TResult) | string,
    arg?: unknown
  ): Promise<TResult> {
    const args = arg === undefined ? [] : [arg]
    const expression =
      typeof pageFunction === 'string'
        ? pageFunction
        : `(${pageFunction.toString()})(...args)`
    return this.runtime.evaluate<TResult>(expression, args, this.tabId)
  }

  async waitForLoadState(
    _state?: 'domcontentloaded' | 'load' | 'networkidle'
  ): Promise<void> {
    await this.runtime.sleep(200)
  }

  on(event: 'response', listener: (response: ScraperResponse) => void): void {
    if (event === 'response') {
      this.responseListeners.add(listener)
    }
  }

  off(event: 'response', listener: (response: ScraperResponse) => void): void {
    if (event === 'response') {
      this.responseListeners.delete(listener)
    }
  }

  async waitForEvent(event: 'download'): Promise<ScraperDownload> {
    if (event === 'download') {
      if (this.pendingDownload) {
        const value = this.pendingDownload
        this.pendingDownload = null
        return value
      }
      return new Promise<ScraperDownload>((resolve) => {
        this.downloadWaiters.push(resolve)
      })
    }
    throw new Error(`Unsupported waitForEvent: ${event}`)
  }

  async waitForTimeout(timeoutMs: number): Promise<void> {
    await this.runtime.sleep(timeoutMs)
  }

  async fetchAsBuffer(
    url: string,
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<Buffer> {
    return this.runtime.fetchAsBuffer(url, this.tabId, onProgress)
  }

  emitDownload(href: string): void {
    const download = new BridgeDownloadShim(this.runtime, this.tabId, href)
    const resolver = this.downloadWaiters.shift()
    if (resolver) {
      resolver(download)
      return
    }
    this.pendingDownload = download
  }

  async emitVisibleImageResponses(): Promise<void> {
    if (this.responseListeners.size === 0) {
      return
    }
    const urls = await this.runtime.evaluate<string[]>(
      `(() => Array.from(document.querySelectorAll('img'))
        .map((img) => img.src || '')
        .filter(Boolean))()`,
      [],
      this.tabId
    )
    for (const imageUrl of urls) {
      const response: ScraperResponse = {
        url: () => imageUrl,
        body: (onProgress) => this.runtime.fetchAsBuffer(imageUrl, this.tabId, onProgress)
      }
      for (const listener of this.responseListeners) {
        const pending = Promise.resolve(listener(response))
        this.pendingResponses.add(pending)
        void pending.then(
          () => this.pendingResponses.delete(pending),
          () => this.pendingResponses.delete(pending)
        )
      }
    }
  }

  async drainResponses(): Promise<void> {
    this.responseListeners.clear()
    await Promise.allSettled(this.pendingResponses)
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = (async () => {
        await this.drainResponses()
        await this.runtime.closeTab(this.tabId)
      })().catch((error) => {
        this.closePromise = null
        throw error
      })
    }
    return this.closePromise
  }
}

export class BridgeContextShim implements ScraperContext {
  private readonly runtime: BridgeV2Runtime
  private readonly pages: BridgePageShim[] = []

  constructor(runtime: BridgeV2Runtime) {
    this.runtime = runtime
  }

  async newPage(): Promise<ScraperPage> {
    const opened = await this.runtime.openTab('about:blank', true)
    const page = new BridgePageShim(this.runtime, opened.tabId)
    this.pages.push(page)
    return page
  }

  async close(): Promise<void> {
    const pages = [...this.pages]
    const results = await Promise.allSettled(pages.map((page) => page.close()))
    const errors: unknown[] = []
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        const pageIndex = this.pages.indexOf(pages[index])
        if (pageIndex !== -1) this.pages.splice(pageIndex, 1)
      } else {
        errors.push(result.reason)
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failed to close scraper pages')
    }
  }
}
