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

    await extractor.doLogin([], {
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
