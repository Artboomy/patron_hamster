import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { generateGalleryHtml } from '../src/galleryHtml.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('generateGalleryHtml', () => {
  it('writes a descending Twitter-style feed with post metadata and local media', () => {
    const creatorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-'))
    const yearDir = path.join(creatorDir, '2026')
    tempDirs.push(creatorDir)
    fs.mkdirSync(yearDir)
    fs.writeFileSync(
      path.join(yearDir, 'older-10.md'),
      '# [Older post](https://example.com/older-10)\n\n*Date: 1 January 2026*\n'
    )
    fs.writeFileSync(
      path.join(yearDir, 'newer-20.md'),
      '# [Newer post](https://example.com/newer-20)\n\n*Date: 2 January 2026*\n\nPost text\n\n## Gallery\n![Preview](preview.jpg)\n![Second preview](second-preview.jpg)\n\n## Attachments\n[Video](20/video.mp4)\n'
    )
    fs.writeFileSync(
      path.join(yearDir, 'latest-30.md'),
      '# [February post](https://example.com/latest-30)\n\n*Date: 1 February 2026*\n'
    )
    fs.writeFileSync(
      path.join(yearDir, 'misleading-999.md'),
      '# [December post](https://example.com/december)\n\n*Date: 1 December 2025*\n'
    )

    const outputFile = generateGalleryHtml(yearDir)
    const html = fs.readFileSync(outputFile, 'utf8')

    expect(outputFile).toBe(path.join(yearDir, 'gallery.html'))
    expect(html).toContain('class="timeline"')
    expect(html).toContain('class="post"')
    expect(html.indexOf('Newer post')).toBeLessThan(html.indexOf('Older post'))
    expect(html.indexOf('Older post')).toBeLessThan(html.indexOf('December post'))
    expect(html).toContain('Post text')
    expect(html).toContain('src="preview.jpg"')
    expect(html).toContain('src="second-preview.jpg"')
    expect(html).toContain('flex-wrap: nowrap')
    expect(html).toContain('class="carousel"')
    expect(html).toContain('aria-label="Next image"')
    expect(html).toContain("event.key === 'ArrowRight'")
    expect(html).toContain('class="carousel-counter"')
    expect(html).toContain('class="carousel-copy-path"')
    expect(html).toContain('Copy image path')
    expect(html).toContain('class="feed-rotate"')
    expect(html).toContain('aria-label="Rotate feed 90 degrees"')
    expect(html).toContain("feedViewport.classList.toggle('is-rotated')")
    expect(html).toContain('href="20/video.mp4"')
    expect(html).toContain('photo-scrubber')
    expect(html).toContain('aria-label="Post months"')
    expect(html).toContain('January 2026')
    expect(html).toContain('February 2026')
    expect(html).toContain('id="month-2026-02"')
    expect(html).toContain('data-target="month-2026-01"')
    expect(html).toContain("scrollIntoView({ block: 'start' })")
    expect(html).toContain('data-date="2026-02-01"')
    expect(html).toContain('data-date="2025-12-01"')
  })
})
