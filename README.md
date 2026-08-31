# 🐹 PatronHamster

This is a content extractor for Patreon, Pixiv Fanbox, Substack, and X (Twitter) photo media.

It leverages Playwright and the default extension bridge transport to open Chrome and download posts, images, and attachments automatically.

## 💯 Features

* Supported sites: Patreon, Pixiv Fanbox, Substack, X (Twitter photo media)
* Each post is downloaded as [markdown](https://en.wikipedia.org/wiki/Markdown) file + images + attachments
* Even large attachments can be downloaded - up to 100s of MB
* HTML preview gallery generation - to view in the browser
* Local files cache for loading speed up - up to 95% hit rate
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
5. Run `yarn playwright install --with-deps` to install browsers

## 🚀 Usage

### Logging in

Running any command listed below first time will open a login window.

Input your credentials and login, then press "Enter" in the shell to continue.

Next launches will reuse stored login info.

To force re-login on next scraping, delete `flags.json` file and retry.

### Download by year (Patreon only)

```shell
yarn run launch --patreon <example> --year <year>
```

### Download all by creator (Pixiv Fanbox only)

```shell
yarn run launch --url https://<creator name>.fanbox.cc/posts --dir output/<creator name>
```

### Download X (Twitter) photos

Twitter extraction uses the default v2 bridge only; do not pass `--v1`. Provide a handle (with or without `@`):

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

### Legacy transport mode (opt-in)

Add `--v1` to force the older browser automation path instead of the default extension bridge transport.

```shell
yarn run launch --v1 --patreon <example> --year <year>
```

### Bridge trace logging

Add `--trace` to write sent bridge commands and arguments to `output/<creator>/bridge.trace` for debugging.

```shell
yarn run launch --trace --patreon <example> --year <year>
```

## Generate HTML gallery

`toc:html` is generated automatically by launch commands. Run `gallery:html` to replace `gallery.html` with the Twitter-style chronological feed, including each post's title, publication date, text, images, and attachment links.

```shell
yarn run gallery:html --dir "C:\patreon_extractor\output\creator\2025"
```

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

Auto recovery is enabled by default. Use `--no-recover` to disable auto restarting browser on critical failures.

### Cloudflare captcha

Cloudflare is a solution websites use to protect from bots and scrapers.

This is usually done by showing captcha on suspicious activity.

Either solve the captcha/challenge manually and press "Enter" in the shell afterward, or close and relaunch the command.

### Resetting stored login

1. Close the browser
2. Delete `playwright-cache` folder, `cookies.json` file and `flags.json` in the root of this repository folder
3. Start any command and login again

### Resetting cache

All js/css files and images are stored in the `custom-cache` folder. 
Since there are no checks for the validity or staleness, old cache may break the scraping.

If you notice any weird problems, try to remove the folder and start scraping again.

🚨 Avoid deleting this folder unless necessary! Almost 90% of network requests are cached, which significantly speeds up the scraping process!

### Using with proxy

Use additional shell arguments:

```shell
yarn launch --url <your url> --year 2025 --dir output --server <your proxy server with port> --username <username> --password <password>
```

Alternatively, use any system-wide proxy or VPN.

## 🛠️ Stack

[Playwright](https://playwright.dev/) for scraping.

[Rebrowser](https://github.com/rebrowser) for working around Cloudflare detection.

[Turndown](https://github.com/mixmark-io/turndown#readme) to convert posts html into markdown.

## 🕵️ Privacy

Everything works locally. 

The browser started for scraping is usual Chromium browser.

No credentials you enter are stored or sent anywhere externally.

You can examine built code in the `dist` directory after launching any commands for downloading.

## ⁉ Q&A

**Q**: Why not use _\<name of other downloader\>_ tool?

**A**: I tried some, and they didn't work for me. Also writing your own tool is fun.

**Q**: Will it give me access to unpaid content?

**A**: No, you need to have subscription to access content you want to download.

**Q**: Something broke and browser closed, will it need to download everything again?

**A**: No, processed URLs are stored in the `\<output dir you provided>/visited.txt` file. 
Images and attachments are checked by their names before downloading.

**Q**: I'm stuck in a Cloudflare captcha infinite loop 😢

**A**: Open a new tab in automated browser with Google, wikipedia, etc. 
If you get any captchas there - solve them. Open some random urls more.
Looks like it helps to build credibility with automated checks.

Alternatively, try another proxy/vpn.

**Q**: Low cache hit rate - less than 80%

**A**: You can uncomment logger in the cache.ts at the end of the file to log issues. 
Sometimes it may happen from SSL errors - if you're trying to avoid ISP restrictions.
Disable said apps and try again.
