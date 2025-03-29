import minimist from 'minimist'
import fs from 'fs'
import { generateEpub } from '../generateEpub.js'

const args = minimist(process.argv.slice(2))
const markdownDir = args.dir
if (!markdownDir) {
  console.error('❌  Provide full path in --dir argument')
  process.exit(1)
}

// Ensure directory exists
if (!fs.existsSync(markdownDir)) {
  console.error(`❌  Directory not found: ${markdownDir}`)
  process.exit(1)
}

generateEpub(markdownDir)
