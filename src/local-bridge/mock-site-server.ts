import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

function html(body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Bridge Mock Page</title>
  </head>
  <body>
    ${body}
  </body>
</html>`
}

function send(res: ServerResponse, statusCode: number, body: string | Buffer, contentType: string): void {
  res.statusCode = statusCode
  res.setHeader('content-type', contentType)
  res.end(body)
}

function parseDelayMs(req: IncomingMessage): number {
  if (!req.url) {
    return 400
  }
  const url = new URL(req.url, 'http://127.0.0.1')
  const candidate = Number(url.searchParams.get('ms') || '400')
  if (!Number.isFinite(candidate)) {
    return 400
  }
  return Math.max(100, Math.min(candidate, 5_000))
}

export type MockSiteServer = {
  baseUrl: string
  fixtureImagePath: string
  close: () => Promise<void>
}

export async function startMockSiteServer(): Promise<MockSiteServer> {
  const fixtureImagePath = path.resolve(
    process.cwd(),
    'test-fixtures/bridge/sample.png'
  )
  if (!fs.existsSync(fixtureImagePath)) {
    throw new Error(`Missing fixture image: ${fixtureImagePath}`)
  }

  const imageBuffer = fs.readFileSync(fixtureImagePath)
  const server = http.createServer((req, res) => {
    if (!req.url) {
      send(res, 400, 'Bad request', 'text/plain; charset=utf-8')
      return
    }
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/assets/sample.png') {
      send(res, 200, imageBuffer, 'image/png')
      return
    }
    if (url.pathname === '/next') {
      send(
        res,
        200,
        html('<h1 id="next-title">Next Page</h1><div id="next-marker">ready</div>'),
        'text/html; charset=utf-8'
      )
      return
    }
    if (url.pathname === '/slow') {
      const delayMs = parseDelayMs(req)
      setTimeout(() => {
        send(
          res,
          200,
          html(`
          <h1 id="title">Bridge Mock Page</h1>
          <div id="app-root">slow route</div>
          <div class="item">Item 1</div>
          <div class="item">Item 2</div>
          <button id="action-button">Click me</button>
          <a id="download-link" href="/assets/sample.png">Download image</a>
          <img id="sample-image" src="/assets/sample.png" alt="sample image" />
          <script>
            window.__clickCount = 0;
            const button = document.getElementById('action-button');
            if (button) {
              button.addEventListener('click', () => {
                window.__clickCount += 1;
                document.body.setAttribute('data-clicked', String(window.__clickCount));
              });
            }
          </script>
        `),
          'text/html; charset=utf-8'
        )
      }, delayMs)
      return
    }

    send(
      res,
      200,
      html(`
        <h1 id="title">Bridge Mock Page</h1>
        <div id="app-root">ready</div>
        <div class="item">Item 1</div>
        <div class="item">Item 2</div>
        <button id="action-button">Click me</button>
        <a id="download-link" href="/assets/sample.png">Download image</a>
        <img id="sample-image" src="/assets/sample.png" alt="sample image" />
        <a id="next-link" href="/next">Next</a>
        <script>
          window.__clickCount = 0;
          const button = document.getElementById('action-button');
          if (button) {
            button.addEventListener('click', () => {
              window.__clickCount += 1;
              document.body.setAttribute('data-clicked', String(window.__clickCount));
            });
          }
        </script>
      `),
      'text/html; charset=utf-8'
    )
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, '127.0.0.1')
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve mock server address')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    fixtureImagePath,
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
  }
}
