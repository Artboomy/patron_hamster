import minimist from 'minimist'
import open from 'open'
import { generateGalleryHtml } from './galleryHtml.js'

const args = minimist(process.argv.slice(2))
const markdownDir = args.dir

if (typeof markdownDir !== 'string' || !markdownDir.trim()) {
  console.error('Provide a directory with --dir')
  process.exit(1)
}

const outputHtmlFile = generateGalleryHtml(markdownDir)
console.log(`Gallery generated: ${outputHtmlFile}`)

try {
  await open(outputHtmlFile)
} catch (error) {
  console.error('Failed to open gallery using the default app:', error)
}
