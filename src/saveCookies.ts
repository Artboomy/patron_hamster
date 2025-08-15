import fs from 'fs'
import type { ScraperContext } from './extractor/pageTypes.js'

export const fileName = 'cookies.json'

export async function saveCookies(context: ScraperContext) {
  const cookies = await context.cookies()
  if (!cookies.length) {
    console.log('⚠️ Empty cookies, not saving')
    return
  }
  fs.writeFileSync(fileName, JSON.stringify(cookies))
  console.log('🌑 Cookies saved for future use')
}
