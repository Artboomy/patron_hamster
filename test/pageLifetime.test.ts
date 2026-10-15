import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BridgeContextShim } from '../src/bridgePageShim.js'
import type { BridgePageShim } from '../src/bridgePageShim.js'
import type * as Utils from '../src/utils.js'
import type { BridgeV2Runtime } from '../src/bridgeV2.js'
import { Extractor } from '../src/extractor.js'

vi.mock('../src/utils.js', async (importOriginal) => ({
  ...await importOriginal<typeof Utils>(),
  waitForDelay: async () => {},
  waitForEnter: async () => {},
  randomMouseMovements: async () => {}
}))

function createRuntime() {
  let nextTabId = 1
  let peakTabs = 0
  const tabs = new Set<number>()
  const runtime = {
    openTab: vi.fn(async () => {
      const tabId = nextTabId++
      tabs.add(tabId)
      peakTabs = Math.max(peakTabs, tabs.size)
      return { tabId }
    }),
    closeTab: vi.fn(async (tabId: number) => { tabs.delete(tabId) }),
    evaluate: vi.fn(async () => ['https://fixture.invalid/image.png'])
  }
  return {
    runtime,
    context: new BridgeContextShim(runtime as unknown as BridgeV2Runtime),
    tabs,
    peakTabs: () => peakTabs
  }
}

const directories: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

async function createFeed() {
  const state = createRuntime()
  const feedPage = await state.context.newPage()
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-lifetime-'))
  directories.push(outputDir)
  fs.writeFileSync(path.join(outputDir, 'visited.txt'), '')
  const extractor = new Extractor(feedPage, state.context, {
    outDir: outputDir,
    updateMode: false
  })
  vi.spyOn(extractor, 'setFilter').mockResolvedValue(undefined)
  vi.spyOn(extractor, 'randomScroll').mockResolvedValue(undefined)
  vi.spyOn(extractor, 'getPostUrls')
    .mockResolvedValueOnce(['https://fixture.invalid/posts/1'])
    .mockResolvedValueOnce(['https://fixture.invalid/posts/1', 'https://fixture.invalid/posts/2'])
    .mockResolvedValueOnce(['https://fixture.invalid/posts/1', 'https://fixture.invalid/posts/2', 'https://fixture.invalid/posts/3'])
  vi.spyOn(extractor, 'loadMore')
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false)
  const savePost = vi.spyOn(extractor, 'savePost').mockImplementation(async (_url, _dir, page) => page)
  vi.spyOn(extractor, 'pushVisited').mockImplementation((url) => { extractor.visited.add(url) })
  const closeStream = vi.fn()
  extractor.stream = { close: closeStream } as unknown as fs.WriteStream
  return { ...state, extractor, outputDir, savePost, closeStream }
}

describe('Feed page ownership', () => {
  it('reuses one post tab through multiple batches and closes it before returning', async () => {
    const state = await createFeed()
    try {
      await expect(state.extractor.extractAllPosts()).resolves.toBe(state.outputDir)
      expect(state.savePost).toHaveBeenCalledTimes(3)
      expect(new Set(state.savePost.mock.calls.map((call) => call[2])).size).toBe(1)
      expect(state.runtime.openTab).toHaveBeenCalledTimes(2)
      expect(state.peakTabs()).toBe(2)
      expect([...state.tabs]).toEqual([1])
      expect(state.closeStream).toHaveBeenCalledOnce()
      expect(state.extractor.stream).toBeUndefined()
    } finally {
      await state.context.close()
    }
    expect(state.tabs.size).toBe(0)
    expect(state.runtime.closeTab).toHaveBeenCalledTimes(2)
  })

  it.each(['savePost', 'loadMore', 'setFilter'] as const)('cleans up when %s fails', async (method) => {
    const state = await createFeed()
    const failure = new Error(`${method} failed`)
    vi.mocked(state.extractor[method]).mockReset().mockRejectedValue(failure)
    try {
      await expect(state.extractor.extractAllPosts()).rejects.toBe(failure)
      expect([...state.tabs]).toEqual([1])
      expect(state.closeStream).toHaveBeenCalledOnce()
      expect(state.extractor.stream).toBeUndefined()
    } finally {
      await state.context.close()
    }
    expect(state.tabs.size).toBe(0)
  })

  it('closes the stream even if closing the post tab fails', async () => {
    const state = await createFeed()
    const failure = new Error('tab close failed')
    state.runtime.closeTab.mockRejectedValueOnce(failure)
    await expect(state.extractor.extractAllPosts()).rejects.toBe(failure)
    expect(state.closeStream).toHaveBeenCalledOnce()
    expect(state.extractor.stream).toBeUndefined()
    await state.context.close()
    expect(state.tabs.size).toBe(0)
  })
})

describe('Bridge page cleanup', () => {
  it('drains response work before closing and shares concurrent close calls', async () => {
    const state = createRuntime()
    const page = await state.context.newPage()
    let finishResponse!: () => void
    const responseWork = new Promise<void>((resolve) => { finishResponse = resolve })
    page.on('response', () => responseWork)
    // Exercise the response dispatch used by bridge locator clicks.
    await (page as BridgePageShim).emitVisibleImageResponses()
    const first = page.close()
    const second = page.close()
    expect(state.runtime.closeTab).not.toHaveBeenCalled()
    finishResponse()
    await Promise.all([first, second])
    await page.close()
    await state.context.close()
    expect(state.runtime.closeTab).toHaveBeenCalledOnce()
    expect(state.tabs.size).toBe(0)
  })

  it('attempts every page, reports failures, and retains failed pages for retry', async () => {
    const state = createRuntime()
    await state.context.newPage()
    await state.context.newPage()
    await state.context.newPage()
    const failure = new Error('first tab failed')
    state.runtime.closeTab.mockRejectedValueOnce(failure)
    await expect(state.context.close()).rejects.toMatchObject({
      errors: [failure]
    })
    expect(state.runtime.closeTab.mock.calls.map(([tabId]) => tabId)).toEqual([1, 2, 3])
    expect([...state.tabs]).toEqual([1])
    await state.context.close()
    expect(state.runtime.closeTab.mock.calls.map(([tabId]) => tabId)).toEqual([1, 2, 3, 1])
    expect(state.tabs.size).toBe(0)
  })
})

describe('Chrome-profile login', () => {
  it('preserves an existing login flag without prompting or navigating', async () => {
    const state = await createFeed()
    vi.spyOn(state.extractor, 'getFlags').mockReturnValue({ patreon: true })
    const goto = vi.spyOn(state.extractor.page, 'goto').mockResolvedValue(undefined)
    const writeFlags = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {})
    try {
      await state.extractor.doLogin({ targetUrl: 'https://fixture.invalid/posts/1' })
      expect(goto).not.toHaveBeenCalled()
      expect(writeFlags).not.toHaveBeenCalled()
    } finally {
      await state.context.close()
    }
  })

  it('records a confirmed login and returns to the requested target', async () => {
    const state = await createFeed()
    vi.spyOn(state.extractor, 'getFlags').mockReturnValue({ substack: true })
    const goto = vi.spyOn(state.extractor.page, 'goto').mockResolvedValue(undefined)
    const writeFlags = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {})
    const targetUrl = 'https://fixture.invalid/posts/1'
    try {
      await state.extractor.doLogin({ targetUrl })
      expect(goto.mock.calls).toEqual([[targetUrl], [targetUrl]])
      expect(writeFlags).toHaveBeenCalledOnce()
      expect(writeFlags).toHaveBeenCalledWith(
        'flags.json',
        JSON.stringify({ substack: true, patreon: true }),
        'utf8'
      )
    } finally {
      await state.context.close()
    }
  })
})

describe('Bridge image blocking', () => {
  it.each([false, true])('restores image requests after saving (failure: %s)', async (fails) => {
    const state = await createFeed()
    const page = state.extractor.page
    const url = 'https://fixture.invalid/posts/1'
    vi.spyOn(page, 'url').mockReturnValue(url)
    const blocked = vi.spyOn(page, 'setImageRequestsBlocked').mockResolvedValue(undefined)
    const save = vi.spyOn(state.extractor, 'saveFullPost')
    const failure = new Error('save failed')
    if (fails) save.mockRejectedValue(failure)
    else save.mockResolvedValue(undefined)
    try {
      const result = Extractor.prototype.savePost.call(state.extractor, url, state.outputDir, page)
      if (fails) await expect(result).rejects.toBe(failure)
      else await expect(result).resolves.toBe(page)
      expect(blocked.mock.calls).toEqual([[true], [false]])
    } finally {
      await state.context.close()
    }
  })

  it('restores image requests even when enabling blocking fails', async () => {
    const state = await createFeed()
    const page = state.extractor.page
    const failure = new Error('blocking failed')
    const blocked = vi.spyOn(page, 'setImageRequestsBlocked')
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined)
    try {
      await expect(Extractor.prototype.savePost.call(
        state.extractor, 'https://fixture.invalid/posts/1', state.outputDir, page
      )).rejects.toBe(failure)
      expect(blocked.mock.calls).toEqual([[true], [false]])
    } finally {
      await state.context.close()
    }
  })
})
