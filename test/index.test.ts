import { describe, expect, it } from 'vitest'
import { resolveLaunchArgs } from '../src/index.js'

describe('resolveLaunchArgs', () => {
  it('builds the photo-media URL from a Twitter handle', () => {
    expect(resolveLaunchArgs({ twitter: '@mock_handle' })).toMatchObject({
      url: 'https://x.com/mock_handle/media?filter=photo',
      dir: 'output/mock_handle'
    })
  })
})
