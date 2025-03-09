import { BrowserContext } from 'rebrowser-playwright'
import fs from 'fs'

export const fileName = 'cookies.json'

export async function saveCookies(context: BrowserContext) {
  const cookies = await context.cookies()
  if (!cookies.length) {
    console.log('⚠️ Empty cookies, not saving')
    return
  }
  fs.writeFileSync(fileName, JSON.stringify(cookies))
  console.log('🌑 Cookies saved for future use')
}
