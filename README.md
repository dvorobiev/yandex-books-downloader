# Bookmate Downloader

A Chrome extension (Manifest V3) that downloads books from [Bookmate](https://bookmate.com) as EPUB files (or audio tracks) directly from your browser — no external tools or scripts required.

Download the file and read on your favourite e-book device or listen to audiobook on PC.

## Features

- **One-click download** from any Bookmate book, serial, or audiobook page via the extension popup or an injected button in the page itself
- **EPUB assembly** built entirely in-browser — no native binaries or third-party libraries
- **Serial books** — all episodes are fetched, merged into one combined EPUB (OPF/NCX/content merged in-memory), and saved as a single file
- **Audiobooks** — individual `.m4a` tracks are downloaded directly from the Bookmate CDN
- **Optional CSS stripping** to produce smaller, style-free EPUB files
- **Bitrate selection** for audiobooks (max or min quality)
- Filenames are automatically derived from the book title and author(s)
- Based on Python scripts: [bookmate_downloader](https://github.com/ilyakharlamov/bookmate_downloader) and [RU_Bookmate_downloader](https://github.com/kettle017/RU_Bookmate_downloader)
- Written in co-authorship with [Claude Sonnet 4.6](https://www.anthropic.com/news/claude-sonnet-4-6).

## Requirements

- Google Chrome (or any Chromium-based browser that supports Manifest V3)
- Bookmate account with a Paid Active Subscription (Piracy is not supported!)

## Installation

### Option A — Pre-built release (recommended)

1. Go to the [Releases](../../releases) page and download the latest `bookmate-downloader-vX.X.X.crx` file.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Drag and drop the downloaded `.crx` file onto the Extensions page.
5. Click **Add extension** when Chrome prompts you.

> **Note:** Chrome may display a warning about installing extensions from outside the Web Store — this is expected for sideloaded extensions. The extension is signed with a consistent private key so Chrome will recognise it as the same extension across updates.

Alternatively, download the `bookmate-downloader-vX.X.X.zip` archive from the same release, extract it, and follow the **Load unpacked** steps below.

### Option B — Load unpacked (development)

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the `src/` folder.
5. The extension icon will appear in your toolbar.

## Usage

1. Log in to [bookmate.com](https://bookmate.com).
2. Navigate to a supported page:
   - Regular book: `https://bookmate.com/books/XXXXXXXX`
   - Serial book:  `https://bookmate.com/serials/XXXXXXXX`
   - Audiobook:    `https://bookmate.com/audiobooks/XXXXXXXX`
3. Either:
   - Click the **Bookmate Downloader** toolbar icon and press **Download EPUB** / **Download Audio**, or
   - Click the **Download button** injected directly into the page
4. Files are saved to your default downloads folder:
   - EPUB / serial: `<Title> - <Author>.epub`
   - Audiobook, single track: `<Title> - <Author>.m4a`
   - Audiobook, multiple tracks: `<Title> - Chapter N - <Author>.m4a` (supported download as zip folder)

## Options

| Option | Default | Visible on | Description |
|---|---|---|---|
| Strip CSS | Off | Books / Serials | Empties all `.css` files inside the EPUB, useful for applying your own reader styles. |
| Max bit rate | On | Audiobooks | Downloads the highest-quality audio variant; uncheck to prefer the smaller low-bitrate file. |

Settings are persisted via `chrome.storage.sync` and shared across devices.

## Permissions

| Permission | Reason |
|---|---|
| `cookies` | Read the session cookie to authenticate API requests |
| `downloads` | Save the assembled EPUB to disk |
| `activeTab` | Detect the current book ID from the page URL |
| `storage` | Persist user preferences (Strip CSS toggle) |
| `tabs` | Query the active tab URL to populate the book ID |
| `https://*.bookmate.com/*` | Fetch reader pages, metadata, and content files |

## Limitations
- The extension relies on Bookmate's internal reader API; it may break if Bookmate changes their API or encryption scheme.
- Comic books and other non-EPUB/non-audio formats are not supported.
- Serial episode CSS files from episode 2 onwards are intentionally skipped; all episodes share the first episode's stylesheet.

## License

This project is provided for personal and educational use only. Respect Bookmate's Terms of Service and only download books you are licensed to access.
