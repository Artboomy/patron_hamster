import fs from 'fs'
import path from 'path'
import minimist from 'minimist'
import { fileURLToPath } from 'url'
import { marked, Tokens } from 'marked'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Read the Marked.js minified source
const markedJsPath = path.resolve(
  __dirname,
  '../node_modules/marked/marked.min.js'
)
const markedJsContent = fs.readFileSync(markedJsPath, 'utf8')

import open from 'open'

const args = minimist(process.argv.slice(2))
const markdownDir = args.dir
if (!markdownDir) {
  console.error('❌  Provide full path in --dir argument')
  process.exit(1)
}
const outputHtmlFile = path.join(markdownDir, 'gallery.html')

// Ensure directory exists
if (!fs.existsSync(markdownDir)) {
  console.error(`❌  Directory not found: ${markdownDir}`)
  process.exit(1)
}

const getId = (fileName: string) => {
  return Number(fileName.split('.')[0].split('-').at(-1))
}

// Get all Markdown files
const markdownFiles = fs
  .readdirSync(markdownDir)
  .filter((file) => file.endsWith('.md') && file !== 'TOC.md')
  .sort((a, b) => getId(b) - getId(a))
marked.use({
  renderer: {
    image({ href, text }: Tokens.Image): string {
      return `<img class="preview-img" src="${href}" alt=${text} />`
    },
    heading(cfg: Tokens.Heading) {
      const { tokens } = cfg
      const text = this.parser.parseInline(tokens)
      if (text === 'Tags') {
        return ''
      }
      if (text === 'Gallery') {
        return '<h2 style="display:none">Gallery</h2>'
      }
      return false
    }
  }
})
// Generate gallery items with full Markdown content
const galleryItems = markdownFiles
  .map((file, index) => {
    const filePath = path.join(markdownDir, file)
    const content = fs.readFileSync(filePath, 'utf8')
    // Convert full Markdown to HTML using Marked
    const renderedContent = marked.parse(content)

    return `
        <div class="gallery-item" onclick="openMarkdown(${index})">
            <div class="content">${renderedContent}</div>
        </div>
        <div id="markdown-content-${index}" style="display: none;">${renderedContent}</div>
    `
  })
  .join('')

// Full HTML template with embedded Marked library
const htmlTemplate = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Markdown Gallery</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 4px; background-color: #f9f9f9 }
        .gallery { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 10px; }
        .gallery-item {
            cursor: pointer; 
            padding: 10px 0 10px 10px;
            text-align: center; 
            transition: 0.3s; 
            background: #f9f9f9;
            overflow: hidden;
            max-height: 48vh;
            min-height: 150px;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            /* From https://css.glass */
            background: rgba(255, 255, 255, 0.2);
            border-radius: 16px;
            box-shadow: 0 4px 30px rgba(0, 0, 0, 0.1);
            backdrop-filter: blur(5px);
            -webkit-backdrop-filter: blur(5px);
            border: 1px solid rgba(255, 255, 255, 0.3);
        }
        .gallery-item:hover { background: #e0e0e0; }
        .title { font-weight: bold; margin-bottom: 10px; }
        .content { 
          font-size: 14px;
          color: #444; 
          overflow: hidden;
          overflow-y: auto;
          scrollbar-gutter: stable;
          display: flex; 
          flex-direction: column; 
        }
        /*p {margin: 0}*/
        h1 {
          font-size: 20px;
          margin: 0 0 4px;
        }
        h2 {
          margin: 0;
          padding: 4px;
        }
        h2 + p { 
          min-height: 36px;
          display: flex;
          overflow-x: auto; 
        }
        .preview-img { height: 100%; max-height: 400px }
        code {
          padding: 4px;
          border-radius: 4px;
          margin: 4px;
          background-color: #eaeaea;
          border: 1px solid #ccc;
        }
    </style>
</head>
<body>
    <div class="gallery">
        ${galleryItems}
    </div>

    <!-- Embedded Marked.js library -->
    <script>
        ${markedJsContent}

        function openMarkdown(index) {
            const markdownHtml = document.getElementById('markdown-content-' + index).innerHTML
            
            const newTab = window.open()
            newTab.document.write(\`
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Markdown Preview</title>
                    <style>
                        body { font-family: Arial, sans-serif; margin: 20px; }
                    </style>
                    <style>
                      body {
                        font-family: Arial, sans-serif;
                        margin: 0; 
                        padding: 0;
                      }
              
                      /* Centered content area with max width */
                      .container {
                        max-width: 800px;
                        margin: 0 auto; 
                        padding: 20px;
                      }
              
                      /* Make images responsive, and cursor pointer to hint they are clickable */
                      .container img {
                        max-width: 100%;
                        height: auto;
                        cursor: pointer;
                      }
              
                      /* Full-screen overlay for image modal */
                      .modal {
                        display: none;             /* Hidden by default */
                        position: fixed;           /* Stay in place */
                        z-index: 9999;             /* Sit on top */
                        left: 0;
                        top: 0;
                        width: 100%; 
                        height: 100%; 
                        overflow: auto;            /* Enable scroll if needed */
                        background-color: rgba(0, 0, 0, 0.8); /* Semi-transparent background */
                      }
              
                      /* Image displayed inside the modal */
                      .modal-content {
                        display: block;
                        margin: 8px auto;         /* Center horizontally */
                        max-width: 90%;            /* Don’t exceed viewport width */
                        max-height: calc(100vh - 16px);          /* Don’t exceed viewport height */
                      }
              
                      /* Close button (X) in the corner */
                      .modal-close {
                        position: absolute;
                        top: 20px;
                        right: 30px;
                        font-size: 40px;
                        font-weight: bold;
                        color: #fff;
                        cursor: pointer;
                      }
                      code {
                        padding: 4px;
                        border-radius: 4px;
                        margin: 4px;
                        background-color: #eaeaea;
                        border: 1px solid #ccc;
                      }
                  </style>
                </head>
                <body>
                    <div class="container">\${markdownHtml}</div>
                    <!-- The Modal structure -->
                    <div class="modal" id="imageModal">
                        <span class="modal-close" id="closeModal">&times;</span>
                        <img class="modal-content" id="modalImage" />
                    </div>
                </body>
                </html>
            \`)
            const s = newTab.document.createElement('script')
            s.text = \`document.addEventListener('DOMContentLoaded', function() {
        var modal = document.getElementById('imageModal')
        var modalImg = document.getElementById('modalImage')
        var closeModal = document.getElementById('closeModal')

        // Get all images inside .container
        var images = document.querySelectorAll('.container img')
        console.log(images)
        images.forEach(function(img) {
          console.log(img)
            img.addEventListener('click', function() {
                modal.style.display = 'block'
                modalImg.src = img.src
            })
        })

        closeModal.addEventListener('click', function() {
            modal.style.display = 'none'
        })

        // Close if user clicks outside the image
        modal.addEventListener('click', function(e) {
            if (e.target === modal) {
                modal.style.display = 'none'
            }
        })
    })\`
            newTab.document.head.appendChild(s)
            newTab.document.close()
            
        }
    </script>
</body>
</html>
`

// Save the HTML file
fs.writeFileSync(outputHtmlFile, htmlTemplate, 'utf8')

console.log(`✅ Gallery generated: ${outputHtmlFile}`)

try {
  await open(outputHtmlFile)
} catch (e) {
  console.error('Failed to open file using default app: ', e)
}
