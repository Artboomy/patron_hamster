import readline from 'node:readline'
import * as cheerio from 'cheerio'
import { Page } from 'rebrowser-playwright'
import fs from 'node:fs'
import path from 'path'

export function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    })
    rl.question('⌛ Press Enter to continue...\n', () => {
      rl.close()
      resolve()
    })
  })
}

export function waitForDelay(delay?: number): Promise<void> {
  const d = delay || Math.random() * 1000
  return new Promise((resolve) => {
    setTimeout(resolve, d)
  })
}

export async function waitForObjLen(
  obj: Record<string, boolean>,
  targetLength: number
): Promise<void> {
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      if (Object.keys(obj).length >= targetLength) {
        clearInterval(interval)
        resolve()
      }
    }, 300)
  })
}

export function parseDate(input: string): Date {
  const now = new Date()
  const lowerInput = input.toLowerCase().trim()

  // Case: "17 hours ago"
  const hoursAgoMatch = lowerInput.match(/^(\d+)\s*hours?\s*ago$/)
  if (hoursAgoMatch) {
    console.log('| Matched hours ago')
    const hours = parseInt(hoursAgoMatch[1], 10)
    return new Date(now.getTime() - hours * 60 * 60 * 1000)
  }

  // Case: "5 days ago"
  const daysAgoMatch = lowerInput.match(/^(\d+)\s*days?\s*ago$/)
  if (daysAgoMatch) {
    console.log('| Matched days ago')
    const days = parseInt(daysAgoMatch[1], 10)
    now.setDate(now.getDate() - days)
    return now
  }

  // Case: "February 26" (Assume current year)
  const monthDayMatch = lowerInput.match(/^([a-zA-Z]+)\s+(\d{1,2})$/)
  if (monthDayMatch) {
    console.log('| Matched month + day')
    const [_, month, day] = monthDayMatch
    return new Date(`${month} ${day}, ${now.getFullYear()}`)
  }

  // Case: "Apr 27, 2018" (Direct date parsing)
  const date = new Date(input)
  if (!isNaN(date.getTime())) {
    return date
  }

  // Default case: return current date
  return now
}

export function patchLinks({
  html,
  imageMap,
  site,
  attachments
}: {
  html: string
  imageMap: Record<string, string>
  site: 'patreon' | 'pixivFanbox' | 'substack'
  attachments: string[]
}): string {
  const $ = cheerio.load(html) // Load HTML into Cheerio
  if (site === 'substack') {
    // remove garbage blocks
    $('.subscription-widget-wrap').remove()
    // clean up headers
    $('h2.header-anchor-post').each((_, el) => {
      const text = $(el).text() // Get the full visible text (ignores HTML tags)
      $(el).html(text) // Replace inner HTML with plain text
    })
    // prevent list conversion
    $('p span').each((_, el) => {
      const text = $(el).text()
      if (/^\d+\.$/.test(text.trim())) {
        $(el).text(`\u200B${text}`) // Add a non-breaking space
      }
    })
  }
  if (site === 'pixivFanbox') {
    // videos will be extracted from attachments later
    $('video').remove()
  }

  if (site === 'substack' || site === 'pixivFanbox') {
    // hoisting (for Pixiv)
    $('img').each((_, img) => {
      let src = $(img).attr('src')
      let parent = $(img).parent()
      while (parent.length && parent[0].tagName !== 'a') {
        parent = parent.parent()
      }

      // If an <a> tag is found, replace <a> with <img>
      if (parent.length && parent.attr('href')) {
        src = parent.attr('href') // Use <a> href as image src
        $(img).attr('src', src)

        // Hoisting: Replace <a> with <img>
        parent.replaceWith($.html(img))
      }
    })

    // video embedding
    $('a').each((_, anchor) => {
      const href = $(anchor).attr('href')
      const isDownload = $(anchor).attr('download')
      if (!href || !isDownload) {
        return
      }
      const replacement = attachments.find((attachment) =>
        href.includes(attachment)
      )
      if (replacement) {
        if (href.endsWith('.mp4')) {
          // Create <video> and <source> elements
          const videoTag = $('<video controls=""></video>')
          const sourceTag = $('<source type="video/mp4">').attr(
            'src',
            replacement
          )
          videoTag.append(sourceTag)
          $(anchor).replaceWith(videoTag)
          console.log('Embedded video')
        } else {
          // replace with img
          const imgTag = $('<img alt="Attachment"/>').attr('src', replacement)
          $(anchor).replaceWith(imgTag)
          console.log('Embedded image')
        }
      }
    })
  }
  // src replacer (for all)
  $('img').each((_, img) => {
    const src = $(img).attr('src')

    // If a valid src is found, replace it using imageMap
    if (src) {
      for (const imageId in imageMap) {
        if (src.includes(imageId)) {
          $(img).attr('src', imageMap[imageId]) // Replace with new URL
          delete imageMap[imageId] // Remove from map to avoid re-processing
          break // Exit loop once matched
        }
      }
    }
  })

  return $.html() // Return modified HTML
}

/**
 * Moves the mouse around randomly within the current viewport.
 *
 * @param page Playwright Page instance.
 * @param moveCount How many random moves to perform (default 5).
 */
export async function randomMouseMovements(page: Page, moveCount = 5) {
  // Get the viewport dimensions so we can choose random positions    // Get viewport size using page.evaluate()
  const viewport = await page.evaluate(() => {
    //@ts-ignore page ctx
    return { width: window.innerWidth, height: window.innerHeight }
  })

  if (!viewport || viewport.width === 0 || viewport.height === 0) {
    console.warn(
      'No valid viewport size found. Skipping random mouse movements.'
    )
    return
  }

  const { width, height } = viewport

  for (let i = 0; i < moveCount; i++) {
    // Random (x, y) within the viewport
    const x = Math.floor(Math.random() * width)
    const y = Math.floor(Math.random() * height)

    // Move in multiple steps to simulate smoother movement
    const steps = 15 + Math.floor(Math.random() * 10) // random steps between 15-25

    await page.mouse.move(x, y, { steps })

    // Short random delay before the next move
    const pause = 200 + Math.floor(Math.random() * 300) // 200-500 ms
    await page.waitForTimeout(pause)
  }
}

export function getFileChecker(directory: string) {
  const files = fs.readdirSync(directory).map((file) => path.basename(file))
  return (id: string) => {
    return files.find((file) => file.includes(id)) || null
  }
}

export async function humanLikeScrollToBottom(page: Page) {
  await page.evaluate(async () => {
    const delay = (ms: number) => new Promise((res) => setTimeout(res, ms))

    let totalHeight = 0
    const distance = 100 + Math.random() * 50 // variable step size

    // @ts-ignore page ctx
    while (totalHeight < document.body.scrollHeight) {
      // @ts-ignore page ctx
      window.scrollBy(0, distance)
      totalHeight += distance

      const sleepTime = 100 + Math.random() * 200 // variable delay
      await delay(sleepTime)
    }
  })
}
