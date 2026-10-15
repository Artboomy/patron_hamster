import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import minimist from 'minimist'
import sharp from 'sharp'
import { resolveLaunchArgs } from '../src/index.js'
import { downloadFile, linkToBuffer } from '../src/extractor/utils.js'
import { BridgeV2Runtime } from '../src/bridgeV2.js'
import { imageHook } from '../src/extractor.js'
import type { DownloadProgress, ScraperPage, ScraperResponse } from '../src/extractor/pageTypes.js'

const { served, server } = await vi.hoisted(async () => {
  // This fixture must bind its port before static imports read BRIDGE_BASE_URL.
  const http = await import('node:http')
  const served = new Map<string, Buffer>()
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    if (request.url === '/v2/recent-images/saved') {
      response.writeHead(204).end()
      return
    }
    if (request.url !== '/v2/binary/message') {
      response.writeHead(404).end()
      return
    }
    const message = JSON.parse(Buffer.concat(chunks).toString())
    const data = message.action === 'fetchBinary' && message.version === '1.0'
      ? served.get(message.payload.url)
      : undefined
    if (!data) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ requestId: message.requestId, ok: false, error: { code: 'FETCH_FAILED', message: 'Fixture file not found', retryable: false } }))
      return
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length })
    response.end(data)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture bridge address')
  // Never publish synthetic test images to a user's running bridge.
  vi.stubEnv('BRIDGE_BASE_URL', `http://127.0.0.1:${address.port}`)
  return { served, server }
})

const fixtureUrl = 'https://files.example/fixture.png'
const runtime = new BridgeV2Runtime()
const page = {
  fetchAsBuffer: (url: string, onProgress?: (progress: DownloadProgress) => void) =>
    runtime.fetchAsBuffer(url, undefined, onProgress)
} as ScraperPage
let directory: string

afterAll(async () => {
  await runtime.dispose()
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  vi.unstubAllEnvs()
})
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'download-resize-'))
})
afterEach(async () => {
  served.clear()
  await fs.rm(directory, { recursive: true, force: true })
})

describe('bridge downloads', () => {
  it('reports byte progress while downloading binary content', async () => {
    const bytes = Buffer.from([0, 255, 128, 1, 2, 3])
    served.set(fixtureUrl, bytes)
    const progress: DownloadProgress[] = []
    expect(await linkToBuffer(page, fixtureUrl, update => progress.push(update))).toEqual(bytes)
    expect(progress[0]).toEqual({ downloadedBytes: 0, totalBytes: bytes.length })
    expect(progress.at(-1)).toEqual({ downloadedBytes: bytes.length, totalBytes: bytes.length })
  })

  it('preserves bridge download errors', async () => {
    await expect(linkToBuffer(page, 'https://files.example/missing.png')).rejects.toMatchObject({
      name: 'BridgeActionError',
      action: 'fetchBinary',
      code: 'FETCH_FAILED',
      message: expect.stringContaining('Fixture file not found')
    })
  })
})

describe('PNG resizing after download', () => {
  it.each([
    [240, 80, 60, 20],
    [120, 240, 20, 40]
  ])('fits a %ix%i PNG within both requested dimensions', async (width, height, expectedWidth, expectedHeight) => {
    const bytes = await sharp({ create: { width, height, channels: 4, background: '#a0408080' } }).png().toBuffer()
    served.set(fixtureUrl, bytes)
    const options = resolveLaunchArgs(minimist(['--update', '--resize', '60:40']))
    const timestamp = new Date('2025-01-02T03:04:05Z')
    const filename = await downloadFile(directory, 'post-image', timestamp, [], await linkToBuffer(page, fixtureUrl), options.resize)
    expect(filename).toBe('post-image.png')
    const saved = path.join(directory, filename)
    expect(await sharp(saved).metadata()).toMatchObject({ width: expectedWidth, height: expectedHeight, hasAlpha: true })
    expect((await fs.stat(saved)).mtime.getTime()).toBe(timestamp.getTime())
    expect(await fs.readdir(directory)).toEqual([filename])
  })

  it('keeps original PNG bytes when resize is not enabled', async () => {
    const bytes = await sharp({ create: { width: 120, height: 80, channels: 4, background: 'red' } }).png({ compressionLevel: 0 }).toBuffer()
    served.set(fixtureUrl, bytes)
    const options = resolveLaunchArgs(minimist(['--update']))
    const filename = await downloadFile(directory, 'image', null, [], await linkToBuffer(page, fixtureUrl), options.resize)
    expect(await fs.readFile(path.join(directory, filename))).toEqual(bytes)
  })

  it('only recompresses a smaller PNG under the bare-flag default', async () => {
    const bytes = await sharp({ create: { width: 12, height: 8, channels: 4, background: '#20508080' } }).png().toBuffer()
    served.set(fixtureUrl, bytes)
    const options = resolveLaunchArgs(minimist(['--update', '--resize']))
    const filename = await downloadFile(directory, 'image', null, [], await linkToBuffer(page, fixtureUrl), options.resize)
    const saved = path.join(directory, filename)
    expect(await sharp(saved).metadata()).toMatchObject({ width: 12, height: 8 })
    expect(await sharp(saved).raw().toBuffer()).toEqual(await sharp(bytes).raw().toBuffer())
  })

  it('does not resize JPEG content even when its filename ends in png', async () => {
    const bytes = await sharp({ create: { width: 120, height: 80, channels: 3, background: 'blue' } }).jpeg().toBuffer()
    served.set(fixtureUrl, bytes)
    const filename = await downloadFile(directory, 'misnamed.png', null, [], await linkToBuffer(page, fixtureUrl), { width: 60, height: 40 })
    expect(await fs.readFile(path.join(directory, filename))).toEqual(bytes)
  })

  it('retains the downloaded bytes and removes temporary files if resizing fails', async () => {
    const valid = await sharp({ create: { width: 120, height: 80, channels: 4, background: 'red' } }).png().toBuffer()
    const truncated = valid.subarray(0, 60)
    served.set(fixtureUrl, truncated)
    await expect(downloadFile(directory, 'broken', null, [], await linkToBuffer(page, fixtureUrl), { width: 60, height: 40 })).rejects.toThrow()
    expect(await fs.readdir(directory)).toEqual(['broken.png'])
    expect(await fs.readFile(path.join(directory, 'broken.png'))).toEqual(truncated)
  })

  it('finishes resizing response-hook images before marking them saved', async () => {
    const bytes = await sharp({ create: { width: 120, height: 80, channels: 4, background: 'red' } }).png().toBuffer()
    let listener: ((response: ScraperResponse) => void | Promise<void>) | undefined
    const page = { on: (_event: string, callback: (response: ScraperResponse) => void | Promise<void>) => { listener = callback } } as unknown as ScraperPage
    const savedImages: Record<string, boolean> = {}
    const imageIdToName: Record<string, string> = {}
    imageHook({ page, savedImages, imageIdToName, checkDesiredImage: () => true, checkFileExists: () => null, getImageId: () => 'image', postName: 'post', outDir: directory, timestamp: new Date('2025-01-02T03:04:05Z'), tags: [], resize: { width: 60, height: 30 } })
    if (!listener) throw new Error('Image hook was not installed')
    await listener({ url: () => fixtureUrl, body: async () => bytes } as ScraperResponse)
    expect(savedImages.image).toBe(true)
    expect(imageIdToName.image).toBe('post-image.png')
    expect(await sharp(path.join(directory, 'post-image.png')).metadata()).toMatchObject({ width: 45, height: 30 })
  })
})
