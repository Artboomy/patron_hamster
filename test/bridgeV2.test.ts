import { describe, expect, it } from 'vitest'
import { BridgeV2Runtime, expectedUrlMatches } from '../src/bridgeV2.js'

describe('BridgeV2Runtime', () => {
  it.each(['c', 'cw'])(
    'accepts Patreon creator pages redirected to their canonical /%s path',
    async (prefix) => {
      const runtime = new BridgeV2Runtime()
      const expectedUrl = 'https://fixture.patreon.com/test-creator/posts'
      const canonicalUrl = `https://fixture.patreon.com/${prefix}/test-creator/posts`

      runtime.sendRequest = (async (action, payload) => {
        if (action === 'getUrl') {
          return { url: canonicalUrl }
        }
        if (
          action === 'evaluate' &&
          String(payload.expression).includes('readyState')
        ) {
          return { value: { href: canonicalUrl, readyState: 'complete' } }
        }
        if (action === 'evaluate') {
          return { value: 'page-ready' }
        }
        throw new Error(`Unexpected bridge action: ${action}`)
      }) as typeof runtime.sendRequest

      runtime.expectUrl(expectedUrl, 1)

      await expect(runtime.evaluate<string>('document.title', [], 1)).resolves.toBe(
        'page-ready'
      )
    }
  )

  it('does not treat non-Patreon domains as canonical Patreon URLs', () => {
    expect(
      expectedUrlMatches(
        'https://notpatreon.test/c/test-creator/posts',
        'https://notpatreon.test/test-creator/posts'
      )
    ).toBe(false)
  })

  it.each([
    [
      'https://fixture.patreon.com/cw/test-creator/posts?filters%5Bmonth%5D=2023',
      'https://fixture.patreon.com/c/test-creator/posts/',
      true
    ],
    [
      'https://fixture.patreon.com/test-creator/posts',
      'https://fixture.patreon.com/cw/test-creator/posts',
      true
    ],
    [
      'https://fixture.patreon.com/cw/other-test-creator/posts',
      'https://fixture.patreon.com/test-creator/posts',
      false
    ],
    [
      'https://fixture.patreon.com/cw/test-creator/membership',
      'https://fixture.patreon.com/test-creator/posts',
      false
    ],
    [
      'https://notpatreon.test/cw/test-creator/posts',
      'https://notpatreon.test/test-creator/posts',
      false
    ]
  ])('compares %s with %s as %s', (actual, expected, matches) => {
    expect(expectedUrlMatches(actual, expected)).toBe(matches)
  })
})
