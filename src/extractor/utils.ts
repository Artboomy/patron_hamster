import { fileTypeFromBuffer } from 'file-type'
import fs from 'node:fs'
import fetch from 'node-fetch'
import path from 'path'
import { exiftool } from 'exiftool-vendored'
import { Page } from 'rebrowser-playwright'
import { imageExtensions } from '../constants.js'

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

export async function linkToBuffer(page: Page, fileUrl: string) {
  // console.log(`Getting buffer from link ${fileUrl}`)
  return Buffer.from(
    await page.evaluate(async (url) => {
      //@ts-ignore page ctx
      const response = await fetch(url, { credentials: 'include' }) // Reuses cookies
      if (!response.ok)
        throw new Error(`🚨 Failed to fetch file: ${response.statusText}`)
      const blob = await response.blob()
      return Array.from(new Uint8Array(await blob.arrayBuffer())) // Convert to buffer
    }, fileUrl)
  )
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
