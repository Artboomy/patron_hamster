import { fileTypeFromBuffer } from 'file-type'
import fs from 'node:fs'
import fetch from 'node-fetch'
import path from 'path'
import { exiftool } from 'exiftool-vendored'
import type { Ora } from 'ora'
import type { DownloadProgress, ScraperPage } from './pageTypes.js'
import { imageExtensions } from '../constants.js'
import { normalizeFileName } from '../utils.js'
import type { ResizeBounds } from '../scripts/resizeImage.js'
import { resizePngInPlace } from '../scripts/resizeImage.js'

const BRIDGE_PORT = Number(process.env.BRIDGE_PORT || 17353)
const BRIDGE_HOST = process.env.BRIDGE_HOST || '127.0.0.1'
const BRIDGE_BASE_URL =
  process.env.BRIDGE_BASE_URL || `http://${BRIDGE_HOST}:${BRIDGE_PORT}`

function formatByteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KiB', 'MiB', 'GiB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length)
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 1 ? 0 : 1)} ${units[exponent - 1]}`
}

export function createDownloadProgressReporter(spinner: Ora, label: string): (progress: DownloadProgress) => void {
  spinner.spinner = { interval: 1_000, frames: [''] }
  return ({ downloadedBytes, totalBytes }) => {
    if (!totalBytes) {
      spinner.text = `${label} ${formatByteSize(downloadedBytes)} downloaded`
      return
    }

    const ratio = Math.min(downloadedBytes / totalBytes, 1)
    const width = 20
    const complete = Math.round(ratio * width)
    spinner.text = `${label} [${'#'.repeat(complete)}${'-'.repeat(width - complete)}] ${Math.round(
      ratio * 100
    )}% ${formatByteSize(downloadedBytes)} / ${formatByteSize(totalBytes)}`
  }
}

const hasExtension = (str: string): boolean => {
  const parts = str.split('.')
  if (parts.length === 1) {
    return false
  }
  const last = parts.at(-1)
  return Boolean(last && imageExtensions.includes(last.toLowerCase()))
}

export function resolveOutputFilePath(
  outputPath: string,
  fileName: string
): string {
  return path.resolve(outputPath, normalizeFileName(fileName))
}

export async function downloadFile(
  outputPath: string,
  name: string,
  timestamp: Date | null,
  tags: string[],
  buffer: Buffer<ArrayBufferLike>,
  resize?: ResizeBounds
) {
  const { ext, mime } = await fileTypeFromBuffer(buffer).then(
    (i) => i || { ext: 'file', mime: 'unknown' }
  )
  const fileName = hasExtension(name) ? name : `${name}.${ext}`
  const safeFileName = normalizeFileName(fileName)
  const filePath = resolveOutputFilePath(outputPath, safeFileName)
  await saveBufferToDisk({
    buffer,
    filePath,
    timestamp,
    tags,
    isImage: mime.includes('image'),
    mimeType: mime,
    resize
  })
  console.log(`♥ Saved file ${fileName} to ${filePath}`)
  return safeFileName
}

export async function linkToBuffer(
  page: ScraperPage,
  fileUrl: string,
  onProgress?: (progress: DownloadProgress) => void
): Promise<Buffer> {
  return page.fetchAsBuffer(fileUrl, onProgress)
}

export async function saveBufferToDisk({
  buffer,
  filePath,
  timestamp,
  tags,
  isImage,
  mimeType,
  resize
}: {
  buffer: Buffer
  timestamp: Date | null
  filePath: string
  tags: string[]
  isImage: boolean
  mimeType?: string
  resize?: ResizeBounds
}) {
  fs.writeFileSync(filePath, buffer)
  let savedBuffer = buffer
  if (resize && isImage && mimeType === 'image/png') {
    const result = await resizePngInPlace(filePath, resize)
    savedBuffer = fs.readFileSync(filePath)
    console.log(`Resized PNG ${path.basename(filePath)}: ${result.width}x${result.height}, ${result.inputBytes} -> ${result.outputBytes} bytes`)
  }
  if (isImage && (mimeType || '').startsWith('image/')) {
    void publishSavedImage(savedBuffer, mimeType as string, path.basename(filePath))
  }
  if (tags.length && isImage) {
    // console.log('✍ Writing tags')
    await addMetadata(filePath, tags)
  }
  if (timestamp) {
    try {
      // console.log('⌚ Setting file time to', filePath, timestamp)
      fs.utimesSync(filePath, timestamp, timestamp)
    } catch (e) {
      console.log('Failed to set file time', e)
    }
  }
}

async function publishSavedImage(
  buffer: Buffer,
  mimeType: string,
  fileName: string
): Promise<void> {
  try {
    await fetch(`${BRIDGE_BASE_URL}/v2/recent-images/saved`, {
      method: 'POST',
      headers: {
        'content-type': mimeType,
        'x-image-action': 'saved-to-output',
        'x-image-request-id': fileName
      },
      body: buffer
    })
  } catch {
    // Preview publishing is best-effort; the file is already saved.
  }
}

async function addMetadata(imagePath: string, tag: string[]) {
  await exiftool.write(
    imagePath,
    {
      Keywords: tag.join(', ')
    },
    ['-overwrite_original', '-charset', 'UTF8']
  )
}
