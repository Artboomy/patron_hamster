import fs from 'fs'
import path from 'path'
import minimist from 'minimist'
import open from 'open'

const args = minimist(process.argv.slice(2))
let markdownDir = args.dir
console.log('markdownDir', markdownDir)
if (!markdownDir) {
  console.error(`❌  No directory supplied`)
  process.exit(1)
}
markdownDir = path.resolve(markdownDir)
const tocFile = path.resolve(markdownDir, 'TOC.md')

interface MarkdownEntry {
  id: number
  title: string
  date: string
  fileName: string
  externalUrl: string
}

// Extracts ID from the title URL format: http://someurl/slug-id
function extractIdFromUrl(url: string): number {
  const match = url.match(/-(\d+)$/)
  return match ? parseInt(match[1], 10) : 0
}

// Extracts title, date, and external link from markdown content
function parseMarkdownContent(filePath: string): MarkdownEntry | null {
  const content = fs.readFileSync(filePath, 'utf8')
  const titleMatch = content.match(/^# \[(.+?)\]\((http.+?)\)/m)
  const dateMatch = content.match(/\*Date:\s*(.+?)\*/m)

  if (!titleMatch || !dateMatch) return null

  const [, title, url] = titleMatch
  const date = dateMatch[1].trim()
  const id = extractIdFromUrl(url)
  const fileName = path.basename(filePath)

  return { id, title, date, fileName, externalUrl: url }
}

// Ensure the directory exists
if (!fs.existsSync(markdownDir)) {
  console.error(`❌ Directory not found: ${markdownDir}`)
  process.exit(1)
}

const files = fs
  .readdirSync(markdownDir)
  .filter((file) => file.endsWith('.md') && file !== 'TOC.md') // Ignore TOC file
console.log(`Found ${files.length} files.`)

// Process all Markdown files
const markdownFiles = files
  .map((file) => parseMarkdownContent(path.join(markdownDir, file)))
  .filter((entry): entry is MarkdownEntry => entry !== null) // Remove null values
  .sort((a, b) => b.id - a.id) // Sort by ID descending

// Generate TOC Markdown
const tocMarkdown = markdownFiles
  .map(
    (entry) =>
      `*${entry.date}* - [${entry.title}](${entry.fileName}) [🔗](${entry.externalUrl})\n`
  )
  .join('\n')

// Save TOC.md file
fs.writeFileSync(tocFile, tocMarkdown, 'utf8')
console.log(`✅ TOC generated at: ${tocFile}`)

try {
  await open(tocFile)
} catch (e) {
  console.error('Failed to open file using default app: ', e)
}
