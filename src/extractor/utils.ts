import { fileTypeFromBuffer } from 'file-type'
import fs from 'node:fs'
import fetch from 'node-fetch'
import path from 'path'
import { exiftool } from 'exiftool-vendored'
import { Page } from 'rebrowser-playwright'
import { imageExtensions } from '../constants.js'
import { waitForDelay } from '../utils.js'

const hasExtension = (str: string): boolean => {
  const parts = str.split('.')
  if (parts.length === 1) {
    return false
  }
  const last = parts.at(-1)
  return Boolean(last && imageExtensions.includes(last.toLowerCase()))
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
  const filePath = path.resolve(outputPath, fileName)
  await saveBufferToDisk({
    buffer: resultBuffer,
    filePath,
    timestamp,
    tags,
    isImage: mime.includes('image')
  })
  // console.log(`♥ Saved file ${fileName} to ${filePath}`)
  return fileName
}

export async function linkToBuffer(
  page: Page,
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
  isImage
}: {
  buffer: Buffer
  timestamp: Date | null
  filePath: string
  tags: string[]
  isImage: boolean
}) {
  fs.writeFileSync(filePath, buffer)
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

async function addMetadata(imagePath: string, tag: string[]) {
  await exiftool.write(
    imagePath,
    {
      Keywords: tag.join(', ')
    },
    ['-overwrite_original', '-charset', 'UTF8']
  )
}
