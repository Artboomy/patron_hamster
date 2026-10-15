import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import * as cheerio from 'cheerio'
import { marked } from 'marked'

const require = createRequire(import.meta.url)
const panzoomScript = fs.readFileSync(require.resolve('@panzoom/panzoom'), 'utf8')

const escapeHtml = (value: string) =>
  value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }
    return entities[character]
  })

const monthNames = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]

const getPostDate = (markdown: string) => {
  const match = markdown.match(/^\*Date:\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\*$/m)
  if (!match) return null

  const [, dayText, monthName, yearText] = match
  const month = monthNames.indexOf(monthName)
  const day = Number(dayText)
  const year = Number(yearText)
  const timestamp = Date.UTC(year, month, day)
  const date = new Date(timestamp)
  if (
    month === -1 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day
  ) {
    return null
  }

  return {
    id: `${year}-${String(month + 1).padStart(2, '0')}`,
    label: `${monthName} ${year}`,
    timestamp,
    isoDate: date.toISOString().slice(0, 10)
  }
}

const getMonthTargetId = (monthId: string) => `month-${monthId}`

const feedStyles = `
  :root { color-scheme: dark; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #000; color: #e7e9ea; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #000; }
  a { color: inherit; }
  .timeline { width: 80vw; min-height: 100vh; margin: 0 auto; border-inline: 1px solid #2f3336; }
  .timeline-header { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 16px; border-bottom: 1px solid #2f3336; background: rgba(0, 0, 0, .85); backdrop-filter: blur(12px); }
  .timeline-header h1 { margin: 0; font-size: 20px; line-height: 24px; }
  .timeline-header p { margin: 2px 0 0; color: #71767b; font-size: 13px; }
  .feed-rotate { min-width: 44px; min-height: 44px; border: 0; border-radius: 50%; background: rgba(239, 243, 244, .12); color: #e7e9ea; cursor: pointer; font-size: 22px; }
  .feed-rotate[aria-pressed="true"] { background: #1d9bf0; color: #fff; }
  .feed-viewport.is-rotated { position: fixed; inset: 0; width: 100vh; height: 100vw; overflow: auto; transform: translateX(100vw) rotate(90deg); transform-origin: top left; }
  .feed-viewport.is-rotated .timeline { width: 80%; min-height: 100%; }
  [photo-scrubber] { position: fixed; top: 50%; right: 20px; z-index: 1; width: 116px; height: min(68vh, 640px); transform: translateY(-50%); }
  .scrubber-rail { position: absolute; top: 0; bottom: 0; left: 8px; width: 2px; border-radius: 1px; background: #536471; }
  .scrubber-month { position: absolute; top: var(--position); left: 0; transform: translateY(-50%); border: 0; border-radius: 999px; padding: 4px 8px 4px 20px; background: transparent; color: #71767b; cursor: pointer; font: 12px/16px inherit; text-align: left; white-space: nowrap; }
  .scrubber-month::before { position: absolute; top: 50%; left: 4px; width: 10px; height: 10px; border: 2px solid #536471; border-radius: 50%; background: #000; content: ""; transform: translateY(-50%); }
  .scrubber-month:hover, .scrubber-month:focus-visible, .scrubber-month[aria-current="true"] { color: #e7e9ea; outline: none; }
  .scrubber-month:hover::before, .scrubber-month:focus-visible::before, .scrubber-month[aria-current="true"]::before { border-color: #1d9bf0; background: #1d9bf0; }
  .post { display: grid; grid-template-columns: 48px minmax(0, 1fr); gap: 12px; padding: 12px 16px; border-bottom: 1px solid #2f3336; }
  .avatar { display: grid; place-items: center; width: 48px; height: 48px; border-radius: 50%; background: #1d9bf0; color: #fff; font-size: 20px; font-weight: 700; }
  .post-content { min-width: 0; font-size: 15px; line-height: 1.4; overflow-wrap: anywhere; }
  .post-content h1 { margin: 0; font-size: 15px; line-height: 20px; }
  .post-content h1 a { font-weight: 700; text-decoration: none; }
  .post-content h1 a:hover { text-decoration: underline; }
  .post-content h1 + p { margin: 0 0 12px; color: #71767b; font-size: 15px; }
  .post-content p { margin: 0 0 12px; }
  .post-content h2 { margin: 16px 0 8px; font-size: 15px; }
  .post-text { min-width: 0; margin: 0; padding: 0; border: 0; }
  .post-text legend { padding: 0; margin-bottom: 12px; }
  .post-text-toggle { border: 1px solid #2f3336; border-radius: 8px; padding: 6px 12px; background: transparent; color: #1d9bf0; cursor: pointer; font: inherit; }
  .post-text-toggle:focus-visible { outline: 2px solid #1d9bf0; outline-offset: 2px; }
  .post-content img { display: inline-block; max-width: 100%; max-height: 520px; border: 1px solid #2f3336; border-radius: 16px; cursor: zoom-in; object-fit: contain; vertical-align: top; }
  .post-content h2 + p:has(img) { display: flex; flex-wrap: nowrap; gap: 8px; overflow-x: auto; overscroll-behavior-inline: contain; padding-bottom: 4px; }
  .post-content h2 + p:has(img) img { flex: 0 0 min(70%, 640px); width: min(70%, 640px); max-height: 480px; }
  .post-content h2 + p:has(img) img:only-child { flex-basis: 100%; width: 100%; }
  .post-content a:not(h1 a) { color: #1d9bf0; }
  .post-content pre { overflow: auto; padding: 12px; border-radius: 12px; background: #16181c; }
  .post-content code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .carousel { position: fixed; inset: 0; z-index: 2; display: flex; align-items: center; justify-content: center; width: 100vw; height: 100vh; margin: 0; padding: 0; border: 0; background: rgba(0, 0, 0, .96); }
  .carousel[hidden] { display: none; }
  .carousel-image-viewport { position: absolute; inset: 0; display: grid; place-items: center; overflow: hidden; touch-action: none; }
  .carousel-image { display: block; width: 100vw; height: 100vh; max-width: 100vw; max-height: 100vh; cursor: grab; object-fit: contain; }
  .carousel-image:active { cursor: grabbing; }
  .carousel-header-toolbar { position: absolute; top: 16px; right: 16px; z-index: 1; display: flex; align-items: center; gap: 8px; }
  .carousel-header-toolbar .carousel-button { position: static; }
  .carousel-close { font-size: 36px; }
  .carousel-previous { left: 16px; }
  .carousel-next { right: 16px; }
  .carousel-toolbar-zone { position: absolute; bottom: 0; left: 0; z-index: 1; display: flex; align-items: flex-end; justify-content: center; width: 100%; height: 96px; padding-bottom: 16px; }
  .carousel-toolbar { display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 6px 12px; border-radius: 22px; background: rgba(22, 24, 28, .92); color: #e7e9ea; opacity: 0; transition: opacity 180ms ease 1s; }
  .carousel-counter { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .carousel-bookmark, .carousel-copy-path { min-height: 32px; border: 0; border-radius: 16px; padding: 0 12px; background: #1d9bf0; color: #fff; cursor: pointer; font: inherit; white-space: nowrap; }
  .carousel-toolbar-zone:hover .carousel-toolbar, .carousel-toolbar:focus-within { opacity: 1; transition-delay: 0s; }
  @media (max-width: 800px) { .timeline { width: 100%; border: 0; } .post { padding-inline: 12px; } [photo-scrubber] { display: none; } }
`

export function generateGalleryHtml(markdownDir: string): string {
  const resolvedDir = path.resolve(markdownDir)
  if (!fs.existsSync(resolvedDir)) {
    throw new Error(`Directory not found: ${resolvedDir}`)
  }

  const postEntries = fs
    .readdirSync(resolvedDir)
    .filter((file) => file.endsWith('.md') && file !== 'TOC.md')
    .map((file) => {
      const markdown = fs.readFileSync(path.join(resolvedDir, file), 'utf8')
      return { file, markdown, date: getPostDate(markdown) }
    })
    .sort(
      (left, right) =>
        (right.date?.timestamp ?? Number.NEGATIVE_INFINITY) -
          (left.date?.timestamp ?? Number.NEGATIVE_INFINITY) || right.file.localeCompare(left.file)
    )
  const seenMonths = new Set<string>()
  const months = postEntries.flatMap(({ date }) => {
    if (!date || seenMonths.has(date.id)) return []
    seenMonths.add(date.id)
    return [date]
  })
  const renderedMonths = new Set<string>()
  const posts = postEntries
    .map(({ markdown, date }) => {
      const monthTarget =
        date && !renderedMonths.has(date.id) ? ` id="${getMonthTargetId(date.id)}"` : ''
      if (date) renderedMonths.add(date.id)
      const $ = cheerio.load(marked.parse(markdown, { async: false }), null, false)
      $('img').attr('loading', 'lazy')
      return `<article class="post"${monthTarget}${date ? ` data-date="${date.isoDate}"` : ''}><div class="avatar" aria-hidden="true">PH</div><div class="post-content">${$.html()}</div></article>`
    })
    .join('\n')
  const scrubber =
    months.length === 0
      ? ''
      : `<nav photo-scrubber aria-label="Post months"><div class="scrubber-rail"></div>${months
          .map(
            (month, index) =>
              `<button class="scrubber-month" type="button" style="--position: ${(months.length === 1 ? 0.5 : index / (months.length - 1)) * 100}%" data-target="${getMonthTargetId(month.id)}">${escapeHtml(month.label)}</button>`
          )
          .join('')}</nav>`

  const creator = path.basename(path.dirname(resolvedDir))
  const escapedCreator = escapeHtml(creator)
  const outputFile = path.join(resolvedDir, 'gallery.html')
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>${escapedCreator} gallery</title>
  <style>${feedStyles}</style>
</head>
<body>
  <div class="feed-viewport">
    <main class="timeline">
      <header class="timeline-header"><div><h1>${escapedCreator}</h1><p>Downloaded posts</p></div><button class="feed-rotate" type="button" aria-label="Rotate feed 90 degrees" aria-pressed="false">↻</button></header>
      ${posts}
    </main>
  </div>
  ${scrubber}
  <div class="carousel" role="dialog" aria-modal="true" aria-label="Image carousel" hidden>
    <div class="carousel-header-toolbar">
      <button class="carousel-button carousel-close" type="button" aria-label="Close image carousel">×</button>
    </div>
    <button class="carousel-button carousel-previous" type="button" aria-label="Previous image or post">‹</button>
    <div class="carousel-image-viewport"><img class="carousel-image" alt=""></div>
    <button class="carousel-button carousel-next" type="button" aria-label="Next image or post">›</button>
    <div class="carousel-toolbar-zone">
      <div class="carousel-toolbar">
        <button class="carousel-button carousel-zoom-out" type="button" aria-label="Zoom out">−</button>
        <span class="carousel-counter" aria-live="polite"></span>
        <button class="carousel-button carousel-zoom-in" type="button" aria-label="Zoom in">+</button>
        <button class="carousel-bookmark" type="button">Bookmark image</button>
        <button class="carousel-copy-path" type="button">Copy image path</button>
    </div>
  </div>
  <script>${panzoomScript}</script>
  <script>
    const carousel = document.querySelector('.carousel')
    const carouselImage = document.querySelector('.carousel-image')
    const previousButton = document.querySelector('.carousel-previous')
    const nextButton = document.querySelector('.carousel-next')
    const closeButton = document.querySelector('.carousel-close')
    const counter = document.querySelector('.carousel-counter')
    const copyPathButton = document.querySelector('.carousel-copy-path')
    const bookmarkButton = document.querySelector('.carousel-bookmark')
    const rotateFeedButton = document.querySelector('.feed-rotate')
    const feedViewport = document.querySelector('.feed-viewport')
    let images = []
    let imageIndex = 0
    let postImages = []
    let postIndex = 0
    const zoomOutButton = document.querySelector('.carousel-zoom-out')
    const zoomInButton = document.querySelector('.carousel-zoom-in')
    const scrubber = document.querySelector('[photo-scrubber]')
    const scrubberButtons = [...document.querySelectorAll('.scrubber-month')]
    // Count rendered text rows, not characters or paragraph margins.
    const exceedsFiveRows = (body) => {
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
      const range = document.createRange()
      const rows = []
      const rotated = feedViewport.classList.contains('is-rotated')
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent.trim()) continue
        range.selectNodeContents(walker.currentNode)
        for (const rect of range.getClientRects()) {
          if (!rect.width || !rect.height) continue
          const top = rotated ? rect.left : rect.top
          const bottom = rotated ? rect.right : rect.bottom
          if (!rows.some((row) => top < row.bottom && bottom > row.top)) {
            rows.push({ top, bottom })
            if (rows.length > 5) return true
          }
        }
      }
      return false
    }
    const postTexts = []
    document.querySelectorAll('.post-content').forEach((post, index) => {
      const children = [...post.children]
      const date = children.find((child) => child.matches('p') && /^Date:/.test(child.textContent))
      const header = date || children.find((child) => child.matches('h1'))
      const nodes = []
      for (let node = header ? header.nextElementSibling : post.firstElementChild; node; node = node.nextElementSibling) {
        if (node.matches('h2') && /^(Gallery|Attachments|Tags)$/.test(node.textContent.trim())) break
        if (node.matches('img, video, audio') || node.querySelector('img, video, audio')) break
        nodes.push(node)
      }
      if (!nodes.length) return
      const fieldset = document.createElement('fieldset')
      fieldset.className = 'post-text'
      const legend = document.createElement('legend')
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'post-text-toggle'
      button.setAttribute('aria-expanded', 'false')
      const body = document.createElement('div')
      body.id = 'post-text-' + index
      button.setAttribute('aria-controls', body.id)
      legend.append(button)
      nodes[0].before(fieldset)
      body.append(...nodes)
      fieldset.append(legend, body)
      const render = (long) => {
        legend.hidden = !long
        body.hidden = long && button.getAttribute('aria-expanded') !== 'true'
        button.textContent = body.hidden ? 'Show post text' : 'Hide post text'
      }
      button.addEventListener('click', () => {
        button.setAttribute('aria-expanded', String(body.hidden))
        render(true)
      })
      postTexts.push(() => {
        body.hidden = false
        render(exceedsFiveRows(body))
      })
    })
    const updatePostTexts = () => postTexts.forEach((update) => update())
    updatePostTexts()
    let textResizeFrame
    window.addEventListener('resize', () => {
      cancelAnimationFrame(textResizeFrame)
      textResizeFrame = requestAnimationFrame(updatePostTexts)
    })
    document.fonts?.ready.then(updatePostTexts)
    const galleryBookmarkParam = 'image'
    const persistViewedImage = () => {
      const imageSource = images[imageIndex]?.getAttribute('src')
      if (!imageSource) return
      const bookmark = '#' + galleryBookmarkParam + '=' + encodeURIComponent(imageSource)
      try {
        history.replaceState(null, '', bookmark)
      } catch {
        location.hash = bookmark
      }
    }
    const bookmarkCurrentImage = () => {
      persistViewedImage()
      bookmarkButton.textContent = 'Bookmarked'
    }
    const resumeBookmarkedImage = () => {
      const imageSource = new URLSearchParams(location.hash.slice(1)).get(galleryBookmarkParam)
      if (!imageSource) return
      const image = [...document.querySelectorAll('.post-content img')].find(
        (candidate) => candidate.getAttribute('src') === imageSource
      )
      if (!image) return
      image.closest('.post')?.scrollIntoView({ block: 'center' })
      openCarousel(image)
    }
    const jumpToMonth = (button) => {
      document.getElementById(button.dataset.target)?.scrollIntoView({ block: 'start' })
    }
    const panzoom = Panzoom(carouselImage, { maxScale: 5, minScale: 1 })
    if (scrubber) {
      scrubber.addEventListener('click', (event) => {
        const button = event.target instanceof Element ? event.target.closest('.scrubber-month') : null
        if (button) {
          jumpToMonth(button)
          return
        }

        const bounds = scrubber.getBoundingClientRect()
        const ratio = Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height))
        jumpToMonth(scrubberButtons[Math.round(ratio * (scrubberButtons.length - 1))])
      })

      const targets = scrubberButtons.map((button) => document.getElementById(button.dataset.target))
      targets.filter(Boolean).forEach((target) => {
        new IntersectionObserver(
          (entries) => {
            const visible = entries.find((entry) => entry.isIntersecting)
            if (!visible) return
            scrubberButtons.forEach((button) => {
              button.setAttribute('aria-current', String(button.dataset.target === visible.target.id))
            })
          },
          { rootMargin: '-20% 0px -70% 0px' }
        ).observe(target)
      })
    }

    const renderImage = () => {
      const image = images[imageIndex]
      carouselImage.src = image.currentSrc || image.src
      carouselImage.alt = image.alt
      const hasMultipleImages = postImages.length > 1 || images.length > 1
      previousButton.hidden = !hasMultipleImages
      nextButton.hidden = !hasMultipleImages
      panzoom.reset({ animate: false })
      counter.textContent = String(imageIndex + 1) + ' / ' + images.length
      copyPathButton.textContent = 'Copy image path'
      persistViewedImage()
      bookmarkButton.textContent = 'Bookmark image'
    }

    const closeCarousel = () => {
      carousel.hidden = true
      document.body.style.overflow = ''
    }

    const getImagePath = () => {
      const url = new URL(carouselImage.src)
      let imagePath = decodeURIComponent(url.pathname)
      if (/^\\/[A-Za-z]:\\//.test(imagePath)) imagePath = imagePath.slice(1)
      return url.protocol === 'file:' ? imagePath : carouselImage.src
    }

    const copyImagePath = async () => {
      const imagePath = getImagePath()
      try {
        await navigator.clipboard.writeText(imagePath)
      } catch {
        const input = document.createElement('textarea')
        input.value = imagePath
        document.body.append(input)
        input.select()
        const copied = document.execCommand('copy')
        input.remove()
        if (!copied) {
          copyPathButton.textContent = 'Copy unavailable'
          return
        }
      }
      copyPathButton.textContent = 'Path copied'
    }

    const openCarousel = (image) => {
      postImages = [...document.querySelectorAll('.post')].map((post) => [...post.querySelectorAll('.post-content img')]).filter((post) => post.length > 0)
      postIndex = postImages.findIndex((post) => post.includes(image))
      images = postImages[postIndex]
      imageIndex = images.indexOf(image)
      carousel.hidden = false
      document.body.style.overflow = 'hidden'
      renderImage()
      closeButton.focus()
    }

    const showPostImage = (offset) => {
      imageIndex += offset
      if (imageIndex < 0) {
        postIndex = (postIndex - 1 + postImages.length) % postImages.length
        images = postImages[postIndex]
        imageIndex = images.length - 1
      } else if (imageIndex === images.length) {
        postIndex = (postIndex + 1) % postImages.length
        images = postImages[postIndex]
        imageIndex = 0
      }
      renderImage()
    }
    rotateFeedButton.addEventListener('click', () => {
      const rotated = feedViewport.classList.toggle('is-rotated')
      rotateFeedButton.setAttribute('aria-pressed', String(rotated))
      updatePostTexts()
    })

    document.addEventListener('click', (event) => {
      if (event.target instanceof HTMLImageElement && event.target.closest('.post-content')) {
        openCarousel(event.target)
      }
    })
    closeButton.addEventListener('click', closeCarousel)
    copyPathButton.addEventListener('click', copyImagePath)
    bookmarkButton.addEventListener('click', bookmarkCurrentImage)
    zoomOutButton.addEventListener('click', () => panzoom.zoomOut())
    zoomInButton.addEventListener('click', () => panzoom.zoomIn())
    previousButton.addEventListener('click', () => showPostImage(-1))
    nextButton.addEventListener('click', () => showPostImage(1))
    carousel.addEventListener('wheel', (event) => {
      if (carousel.hidden) return
      event.preventDefault()
      panzoom.zoomWithWheel(event)
    }, { passive: false })
    document.addEventListener('keydown', (event) => {
      if (carousel.hidden) return
      if (event.key === 'Escape') closeCarousel()
      if (event.key === 'ArrowLeft') previousButton.click()
      if (event.key === 'ArrowRight') nextButton.click()
    })
    resumeBookmarkedImage()
  </script>
</body>
</html>`

  fs.writeFileSync(outputFile, html, 'utf8')
  return outputFile
}
