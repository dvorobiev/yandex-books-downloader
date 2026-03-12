# GitHub Copilot Instructions — Bookmate Downloader Extension

## Project Overview

A Chrome Extension (Manifest V3) that downloads books from [Bookmate](https://bookmate.com) as
EPUB files or audio tracks. Everything runs entirely in the browser — no native binaries, no external libraries,
no build step. The `src/` folder is loaded directly as an unpacked extension.

## File Roles

| File | Role |
|---|---|
| `src/manifest.json` | MV3 manifest — permissions, content-script declaration, service-worker registration (`"type": "module"` enables ES module imports in the service worker) |
| `src/background.js` | Service worker entry point — `chrome.runtime.onConnect` message handler; dispatches to `downloadBook`, `downloadSerial`, or `downloadAudiobook` based on `msg.bookType` (`BookType` enum); contains `sendBackZipInChunks` which streams finished ZIP bytes back to the popup in 1 MB chunks via `zip-chunk`/`zip-end` messages |
| `src/lib/booktype.js` | `BookType` frozen enum — `BOOK`, `SERIAL`, `AUDIO`, `COMICBOOK`, `SERIES`; imported by `background.js` and the `lib/` modules. **Also inlined verbatim in `content.js` and `popup.js`** (plain scripts cannot use ES module imports) — keep all three copies in sync |
| `src/lib/crc32.js` | CRC-32 lookup-table implementation (`CRC_TABLE`, `crc32`) |
| `src/lib/http.js` | Shared HTTP/file utilities — `READER_BASE` constant, `fetchWithCookie`, `blobToDataUrl`, `safeName`; imported by `bookmate.js` and `audiobook.js` to eliminate duplication |
| `src/lib/epub.js` | DEFLATE via `CompressionStream` + ZIP/EPUB binary assembler (`deflateRaw`, `assembleParts`, `buildEpub`, `buildZip` and helpers); imports `crc32`. `assembleParts` is a shared sync core used by both `buildEpub` and `buildZip` |
| `src/lib/decrypt.js` | AES-CBC decryption via Web Crypto API (`base64ToBytes`, `decryptValue`) and `extractClientParams` HTML parser |
| `src/lib/bookmate.js` | Bookmate download orchestration (`downloadBook`, `downloadSerial`); private helpers: `decryptMeta`, `parseOpfHrefs`, `downloadContentFiles`, `stripCssFiles`, `buildEpubFilename`, `saveEpubBlob`; imports from `epub.js`, `decrypt.js`, `merge.js`, `http.js` |
| `src/lib/merge.js` | In-memory EPUB episode merger (`mergeEpisodes`); regex-based XML manipulation of OPF manifest/spine and NCX navMap — mirrors Python `EpubMerger` |
| `src/lib/audiobook.js` | Audiobook download logic (`fetchAudiobookMeta`, `downloadAudiobook`); private helpers: `resolveTrack` (resolves track number + `.m4a` URL), `trackBaseName` (builds filename stem), `downloadAudiobookIndividual` (one `chrome.downloads` call per track), `downloadAudiobookAsZip` (fetches all tracks, builds ZIP, calls `onZipReady` callback); imports from `epub.js` and `http.js` |
| `src/content.js` | Injected into every `*.bookmate.com` page (plain script) — detects book pages, injects a download `<button>` into `.buttons-row__container`, handles SPA navigation via `window.navigation` |
| `src/popup.html` | Toolbar popup UI — dark theme, CSS variables, progress bar, scrollable log box |
| `src/popup.js` | Popup logic (plain script) — reads active-tab URL to extract book ID and `BookType`, persists `stripCss` via `chrome.storage.sync`, communicates with background via a long-lived port |

## Architecture & Data Flow

```
User action (popup button OR injected page button)
  │
  ▼
popup.js / content.js
  └─ chrome.runtime.connect({ name: 'bookmate-download' })
       └─ postMessage({ action: 'download', bookid, bookType, stripCss, maxBitRate })
             │              OR for audiobooks, first:
             │        postMessage({ action: 'audiobook-meta', bookid })
             │              └─ response: { type: 'audiobook-meta', trackCount, title }
             │              └─ popup shows choice if trackCount > 1, then sends download msg
             │
             ▼
         background.js  (service worker)
           1. Verify `bms` session cookie (chrome.cookies)
           2. Dispatch: BookType.AUDIO → downloadAudiobook(), BookType.SERIAL → downloadSerial(), BookType.BOOK → downloadBook()

  ── Regular book (downloadBook) ─────────────────────────────────────────
           3. GET reader.bookmate.com/<bookid>  → extract window.CLIENT_PARAMS.secret
           4. Parallel fetch: encrypted metadata + book info
           5. AES-CBC decrypt metadata fields that are arrays (container, opf, ncx)
           6. Regex-parse OPF manifest → list of content file hrefs
           7. Sequential GET of each content file (OEBPS/ base URL)
           8. Optionally zero-out .css files (stripCss flag)
           9. buildEpub() → valid ZIP/EPUB blob
          10. chrome.downloads.download() via data-URL
          11. port.postMessage({ type: 'success'|'progress'|'error', ... })

  ── Serial book (downloadSerial) ────────────────────────────────────────
           3. GET reader.bookmate.com/<bookid>  → extract window.CLIENT_PARAMS.secret
           4. Parallel fetch: book info + episodes list (/p/api/v5/books/<bookid>/episodes)
           5. For each episode (episode.uuid):
              a. GET /p/api/v5/books/<episode.uuid>/metadata/v4  → encrypted metadata
              b. AES-CBC decrypt (same serial secret for all episodes)
              c. Regex-parse OPF manifest → content file hrefs
              d. Sequential GET of each content file
              e. Optionally zero-out .css files
           6. mergeEpisodes() → single files[] with merged OPF/NCX/content
           7. buildEpub() → valid ZIP/EPUB blob
           8. chrome.downloads.download() via data-URL
           9. port.postMessage({ type: 'success'|'progress'|'error', ... })

  ── Audiobook (downloadAudiobook) ───────────────────────────────────────
           3. Parallel fetch: audiobook info (/p/api/v5/audiobooks/<bookid>) +
              track playlist (/p/api/v5/audiobooks/<bookid>/playlists.json)
           4. For each track: derive direct .m4a URL from the .m3u8 manifest URL
              (replace .m3u8 suffix → .m4a)

       If asZip is false (individual files, or single track):
           5. chrome.downloads.download() for each track directly via CDN URL
           6. Filename rules:
              - 1 track  → "{title} - {author}.m4a"
              - N tracks → "{title} - Chapter {N} - {author}.m4a"
           7. port.postMessage({ type: 'success'|'progress'|'error', ... })

       If asZip is true (ZIP bundle, only sent when trackCount > 1):
            5. popup.js calls window.showSaveFilePicker() to get a FileSystemFileHandle
               before the download message is sent
            6. background.js calls downloadAudiobook(..., onZipReady = sendBackZipInChunks(port))
            7. downloadAudiobookAsZip fetches each .m4a as ArrayBuffer via fetchWithCookie()
            8. buildZip() → ZIP Uint8Array (all entries ZIP_STORED — no compression)
            9. onZipReady(zipBytes) is called — sendBackZipInChunks streams the bytes back
               to the popup in 16 MB slices as { type: 'zip-chunk', seq, data, ln } messages,
               followed by { type: 'zip-end' }
           10. popup.js reassembles chunks, writes them to disk via FileSystemFileHandle.createWritable()
           11. background returns null (no separate 'success' sent); popup logs its own success
```

## Key Technical Details

### No External Dependencies
Every algorithm is implemented from scratch using only browser-native APIs:
- **CRC-32** — lookup-table implementation (`CRC_TABLE`, `crc32()`)
- **DEFLATE** — `CompressionStream('deflate-raw')` (do NOT await write/close before reading — deadlock risk)
- **ZIP/EPUB** — manual binary assembly (`mkLocalHeader`, `mkCentralEntry`, `mkEndRecord`, `buildEpub`, `buildZip`)
  - `buildEpub` uses ZIP_STORED for `mimetype`, ZIP_DEFLATE for all other entries
  - `buildZip` uses ZIP_STORED for **all** entries — intended for already-compressed binary files such as `.m4a`
- **AES-CBC** — Web Crypto API (`crypto.subtle.importKey` / `crypto.subtle.decrypt`)
- **XML parsing** — regex only (`DOMParser` is unavailable in service workers)

### EPUB Invariants (must not break)
- `mimetype` **must be the first ZIP entry** and **must be ZIP_STORED (method 0)**, not compressed
- All other entries use ZIP_DEFLATE (method 8)
- `buildEpub(files)` expects `files[0]` to be `{ name: 'mimetype', data: ENC.encode('application/epub+zip') }`
- EPUB file order: `mimetype` → `META-INF/container.xml` → `OEBPS/content.opf` → `OEBPS/toc.ncx` → content files

### Bookmate API Endpoints (reader.bookmate.com)
- Reader page: `GET /<bookid>` — HTML containing `window.CLIENT_PARAMS = { secret: "<base64>" }`
- Encrypted metadata: `GET /p/api/v5/books/<bookid>/metadata/v4`
  - Response JSON: `{ container: [int...], opf: [int...], ncx: [int...], document_uuid: "..." }`
  - Array values are AES-CBC encrypted (key = base64-decoded `secret`, IV = first 16 bytes of the int array)
- Book info: `GET /p/api/v5/books/<bookid>` — returns `{ book: { title, authors } }`
- Content files: `GET /p/a/4/d/<document_uuid>/contents/OEBPS/<href>`
- All requests use `credentials: 'include'` to send the `bms` session cookie

### Decryption
`decryptValue(secret, intArray)`:
- `key` = `base64ToBytes(secret)` → raw AES key bytes
- `iv` = first 16 bytes of `new Uint8Array(intArray)`
- `body` = remaining bytes
- Decrypt with AES-CBC

### Book ID & URL types
- Regular book URL: `https://bookmate.com/books/{bookid}` — `bookType = BookType.BOOK`
- Serial book URL:  `https://bookmate.com/serials/{bookid}` — `bookType = BookType.SERIAL`
- Audiobook URL:    `https://bookmate.com/audiobooks/{bookid}` — `bookType = BookType.AUDIO`
- Comicbook URL:    `https://bookmate.com/comicbooks/{bookid}` — `bookType = BookType.COMICBOOK` (not yet supported)
- Series URL:       `https://bookmate.com/series/{bookid}` — `bookType = BookType.SERIES` (not yet supported)
- Regex (content.js / popup.js): `/(books|serials|audiobooks|comicbooks|series)\/([A-Za-z0-9]{6,12})(?:[\/?#]|$)/`
- This regex is duplicated in `content.js` and `popup.js` — keep them in sync
- The URL segment is mapped to a `BookType` value via a lookup object in both files; unsupported types (`COMICBOOK`, `SERIES`) skip button injection / disable download

### Audiobook API Endpoints (reader.bookmate.com)
- Audiobook info: `GET /p/api/v5/audiobooks/<bookid>` — returns `{ audiobook: { title, authors } }`
- Track playlist: `GET /p/api/v5/audiobooks/<bookid>/playlists.json`
  - Response: `{ tracks: [{ number, offline: { max_bit_rate: { url }, min_bit_rate: { url } } }] }`
  - `track.number` is **0-based**; display as 1-based in filenames
  - `url` points to an `.m3u8` HLS manifest — replace the suffix with `.m4a` to get the direct audio file
- All requests use `credentials: 'include'`

### Audiobook (`src/lib/audiobook.js`)
`fetchAudiobookMeta(bookid)`:
- Parallel-fetches audiobook info + playlist
- Returns `{ bookTitle, tracks, titlePart, authorSfx }` without triggering any download
  - `titlePart` = `safeName(bookTitle)` — sanitised title ready for use in filenames
  - `authorSfx` = `" - " + safeName(authors)` or `""` if no authors
- Called by the `audiobook-meta` action handler in `background.js` to report track count to the popup

`downloadAudiobook(bookid, maxBitRate, asZip, onProgress, onZipReady = null)`:
- Calls `fetchAudiobookMeta` internally to avoid duplicate requests
- Selects `max_bit_rate` or `min_bit_rate` track variant based on the `maxBitRate` boolean
- Derives the `.m4a` URL via `.replace(/\.m3u8(\?.*)?$/, '.m4a')`
- `asZip = false`: delegates to `downloadAudiobookIndividual` — calls `chrome.downloads.download({ url, filename })` once per track (direct CDN URLs, no data-URL conversion needed)
- `asZip = true`: delegates to `downloadAudiobookAsZip` — fetches all tracks as `ArrayBuffer`, builds a ZIP via `buildZip` (ZIP_STORED), then calls `onZipReady(zipBytes)`. Returns `null` to signal that saving was handled by the callback.
  - `onZipReady` is always provided when `asZip = true` (background passes `sendBackZipInChunks(port)`)
- Filename: `{title} - {author}.m4a` (single track) or `{title} - Chapter {N} - {author}.m4a` (multiple, individual) or `{title} - {author}.zip` (zip bundle)

### Serial / Episode API
- Episodes list: `GET /p/api/v5/books/<serialId>/episodes` → `{ episodes: [{ uuid, title, … }] }`
- Each episode's metadata fetched via `/p/api/v5/books/<episode.uuid>/metadata/v4` using the **same** AES secret extracted from the serial reader page
- Content files per episode: `GET /p/a/4/d/<episode.document_uuid>/contents/OEBPS/<href>`

### Episode Merge Algorithm (`src/lib/merge.js`)
`mergeEpisodes(episodes, bookTitle)` takes an array of episode objects and merges them in-memory:
1. Seed the combined EPUB with episode 1's files (container, OPF, NCX, content).
2. For each subsequent episode:
   - Parse OPF `<item>` elements (id, href, media-type) and `<itemref>` spine entries.
   - Skip `toc.ncx` (merged via NCX path) and CSS files (reuse episode 1's stylesheet).
   - Rename conflicting hrefs with `_ep{N}` suffix (e.g. `chapter_ep2.html`).
   - Resolve id conflicts by appending `_1`, `_2`, … suffixes.
   - Append new `<item>` entries before `</manifest>` and new `<itemref>` entries before `</spine>` in the combined OPF text.
   - Extract the `<navMap>` content from the episode's NCX, renumber all `playOrder` attributes sequentially, and append before `</navMap>` in the combined NCX.
3. Update `<dc:title>` in the combined OPF with the serial's book title.
4. All XML manipulation is pure string/regex — no `DOMParser` (unavailable in service workers).

### Communication Protocol
Port name: `'bookmate-download'`

| Direction | Message shape |
|---|---|
| sender → background | `{ action: 'download', bookid: string, bookType: BookType, asZip: boolean, stripCss: boolean, maxBitRate: boolean }` |
| sender → background | `{ action: 'audiobook-meta', bookid: string }` |
| background → sender | `{ type: 'audiobook-meta', trackCount: number, title: string, titlePart: string, authorSfx: string }` |
| background → sender | `{ type: 'progress', text: string, pct: number }` |
| background → sender | `{ type: 'zip-chunk', seq: number, data: number[], ln: number }` — one 1 MB slice of the ZIP bytes |
| background → sender | `{ type: 'zip-end' }` — all ZIP chunks have been sent; popup should flush the FileSystemFileHandle |
| background → sender | `{ type: 'success', filename: string }` — **not** sent for ZIP audiobooks (popup handles its own success log) |
| background → sender | `{ type: 'error', text: string }` |

`port.onDisconnect` is handled on both sides to cope with the service worker being killed by the browser during a long download.

### Settings
- `chrome.storage.sync` key: `stripCss` (boolean, default `false`) — EPUB CSS stripping; shown only on book/serial pages
- `chrome.storage.sync` key: `maxBitRate` (boolean, default `true`) — audiobook bitrate selector; shown only on audiobook pages
- Both keys are read in `popup.js` (for the UI checkboxes) and `content.js` (before starting a download via the injected button)

### Popup UI visibility rules
- On `/books/` or `/serials/` pages: **Strip CSS** row visible; Max bit rate row hidden; button label **"Download EPUB"**
- On `/audiobooks/` pages: Strip CSS row hidden; **Max bit rate** row visible; button label **"Download Audio"**
- On `/comicbooks/` or `/series/` pages: both option rows hidden; button **disabled** with label **"Not supported yet"**
- The `hidden` CSS class (`display: none`) is toggled by `popup.js` at init time based on `currentBookType`

## Coding Conventions
- `'use strict'` at the top of every JS file
- No build tools, no TypeScript, no bundler — plain ES2022 JavaScript
- `const ENC = new TextEncoder()` is a module-level singleton in `background.js`
- Helper functions follow a "small, named" style — prefer named functions over anonymous lambdas for anything non-trivial
- Progress callbacks: `onProgress(text: string, pct: number)` — `pct` is 0-100
- When changing the architecture or data flow, copilot-instructions.md must be updated with a clear description of the new flow and any new technical details that future maintainers should be aware of

## Permissions (why each exists)
| Permission | Usage |
|---|---|
| `cookies` | `chrome.cookies.get` to verify `bms` session cookie |
| `downloads` | `chrome.downloads.download` to save the EPUB or audio tracks |
| `activeTab` | Detect book ID from the current tab's URL in the popup |
| `storage` | Persist `stripCss` setting across sessions |
| `tabs` | `chrome.tabs.query` in `popup.js` to get the active tab URL |
| `https://*.bookmate.com/*` | Fetch reader pages, API endpoints, and content files |

## Known Limitations & Fragility Points
1. **Regex-based OPF/NCX parsing** — if Bookmate changes attribute quoting, adds newlines inside `<item>` tags, or nests `</manifest>` inside comments, this may break; `DOMParser` is not possible in service workers
2. **Episode merge CSS skipping** — CSS files from episode 2+ are intentionally dropped; all episodes share episode 1's stylesheet. This may cause styling issues if episodes have unique CSS.
3. **`window.CLIENT_PARAMS` extraction** — depends on finding the literal string and a `=...;` pattern on the same logical line
4. **Sequential content file downloads** — large books can be slow; parallelising with `Promise.all` in batches is a possible improvement but risks rate-limiting
5. **Data-URL download workaround** — `chrome.downloads.download` doesn't accept `blob:` URLs from service workers, so EPUB/serial blobs are converted to `data:` URLs via `FileReader` first (`blobToDataUrl`); individual audiobook track downloads bypass this because they use direct CDN URLs; ZIP audiobook bundles also bypass this — they are streamed back to the popup via `zip-chunk`/`zip-end` messages and written directly to disk via `FileSystemFileHandle` (requires `window.showSaveFilePicker`, which is unavailable in service workers)
6. **SPA navigation** — uses `window.navigation` (Chrome 102+); older browsers would need a `popstate`/`pushState` shim
7. **Audiobook `.m3u8` → `.m4a` assumption** — the URL rewrite relies on Bookmate's CDN serving `.m4a` at the same path; if the CDN layout changes, track downloads will break
8. **ZIP audiobook memory usage** — when `asZip = true`, all tracks are fetched into memory as `ArrayBuffer` before writing the ZIP; very long audiobooks could approach the service worker memory limit

## Development Setup
No build step required.
1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select `src/`
4. After editing any file, click the ↺ reload button on the extension card

Run `bookmate_downloader.py` (Python script at the workspace root) for a standalone reference implementation of the same download logic outside the browser.
