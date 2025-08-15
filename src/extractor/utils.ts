import { fileTypeFromBuffer } from 'file-type'
import fs from 'node:fs'
import fetch from 'node-fetch'
import path from 'path'
import { exiftool } from 'exiftool-vendored'
import type { ScraperPage } from './pageTypes.js'
import { imageExtensions } from '../constants.js'
import { waitForDelay } from '../utils.js'

const BRIDGE_PORT = Number(process.env.BRIDGE_PORT || 17353)
const BRIDGE_HOST = process.env.BRIDGE_HOST || '127.0.0.1'
const BRIDGE_BASE_URL =
  process.env.BRIDGE_BASE_URL || `http://${BRIDGE_HOST}:${BRIDGE_PORT}`

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
  return path.resolve(outputPath, path.basename(fileName))
}

export async function downloadFile(
  url: string,
  outputPath: string,
  name: string,
  timestamp: Date | null,
  tags: string[],
  buffer?: Buffer<ArrayBufferLike>
) {
  // console.log(`↓ Downloading file ${url}`)
  let resultBuffer = buffer
  if (!resultBuffer) {
    const response = await fetch(url, {})
    resultBuffer = Buffer.from(await response.arrayBuffer())
  }
  const { ext, mime } = await fileTypeFromBuffer(resultBuffer).then(
    (i) => i || { ext: 'file', mime: 'unknown' }
  )
  const fileName = hasExtension(name) ? name : `${name}.${ext}`
  const safeFileName = path.basename(fileName)
  const filePath = resolveOutputFilePath(outputPath, safeFileName)
  await saveBufferToDisk({
    buffer: resultBuffer,
    filePath,
    timestamp,
    tags,
    isImage: mime.includes('image'),
    mimeType: mime
  })
  console.log(`♥ Saved file ${fileName} to ${filePath}`)
  return safeFileName
}

export async function linkToBuffer(
  page: ScraperPage,
  fileUrl: string,
  maxRetries = 5
): Promise<Buffer> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const array = await page.evaluate(async (url) => {
        // @ts-ignore page context
        const response = await fetch(url, { credentials: 'include' })
        if (!response.ok) {
          throw new Error(
            `🚨 Failed to fetch file: ${response.status} ${response.statusText}`
          )
        }
        const blob = await response.blob()
        return Array.from(new Uint8Array(await blob.arrayBuffer()))
      }, fileUrl)

      return Buffer.from(array) // Success
    } catch (err) {
      if (attempt < maxRetries) {
        const delay = 500 + Math.floor(Math.random() * 200) // 500–700ms
        console.warn(`⚠️ Attempt ${attempt} failed. Retrying in ${delay}ms...`)
        await waitForDelay(delay)
      } else {
        console.error(`❌ All ${maxRetries} attempts failed for ${fileUrl}`)
        throw err // Re-throw the final error
      }
    }
  }

  throw new Error('Unexpected retry exit') // Just in case
}

export async function saveBufferToDisk({
  buffer,
  filePath,
  timestamp,
  tags,
  isImage,
  mimeType
}: {
  buffer: Buffer
  timestamp: Date | null
  filePath: string
  tags: string[]
  isImage: boolean
  mimeType?: string
}) {
  fs.writeFileSync(filePath, buffer)
  if (isImage && (mimeType || '').startsWith('image/')) {
    void publishSavedImage(buffer, mimeType as string, path.basename(filePath))
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
    // Local bridge may be unavailable in non-v2 runs; ignore.
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
