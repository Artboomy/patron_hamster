import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import minimist from 'minimist'
import {
  discoverUpdateTargets,
  resolveLaunchArgs,
  resolveUpdateTargetChoices
} from '../src/index.js'

describe('resolveLaunchArgs', () => {
  it.each([
    [['--resize'], { width: 4000, height: 4000 }],
    [['--resize', '1600:900'], { width: 1600, height: 900 }],
    [['--resize=800:600'], { width: 800, height: 600 }]
  ])('parses PNG resize bounds from %j', (flags, bounds) => {
    expect(resolveLaunchArgs(minimist(['--update', ...flags])).resize).toEqual(bounds)
  })

  it('leaves resizing disabled when the flag is absent or negated', () => {
    expect(resolveLaunchArgs(minimist(['--update'])).resize).toBeUndefined()
    expect(resolveLaunchArgs(minimist(['--update', '--no-resize'])).resize).toBeUndefined()
  })

  it.each(['1.5:4000', '0:4000', '9007199254740992:4000', '4000'])(
    'rejects invalid resize bounds %s before launch',
    (bounds) => {
      expect(() => resolveLaunchArgs(minimist(['--update', '--resize', bounds]))).toThrow(/--resize/)
    }
  )

  it('rejects repeated resize values instead of choosing an ambiguous target', () => {
    expect(() => resolveLaunchArgs(minimist([
      '--update', '--resize', '800:600', '--resize', '400:300'
    ]))).toThrow(/--resize/)
  })

  it('builds the photo-media URL from a Twitter handle', () => {
    expect(resolveLaunchArgs({ twitter: '@mock_handle' })).toMatchObject({
      url: 'https://x.com/mock_handle/media?filter=photo',
      dir: 'output/mock_handle'
    })
  })

  it('defaults update mode to the current year when no year is supplied', () => {
    expect(
      resolveLaunchArgs({ twitter: '@mock_handle', update: true })
    ).toMatchObject({
      year: new Date().getFullYear()
    })
  })

  it('allows source-free update mode and defaults it to the current year', () => {
    expect(resolveLaunchArgs({ update: true })).toMatchObject({
      year: new Date().getFullYear()
    })
  })
  it('does not assign a year outside update mode', () => {
    expect(resolveLaunchArgs({ twitter: '@mock_handle' }).year).toBeUndefined()
  })

  it('enables poll filtering for Patreon creators', () => {
    expect(resolveLaunchArgs({ patreon: 'creator', poll: true })).toMatchObject({
      url: 'https://www.patreon.com/c/creator/posts',
      poll: true
    })
  })

  it('rejects poll filtering for unsupported sites', () => {
    expect(() =>
      resolveLaunchArgs({ twitter: 'mock_handle', poll: true })
    ).toThrow('The --poll option is only supported for Patreon')
  })
})

describe('source-free updates', () => {
  it('discovers update URLs from downloaded creator posts', () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-targets-'))
    try {
      const patreonDir = path.join(outputDir, 'patron')
      const substackDir = path.join(outputDir, 'writer')
      const fanboxDir = path.join(outputDir, 'artist')
      const twitterDir = path.join(outputDir, 'photographer', '2026')
      fs.mkdirSync(patreonDir)
      fs.mkdirSync(substackDir)
      fs.mkdirSync(fanboxDir)
      fs.mkdirSync(twitterDir, { recursive: true })
      fs.writeFileSync(
        path.join(patreonDir, 'visited.txt'),
        'https://www.patreon.com/c/patron/posts/a-post-123\n'
      )
      fs.writeFileSync(
        path.join(substackDir, 'visited.txt'),
        'https://writer.substack.com/p/a-post\n'
      )
      fs.writeFileSync(
        path.join(fanboxDir, 'visited.txt'),
        'https://artist.fanbox.cc/posts/123\n'
      )
      fs.writeFileSync(
        path.join(twitterDir, 'post.md'),
        '# [Post](https://x.com/photographer/status/123)\n'
      )

      expect(discoverUpdateTargets(outputDir)).toEqual([
        {
          name: 'artist',
          outDir: fanboxDir,
          site: 'pixivFanbox',
          url: 'https://artist.fanbox.cc/posts'
        },
        {
          name: 'patron',
          outDir: patreonDir,
          site: 'patreon',
          url: 'https://www.patreon.com/c/patron/posts'
        },
        {
          name: 'photographer',
          outDir: path.join(outputDir, 'photographer'),
          site: 'twitter',
          url: 'https://x.com/photographer/media?filter=photo'
        },
        {
          name: 'writer',
          outDir: substackDir,
          site: 'substack',
          url: 'https://writer.substack.com/archive'
        }
      ])
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true })
    }
  })

  it('resolves selected creators, all creators, or no selection', () => {
    const creators = [
      {
        name: 'first',
        outDir: 'output/first',
        site: 'twitter' as const,
        url: 'https://x.com/first/media?filter=photo'
      },
      {
        name: 'second',
        outDir: 'output/second',
        site: 'substack' as const,
        url: 'https://second.substack.com/archive'
      }
    ]
    expect(resolveUpdateTargetChoices([creators[1]], creators)).toEqual([
      creators[1]
    ])
    expect(resolveUpdateTargetChoices(['all'], creators)).toEqual(creators)
    expect(resolveUpdateTargetChoices(['exit'], creators)).toEqual([])
    expect(resolveUpdateTargetChoices([], creators)).toEqual([])
  })

})
