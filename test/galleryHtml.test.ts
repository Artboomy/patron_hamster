import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { JSDOM } from 'jsdom'
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
      '# [Older post](https://example.com/older-10)\n\n*Date: 1 January 2026*\n\n## Gallery\n![Older preview](older-preview.jpg)\n'
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
    const createGalleryDom = (bookmark?: string) =>
      new JSDOM(html, {
        beforeParse(window) {
          window.IntersectionObserver = class {
            observe() {}
          }
          window.HTMLElement.prototype.scrollIntoView = () => {}
          window.Range.prototype.getClientRects = () => []
          window.requestAnimationFrame = (callback) => {
            callback(Date.now())
            return 0
          }
          window.cancelAnimationFrame = () => {}
        },
        runScripts: 'dangerously',
        url: `file:///gallery.html${bookmark ? `#image=${encodeURIComponent(bookmark)}` : ''}`
      })

    const dom = createGalleryDom()
    const posts = [...dom.window.document.querySelectorAll('.post')]
    expect(posts.map((post) => post.textContent)).toEqual([
      expect.stringContaining('February post'),
      expect.stringContaining('Newer post'),
      expect.stringContaining('Older post'),
      expect.stringContaining('December post')
    ])
    expect(dom.window.document.querySelector('a[href="20/video.mp4"]')).not.toBeNull()
    expect(dom.window.document.querySelector('[photo-scrubber]')).not.toBeNull()
    const firstImage = dom.window.document.querySelector('img[src="preview.jpg"]')
    const carouselImage = dom.window.document.querySelector('.carousel-image')
    const nextButton = dom.window.document.querySelector('.carousel-next')
    const bookmarkButton = dom.window.document.querySelector('.carousel-bookmark')
    const zoomInButton = dom.window.document.querySelector('.carousel-zoom-in')

    firstImage?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    expect(carouselImage?.getAttribute('src')).toContain('preview.jpg')
    bookmarkButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    expect(dom.window.location.hash).toBe('#image=preview.jpg')
    expect(bookmarkButton?.textContent).toBe('Bookmarked')
    const initialTransform = carouselImage?.getAttribute('style')
    zoomInButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    expect(carouselImage?.getAttribute('style')).not.toBe(initialTransform)

    nextButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    expect(carouselImage?.getAttribute('src')).toContain('second-preview.jpg')
    expect(dom.window.location.hash).toBe('#image=second-preview.jpg')
    dom.window.close()

    const resumedDom = createGalleryDom('second-preview.jpg')
    expect(resumedDom.window.document.querySelector('.carousel')?.hasAttribute('hidden')).toBe(false)
    expect(
      resumedDom.window.document.querySelector('.carousel-image')?.getAttribute('src')
    ).toContain('second-preview.jpg')
    resumedDom.window.close()
  })
})
