import epub, { Options, Chapter } from 'epub-gen-memory'
import fs from 'fs'
import path from 'path'
import { marked } from 'marked'
import ora from 'ora'
import * as cheerio from 'cheerio'

export async function generateEpub(dir: string) {
  // Get all Markdown files
  const markdownFiles = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.md') && file !== 'TOC.md')
    .sort((a, b) => {
      const aTime = fs.statSync(path.join(dir, a)).mtime
      const bTime = fs.statSync(path.join(dir, b)).mtime
      return bTime.getTime() - aTime.getTime() // Newer files first
    })
  const author = path.basename(dir)
  const options: Options = {
    title: `Substack archive of "${author}" posts`,
    author,
    publisher: 'Patron Hamster',
    date: new Date().toISOString(),
    fonts: [
      {
        filename: 'Spectral-Regular.ttf',
        url: 'file://' + path.resolve('fonts/Spectral-Regular.ttf')
      }
    ],
    css: `
@font-face {
  font-family: "Spectral";
  font-style: normal;
  font-weight: normal;
  src : url(./fonts/Spectral-Regular.ttf);
}
body {
  font-family: 'Spectral', 'Roboto', sans-serif;
  font-size: 19px;
  line-height: 1.6em;
  margin: 0; 
  padding: 0;
}
a { color: rgb(54, 55, 55); }
    `,
    version: 3,
    verbose: true
  }
  const reprocess: Set<string> = new Set()
  const urls: Array<{ url: string; title: string }> = markdownFiles.map(
    (fPath) => {
      const filePath = path.join(dir, fPath)
      const content = fs.readFileSync(filePath, 'utf8')
      const meta = JSON.parse(
        fs.readFileSync(filePath.replace(/.md$/, '.json'), 'utf8')
      )
      console.log('content[0]', content.split('\n')[0])
      return {
        url:
          content
            .split('\n')[0]
            ?.match(/\((.+)\)/)?.[1]
            .split('/p/')[1] || '',
        title: meta.title || ''
      }
    }
  )
  const chapters: Chapter[] = markdownFiles.map((fPath, chapterIdx) => {
    const filePath = path.join(dir, fPath)
    const content = fs.readFileSync(filePath, 'utf8')
    // read metadata
    const meta = JSON.parse(
      fs.readFileSync(filePath.replace(/.md$/, '.json'), 'utf8')
    )
    const htmlContent = marked.parse(content) as string
    const $ = cheerio.load(htmlContent)
    $('img').each((_, img) => {
      const src = $(img).attr('src')
      if (src?.startsWith('http')) {
        reprocess.add(fPath)
        $(img).attr('src', '')
      } else if (src) {
        $(img).attr('src', `file://${path.join(dir, src)}`)
      }
    })
    let sourceUrl = ''
    $('a').each((_, anchor) => {
      const href = $(anchor).attr('href')
      const text = $(anchor).text()
      const localName = href?.split('/p/')[1]?.split('?')[0]
      const idx = urls.findIndex((s) => s.url === localName)
      if (href && href.includes('substack') && idx > -1) {
        if (text === urls[idx].title) {
          $(anchor).remove()
          sourceUrl = href
        } else {
          const newHref = `${urls[idx].url}.xhtml`
          $(anchor).attr('href', newHref)
          console.log(`Patched ${href} to ${newHref}`)
        }
      } else {
        console.log(`Link ${href}`)
      }
    })

    return {
      title: meta.title,
      ...(sourceUrl && { url: sourceUrl }),
      content: $.html(),
      filename: urls[chapterIdx].url
    }
  })
  console.log('to reprocess: ', [...reprocess].join(', '))
  const spinner = ora('Generating epub').start()
  const book = await epub.default(options, chapters)
  spinner.succeed()
  const bookName = `${author}.epub`
  fs.writeFileSync(path.join(dir, bookName), book, 'utf8')
  console.log(`🎉 Saved book to ${bookName}.`)
}
