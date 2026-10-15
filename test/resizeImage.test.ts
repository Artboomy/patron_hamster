import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'

const execute = promisify(execFile)
const script = fileURLToPath(new URL('../src/scripts/resizeImage.ts', import.meta.url))
// Synthetic two-frame, 2x2 PNG: red followed by blue.
const animatedPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAACAAAAAgAAAAAAAAAAAAEACgAA6FTcAAAAABVJREFUeJxj/M/A8J+BgYGBCUSAMAAfFwICAkezFAAAABpmY1RMAAAAAQAAAAIAAAACAAAAAAAAAAAAAQAKAABzJzbUAAAAGWZkQVQAAAACeJxjZGD4/5+BgYGBCUSAMAAdGQICRW6eVwAAAABJRU5ErkJggg==',
  'base64'
)

function resize(input: string, output: string, dimensions = ['--height', '2']) {
  return execute(process.execPath, ['--experimental-strip-types', script, input, output, ...dimensions])
}

describe('PNG resize CLI', () => {
  let directory: string
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'resize-png-test-'))
  })
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it.each([
    ['--width', '60', 60, 40],
    ['--height', '20', 30, 20]
  ] as const)('resizes by %s without cropping or changing aspect ratio', async (axis, size, width, height) => {
    const input = path.join(directory, 'landscape.png')
    const output = path.join(directory, 'resized.png')
    await sharp({ create: { width: 120, height: 80, channels: 4, background: '#ff000080' } })
      .png().toFile(input)
    await resize(input, output, [axis, size])
    expect(await sharp(output).metadata()).toMatchObject({ width, height, hasAlpha: true })
  })

  it.each([
    ['--width', '120'],
    ['--width', '160'],
    ['--height', '80'],
    ['--height', '100']
  ])('only recompresses when %s %s is at or above the input dimension', async (axis, size) => {
    const input = path.join(directory, 'pattern.png')
    const output = path.join(directory, 'compressed.png')
    const pixels = Buffer.alloc(120 * 80 * 4)
    for (let index = 0; index < pixels.length; index++) {
      pixels[index] = (index * 37) % 256
    }
    await sharp(pixels, { raw: { width: 120, height: 80, channels: 4 } })
      .png({ compressionLevel: 0 }).toFile(input)
    await resize(input, output, [axis, size])
    const decoded = await sharp(output).raw().toBuffer({ resolveWithObject: true })
    expect(decoded.info).toMatchObject({ width: 120, height: 80, channels: 4 })
    expect(decoded.data).toEqual(pixels)
    expect((await readFile(output)).length).toBeLessThan((await readFile(input)).length)
  })

  it('uses the oriented dimension when deciding whether to resize', async () => {
    const input = path.join(directory, 'rotated.png')
    const output = path.join(directory, 'compressed.png')
    await sharp({ create: { width: 60, height: 120, channels: 4, background: '#ff000080' } })
      .withMetadata({ orientation: 6 }).png().toFile(input)
    await resize(input, output, ['--height', '80'])
    const expected = await sharp(input).autoOrient().raw().toBuffer()
    const decoded = await sharp(output).raw().toBuffer({ resolveWithObject: true })
    expect(decoded.info).toMatchObject({ width: 120, height: 60 })
    expect(decoded.data).toEqual(expected)
  })

  it('rejects conflicting width and height instead of cropping', async () => {
    const input = path.join(directory, 'landscape.png')
    const output = path.join(directory, 'resized.png')
    await sharp({ create: { width: 120, height: 80, channels: 3, background: 'red' } })
      .png().toFile(input)
    await expect(resize(input, output, ['--width', '60', '--height', '20']))
      .rejects.toMatchObject({ code: 1 })
    await expect(access(output)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a JPEG disguised with a PNG extension without creating output', async () => {
    const input = path.join(directory, 'disguised.png')
    const output = path.join(directory, 'output.png')
    await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } })
      .jpeg().toFile(input)
    const original = await readFile(input)
    await expect(resize(input, output)).rejects.toMatchObject({ code: 1 })
    await expect(access(output)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(input)).toEqual(original)
  })

  it('rejects APNG rather than silently retaining only its first frame', async () => {
    const input = path.join(directory, 'animated.png')
    const output = path.join(directory, 'output.png')
    await writeFile(input, animatedPng)
    await expect(resize(input, output)).rejects.toMatchObject({ code: 1 })
    await expect(access(output)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(input)).toEqual(animatedPng)
  })

  it('preserves an existing destination when asked to overwrite it', async () => {
    const input = path.join(directory, 'input.png')
    const output = path.join(directory, 'existing.png')
    await sharp({ create: { width: 4, height: 4, channels: 4, background: '#ff000080' } })
      .png().toFile(input)
    const original = await readFile(input)
    await writeFile(output, original)
    await expect(resize(input, output)).rejects.toMatchObject({ code: 1 })
    expect(await readFile(output)).toEqual(original)
    expect(await readFile(input)).toEqual(original)
  })
})
