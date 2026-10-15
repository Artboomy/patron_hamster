import { chmod, open, rename, rm, stat, utimes } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { pipeline } from 'node:stream/promises'
import minimist from 'minimist'
import sharp, { type OutputInfo } from 'sharp'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export type ResizeBounds = { width: number; height: number }

const usage = 'Usage: yarn image:resize INPUT.png OUTPUT.png [--width PIXELS | --height PIXELS] [--no-adaptive-filtering]'

async function assertStaticPng(input: string): Promise<void> {
  const file = await open(input, 'r')
  const header = Buffer.alloc(8)
  try {
    await file.read(header, 0, 8, 0)
    if (!header.equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
      throw new Error('Only PNG inputs are supported; no output written')
    }
    // libpng can silently decode only the first APNG frame. acTL precedes IDAT.
    for (let offset = 8; ; offset += header.readUInt32BE(0) + 12) {
      const { bytesRead } = await file.read(header, 0, 8, offset)
      if (bytesRead !== 8) throw new Error('Truncated PNG chunk header')
      const type = header.toString('ascii', 4, 8)
      if (type === 'acTL') throw new Error('Animated PNG inputs are not supported')
      if (type === 'IDAT') return
      if (type === 'IEND') throw new Error('PNG contains no image data')
    }
  } finally {
    await file.close()
  }
}

export async function resizePng(
  input: string,
  output: string,
  dimensions: Partial<ResizeBounds>,
  adaptiveFiltering = true
) {
  const started = performance.now()
  const inputBytes = (await stat(input)).size
  await assertStaticPng(input)
  const image = sharp(input)
  const metadata = await image.metadata()
  image.autoOrient().keepMetadata()
  if (
    metadata.autoOrient.width > (dimensions.width ?? Infinity) ||
    metadata.autoOrient.height > (dimensions.height ?? Infinity)
  ) {
    image.resize({ ...dimensions, fit: 'inside', kernel: 'lanczos3' })
  }
  if (metadata.depth === 'ushort') {
    image.toColourspace('rgb16')
  }
  image.png({ compressionLevel: 7, adaptiveFiltering, palette: false })

  // Exclusive creation protects originals, existing outputs, and symlink targets.
  const file = await open(output, 'wx')
  let info: OutputInfo | undefined
  image.on('info', (value: OutputInfo) => { info = value })
  try {
    await pipeline(image, file.createWriteStream())
  } catch (error) {
    await file.close()
    await rm(output)
    throw error
  }
  const elapsedMs = performance.now() - started
  const outputBytes = (await stat(output)).size
  return {
    input,
    output,
    width: info?.width,
    height: info?.height,
    compressionLevel: 7,
    adaptiveFiltering,
    inputBytes,
    outputBytes,
    savedPercent: Number((100 * (1 - outputBytes / inputBytes)).toFixed(2)),
    elapsedMs: Number(elapsedMs.toFixed(2))
  }
}

export async function resizePngInPlace(input: string, bounds: ResizeBounds) {
  const original = await stat(input)
  const temporary = path.join(path.dirname(input), `.${path.basename(input)}.${randomUUID()}.resize.png`)
  try {
    const result = await resizePng(input, temporary, bounds)
    // stats scans all pixels: header-only checks cannot detect truncated image data.
    await sharp(temporary, { failOn: 'warning' }).stats()
    await chmod(temporary, original.mode & 0o7777)
    await utimes(temporary, original.atime, original.mtime)
    await rename(temporary, input)
    return { ...result, output: input }
  } finally {
    await rm(temporary, { force: true })
  }
}

async function main(): Promise<void> {
  const args = minimist(process.argv.slice(2), {
    string: ['width', 'height'],
    boolean: ['help', 'adaptive-filtering'],
    default: { 'adaptive-filtering': true }
  })
  if (args.help) {
    console.log(usage)
    return
  }
  if (args.width !== undefined && args.height !== undefined) {
    throw new Error('Specify either --width or --height, not both')
  }
  const size = Number(args.width ?? args.height ?? '4000')
  const dimensions = args.width !== undefined ? { width: size } : { height: size }
  if (args._.length !== 2 || !Number.isSafeInteger(size) || size <= 0) {
    throw new Error(usage)
  }
  const input = path.resolve(String(args._[0]))
  const output = path.resolve(String(args._[1]))
  if (path.extname(output).toLowerCase() !== '.png') {
    throw new Error('Output must have a .png extension')
  }
  const result = await resizePng(input, output, dimensions, args['adaptive-filtering'])
  console.log(JSON.stringify(result, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
