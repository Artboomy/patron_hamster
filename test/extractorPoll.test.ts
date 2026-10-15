import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { Extractor } from '../src/extractor.js'
import type { ScraperPage } from '../src/extractor/pageTypes.js'

describe('Extractor poll details', () => {
  it('extracts post-scoped choices and vote total without capturing filter radios', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extractor-poll-'))
    fs.writeFileSync(path.join(outputDir, 'visited.txt'), '')
    try {
      const fixturePath = path.resolve('test-fixtures/patreon/poll.html')
      const document = new JSDOM(
        fs.readFileSync(fixturePath, 'utf8')
      ).window.document
      const page = {
        locator: (selector: string) => ({
          evaluateAll: async (pageFunction: (elements: unknown[]) => unknown) =>
            pageFunction(Array.from(document.querySelectorAll(selector)))
        })
      } as unknown as ScraperPage
      const extractor = new Extractor(
        {} as ScraperPage,
        {} as never,
        { outDir: outputDir, updateMode: false, pollMode: true }
      )

      await expect(extractor.getPollDetails(page)).resolves.toEqual({
        choices: ['Seaside Umbrella', 'Feast'],
        votesTotal: '70 votes total'
      })
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true })
    }
  })
})
