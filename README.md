# 🐹 PatronHamster

This is a content extractor for Patreon, Pixiv Fanbox, Substack, and X (Twitter) photo media.

Scraping uses a local bridge and a Chrome extension to download posts, images, and attachments in your existing Chrome profile. There is no standalone browser-automation scraping mode.

## 💯 Features

* Supported sites: Patreon, Pixiv Fanbox, Substack, X (Twitter photo media)
* Each post is downloaded as [markdown](https://en.wikipedia.org/wiki/Markdown) file + images + attachments
* Even large attachments can be downloaded - up to 100s of MB
* HTML preview gallery generation - to view in the browser
* Processed URLs are recorded to avoid extra traffic
* Substack only: epub generation 

## ✍️ Prerequisites

Existing account on Patreon with an active subscription to content creator. You can use free or any paid tier you need.

You should know what a shell/terminal is and how to execute commands in it.

Since Node.js is cross-platform, Windows/Linux/macOS are supported.

## 📈 Installation
1. Clone this repo into a folder. You can use `git clone` or just download source zip
2. Install [Node.js](https://nodejs.org/en). Used version is in the `.node-version` file 
   1. You can use [fnm](https://github.com/Schniz/fnm) to get correct version automatically.
   2. Install it, then `cd` into repository dir and it will install Node.js
3. Install yarn - run `corepack enable`
4. Run `yarn install` to install packages
5. Run `yarn build:extension` to build the Chrome extension into `dist/extension-bridge-v2`.
6. In Chrome, open `chrome://extensions`, enable Developer mode, select **Load unpacked**, and choose `dist/extension-bridge-v2`.
7. Keep Chrome running with the extension enabled while scraping. The launch command starts the local bridge automatically at `http://127.0.0.1:17353`; no separate bridge command is needed.

Playwright is used for browser integration tests, not scraping. To run those tests,
install its browser with `yarn playwright install --with-deps`.

For TypeScript/TSX code intelligence, `yarn install` also installs the project-local
`typescript-language-server`. OMP detects it from `node_modules/.bin`; after
installing it in an already-running session, reload the LSP configuration.

## 🚀 Usage

### Logging in

The extension opens a tab in your existing Chrome profile when login is needed.

Input your credentials and login, then press "Enter" in the shell to continue.

Next launches reuse that Chrome profile's authenticated session. The scraper does
not export or import cookies.

To force re-login on next scraping, delete `flags.json` file and retry.

### Download by year (Patreon only)

```shell
yarn run launch --patreon <example> --year <year>
```

Patreon may redirect creator feeds to `/c/<creator>/posts` or
`/cw/<creator>/posts`. Both routes are recognized by the bridge readiness check.
Year downloads select the requested year, accessible posts, and the Image post
type (or Poll with `--poll`).

### Download Patreon polls
Add `--poll` to download only poll posts for a Patreon creator. This applies the Patreon post-type filter and saves each poll post as Markdown. The option is unsupported for Pixiv Fanbox, Substack, and X.

```shell
yarn run launch --patreon <example> --year <year> --poll
```

### Download all by creator (Pixiv Fanbox only)

```shell
yarn run launch --url https://<creator name>.fanbox.cc/posts --dir output/<creator name>
```

### Download X (Twitter) photos

Provide a handle (with or without `@`):

```shell
yarn run launch --twitter <handle>
```

The command opens `https://x.com/<handle>/media?filter=photo`, checks that an X account is logged in, and prompts for login if needed. Images are written to `output/<handle>/`. Add `--update` to stop at the first previously downloaded image.

### Download single post

```shell
yarn run launch --url <post url> --dir mypost
```

### Update downloads on fresh posts
Add `--update` flag. It will stop fetching if processed posts are encountered.

```shell
yarn run launch --update --url https://<creator name>.fanbox.cc/posts --dir output/<creator name>
```

### Resize newly downloaded PNGs

```shell
yarn run launch --patreon <example> --year <year> --resize 4000:3000
yarn run launch --patreon <example> --year <year> --resize
```

`--resize w:h` fits each newly downloaded PNG within the requested width and
height, preserving aspect ratio. Both values must be positive safe integers.
Bare `--resize` uses `4000:4000`; omitting the flag leaves downloads unchanged.
Malformed or repeated values are rejected before launch.

The existing resize script runs in-process after each PNG is saved, using
Lanczos3, PNG compression level 7, and adaptive filtering. Images already inside
the bounds are only recompressed, never enlarged. Processing is awaited before
the download is marked saved. A temporary PNG is fully decoded before atomically
replacing the downloaded file under the same name, preserving links. On a resize
failure, the downloaded original is retained and the error is reported.

This applies to PNG image and attachment downloads across supported extractors.
Other formats and already-downloaded files are not processed.

### Patreon feed and carousel acquisition

For Patreon only, browser image requests are blocked before navigating to a post
list or an individual post. List blocking stays active through filtering,
scrolling, and pagination, including while a separate reusable post tab is processed.

For individual posts, the scraper collects every carousel image URL without
waiting for image pixels to load, then downloads the originals sequentially.
Full-size carousel URLs replace duplicate inline thumbnails, and existing files
are skipped.

This avoids downloading feed previews and fetching large carousel images twice.
Image loading is restored when list extraction or post processing ends, including
on errors.
Substack, Fanbox, and Twitter acquisition are unchanged.

Feed extraction reuses one post tab across pagination batches and closes it on
completion or failure. The bridge closes all tabs it created when the run ends,
including during error cleanup; pre-existing user tabs are not closed.
Browser evaluations release their remote result and exception objects after each
command, including while image interception keeps the debugger attached.

### Large downloads through the bridge

The extension streams binary downloads to Node in chunks of at most 1 MiB instead
of encoding entire files as Base64 JSON. Up to two downloads run concurrently,
without blocking tab commands or worker heartbeats. Each download retains the
10-minute deadline, including time spent queued.

Download progress measures bytes received by Node. The final `Saved` message
confirms that file saving has finished. Recovery waits for pending image handlers
and transfers before shutting down the broker, and interrupted transfers are
rejected rather than saved as partial files.

After updating, run `yarn build:extension`, reload the unpacked extension in
`chrome://extensions`, and restart the extractor. The extension and Node broker
must both use the updated binary protocol.

### Bridge trace logging

Add `--trace` to write bridge commands, responses, and heap measurements to
`output/<creator>/bridge.trace` as newline-delimited JSON.

```shell
yarn run launch --trace --patreon <example> --year <year>
```

`phase: "heap-usage"` entries are recorded every 10 seconds while
scraper-owned tabs exist, after enabling image blocking, and before unblocking
images or closing a tab. Each entry includes `at`, `tabId`, `url`, and `reason`
(`interval`, `images-blocked`, `before-unblock`, or `before-close`).

Heap fields are bytes returned by Chrome's `Runtime.getHeapUsage`:

- `usedSize`: used JavaScript heap.
- `totalSize`: allocated JavaScript heap capacity.
- `embedderHeapUsedSize`: embedder garbage-collected heap, when supported.
- `backingStorageSize`: ArrayBuffer and external-string backing storage, when supported.

These measure the target's V8 isolate, not total tab/process memory or all decoded
image/GPU allocations. Tabs can share an isolate, so do not sum their samples as
independent process totals. Sampling reuses active debugger sessions, does not
force garbage collection, and stops on cleanup. At most one sample per tab is
in flight; unavailable tabs or unsupported measurements produce
`phase: "heap-usage-error"` entries without failing the scrape.

Capture the trace before opening DevTools: opening it can detach the extension
debugger and release the objects being investigated. Without `--trace`, the
scraper makes no heap-measurement requests.

## Generate HTML gallery

`toc:html` is generated automatically by launch commands. Run `gallery:html` to replace `gallery.html` with the Twitter-style chronological feed, including each post's title, publication date, text, images, and attachment links.

Post body text longer than five rendered rows is collapsed by default behind a **Show post text** fieldset/legend button. Titles, dates, gallery images, and attachment links remain visible. Short text stays expanded without a toggle; the row threshold is recalculated when the window is resized or the feed is rotated. The toggle supports keyboard activation and preserves your expanded/collapsed choice across layout changes.

Feed images use native `loading="lazy"`, including in local `file://` galleries, so the browser can defer offscreen images until they approach the viewport. The browser controls the preload distance. Carousel images load immediately when selected, including through image bookmarks.

```shell
yarn run gallery:html --dir "C:\patreon_extractor\output\creator\2025"
```

## Resize a PNG

```shell
yarn image:resize input.png output.png --height 4000
yarn image:resize landscape.png output.png --width 6000
```

Specify either `--width` or `--height`; the other dimension follows the aspect
ratio. With neither option, the height defaults to 4000 pixels. Providing both
options is rejected rather than cropping the image.

Uses Sharp/libvips with native CPU SIMD acceleration, Lanczos3 resizing, and
lossless PNG compression level 7. Aspect ratio, transparency, and metadata are
retained; orientation is applied automatically. If the selected dimension (after
orientation) is at or below the target, resizing is skipped and the image is only
re-encoded with PNG compression level 7. Images are never upscaled; re-encoding an
already optimized PNG does not guarantee a smaller file.
Output is always PNG, and existing files are never overwritten. Only single-frame
PNG inputs are accepted: the file signature is checked regardless of extension,
and animated PNGs are rejected rather than silently losing frames.

Adaptive PNG row filtering is enabled by default to produce smaller files quickly.
Use `--no-adaptive-filtering` only when encoding speed matters more than file size;
it does not change decoded pixels. Resizing itself is lossy. There is no Metal dependency.
The script prints dimensions, byte counts, savings, and processing time as JSON.
After building once, use `node dist/scripts/resizeImage.js` with the same arguments
to avoid rebuilding for each invocation.

## Generate epub (for Substack only)

```shell
yarn run epub --dir "C:\patreon_extractor\output\creator\"
```

Gallery will open in the default system browser. If not, you can find `gallery.html` file in the directory you provided.

## Checking the results

You can find files in the `output/\<year>/` folder. 

Html gallery file is always called `gallery.html` and can be viewed in the browser of your choice.

## 😎 Advanced usage

### Auto recovery from failures

Scraping can be flaky and requests may fail due to network, increasing memory footprint etc. 

Auto recovery is enabled by default. Use `--no-recover` to disable restarting the scraping run on critical failures. Your Chrome browser stays open.

### Cloudflare captcha

Cloudflare is a solution websites use to protect from bots and scrapers.

This is usually done by showing captcha on suspicious activity.

Either solve the captcha/challenge manually and press "Enter" in the shell afterward, or close and relaunch the command.

### Resetting stored login

1. Sign out of the site or clear its cookies in the Chrome profile running the extension.
2. Delete `flags.json` in the root of this repository.
3. Start a scraping command and log in again.

### Using with proxy

Configure a proxy for Chrome, or use a system-wide proxy or VPN. The scraper does
not launch its own browser or accept browser proxy configuration.

## 🛠️ Stack

Chrome extension + local HTTP bridge for scraping in your existing Chrome profile.

[Playwright](https://playwright.dev/) for browser integration tests.

[Turndown](https://github.com/mixmark-io/turndown#readme) to convert posts html into markdown.

## 🕵️ Privacy

Everything works locally. 

Scraping uses your Chrome profile through the installed extension.

Authentication stays in that Chrome profile; the scraper does not maintain a separate cookie file.

You can examine built code in the `dist` directory after launching any commands for downloading.

## ⁉ Q&A

**Q**: Why not use _\<name of other downloader\>_ tool?

**A**: I tried some, and they didn't work for me. Also writing your own tool is fun.

**Q**: Will it give me access to unpaid content?

**A**: No, you need to have subscription to access content you want to download.

**Q**: Something broke and scraping stopped, will it need to download everything again?

**A**: No, processed URLs are stored in the `\<output dir you provided>/visited.txt` file. 
Images and attachments are checked by their names before downloading.

**Q**: I'm stuck in a Cloudflare captcha infinite loop 😢

**A**: Open a new tab in the Chrome profile running the extension with Google, wikipedia, etc.
If you get any captchas there - solve them. Open some random urls more.
Looks like it helps to build credibility with automated checks.

Alternatively, try another proxy/vpn.
