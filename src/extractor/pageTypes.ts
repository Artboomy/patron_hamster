export type WaitForSelectorState =
  | 'attached'
  | 'detached'
  | 'visible'
  | 'hidden'

export type DownloadProgress = {
  downloadedBytes: number
  totalBytes?: number
}

export interface ScraperDownload {
  saveAs(filePath: string): Promise<void>
}

export interface ScraperResponse {
  url(): string
  body(onProgress?: (progress: DownloadProgress) => void): Promise<Buffer>
}

export interface ScraperMouse {
  move(
    x: number,
    y: number,
    options?: {
      steps?: number
    }
  ): Promise<void>
}

export interface ScraperLocator {
  locator(
    selector: string,
    options?: {
      hasText?: string | RegExp
    }
  ): ScraperLocator
  first(): ScraperLocator
  nth(index: number): ScraperLocator
  count(): Promise<number>
  click(options?: { force?: boolean }): Promise<void>
  hover(): Promise<void>
  innerText(options?: { timeout?: number }): Promise<string>
  innerHTML(): Promise<string>
  getAttribute(name: string): Promise<string | null>
  evaluateAll<TResult>(
    pageFunction: (elements: unknown[]) => TResult
  ): Promise<TResult>
  scrollIntoViewIfNeeded(): Promise<void>
}

export interface ScraperPage {
  close(): Promise<void>
  locator(
    selector: string,
    options?: {
      hasText?: string | RegExp
    }
  ): ScraperLocator
  waitForSelector(
    selector: string,
    options?: {
      state?: WaitForSelectorState
      timeout?: number
    }
  ): Promise<void>
  goto(
    url: string,
    options?: {
      timeout?: number
    }
  ): Promise<void>
  url(): string
  evaluate<TResult>(
    pageFunction: ((arg?: unknown) => TResult) | string,
    arg?: unknown
  ): Promise<TResult>
  waitForLoadState(
    state?: 'domcontentloaded' | 'load' | 'networkidle'
  ): Promise<void>
  on(event: 'response', listener: (response: ScraperResponse) => void): void
  off(event: 'response', listener: (response: ScraperResponse) => void): void
  waitForEvent(event: 'download'): Promise<ScraperDownload>
  waitForTimeout(timeoutMs: number): Promise<void>
  fetchAsBuffer(url: string, onProgress?: (progress: DownloadProgress) => void): Promise<Buffer>
  setImageRequestsBlocked(blocked: boolean): Promise<void>
  mouse: ScraperMouse
  expectUrl(url: string): void
}

export interface ScraperContext {
  newPage(): Promise<ScraperPage>
  close(): Promise<void>
}
