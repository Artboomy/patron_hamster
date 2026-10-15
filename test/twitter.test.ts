import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  pickTwitterMediaUrl,
  TwitterExtractor
} from '../src/extractor/twitter.js'

describe('pickTwitterMediaUrl', () => {
  it('uses a media background image when the image source is local', () => {
    expect(
      pickTwitterMediaUrl([
        'file:///archive/mock_handle-photo.jpg',
        'Photos%20by%20mock_handle_files/photo.jpg',
        'https://pbs.twimg.com/media/mock_media?format=jpg&name=small'
      ])
    ).toBe('https://pbs.twimg.com/media/mock_media?format=jpg&name=small')
  })
})

describe('TwitterExtractor updates', () => {
  it('skips a processed pinned post and saves newer media', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twitter-update-'))
    fs.writeFileSync(path.join(outputDir, 'pinned.md'), '')
    const page = {
      goto: vi.fn(async () => {}),
      waitForLoadState: vi.fn(async () => {}),
      locator: vi.fn(() => ({ count: vi.fn(async () => 1) })),
      evaluate: vi.fn(async () => {}),
      waitForTimeout: vi.fn(async () => {})
    }
    const extractor = new TwitterExtractor(page as never, {} as never, {
      outDir: outputDir,
      updateMode: true
    })
    const pinnedPhoto = {
      href: 'https://x.com/mock_handle/status/pinned/photo/1',
      imageUrl: 'https://pbs.twimg.com/media/pinned',
      statusId: 'pinned',
      photoNumber: '1',
      mediaId: 'pinned',
      isPinned: true
    }
    const freshPhoto = {
      href: 'https://x.com/mock_handle/status/fresh/photo/1',
      imageUrl: 'https://pbs.twimg.com/media/fresh',
      statusId: 'fresh',
      photoNumber: '1',
      mediaId: 'fresh',
      isPinned: false
    }
    const getPhotos = vi
      .fn()
      .mockResolvedValueOnce([pinnedPhoto, freshPhoto])
      .mockResolvedValue([])
    const openAndSavePost = vi.fn(async () => {})
    Reflect.set(extractor, 'getPhotos', getPhotos)
    Reflect.set(extractor, 'openAndSavePost', openAndSavePost)

    try {
      await extractor.extract('https://x.com/mock_handle/media?filter=photo')
      expect(openAndSavePost).toHaveBeenCalledOnce()
      expect(openAndSavePost).toHaveBeenCalledWith(freshPhoto, outputDir)
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true })
    }
  })
})

describe('TwitterExtractor login detection', () => {
  it('accepts an authenticated profile navigation control', async () => {
    const goto = vi.fn(async () => {})
    const page = {
      goto,
      waitForLoadState: vi.fn(async () => {}),
      waitForTimeout: vi.fn(async () => {}),
      locator: (selector: string) => ({
        count: async () =>
          selector.includes('AppTabBar_Profile_Link') ? 1 : 0
      })
    }
    const extractor = new TwitterExtractor(page as never, {} as never, {
      outDir: 'output/mock_handle',
      updateMode: false
    })

    await extractor.doLogin({
      targetUrl: 'https://x.com/mock_handle/media?filter=photo'
    })

    expect(goto).toHaveBeenCalledOnce()
    expect(page.waitForTimeout).not.toHaveBeenCalled()
  })
})

describe('TwitterExtractor post timestamp readiness', () => {
  it('waits for the clicked post timestamp rather than an arbitrary page time', async () => {
    const waitForSelector = vi.fn(async () => {})
    const extractor = new TwitterExtractor(
      { waitForSelector } as never,
      {} as never,
      { outDir: 'output/mock_handle', updateMode: false }
    )

    await (extractor as any).waitForPostTimestamp('2092424940159209896')

    expect(waitForSelector).toHaveBeenCalledWith(
      'article a[href*="/status/2092424940159209896"] time[datetime]',
      { state: 'attached', timeout: 10_000 }
    )
  })
})
