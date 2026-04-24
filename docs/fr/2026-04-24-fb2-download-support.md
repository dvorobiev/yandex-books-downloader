# FR: FB2 Download Format for Books

## Status

Implemented.

## Summary

Add `FB2` as an alternative book download format alongside `EPUB` for supported book pages in the extension.

The user must be able to select the desired format in the popup before starting the download. The extension must then build and save either an `.epub` or `.fb2` file using the same book source content.

## Objective

Reduce user friction for readers who consume books in FB2-based ecosystems by supporting direct FB2 export from the extension without requiring external conversion tools.

## Supported Sources

- `books.yandex.ru`
- `bookmate.com`

## User Experience

### Popup Behavior

When the active page contains a supported book:

- the popup shows a book format selector
- available options are `EPUB` and `FB2`
- the selected option is clearly reflected in the UI
- the selected value is remembered for future downloads

### Download Behavior

When the user clicks the main download action:

- if `EPUB` is selected, the current EPUB workflow is used
- if `FB2` is selected, the extension builds and downloads an FB2 file

### Filenames

The downloaded filename must follow the existing naming style:

- `Book Title - Author.epub`
- `Book Title - Author.fb2`

## Functional Specification

### 1. Format Selection

The extension must support a book-level format setting with values:

- `epub`
- `fb2`

This setting must be:

- available in popup UI
- persisted via extension storage
- used by the background download flow

### 2. Provider Routing

The background script must route book downloads by provider and format:

- Yandex + EPUB
- Yandex + FB2
- Bookmate + EPUB
- Bookmate + FB2

Audiobook flows are unchanged.

### 3. FB2 Generation

The extension must generate FB2 from already-downloaded XHTML/content assets.

The conversion flow must:

- extract XHTML reading order from OPF/spine
- convert XHTML content into FB2 `<section>` blocks
- map paragraphs into `<p>`
- map headings into `<title><p>...`
- map emphasis and strong text into valid FB2 inline tags
- convert blockquotes into `<cite>` where appropriate
- include referenced images as `<binary>` entries plus `<image l:href="...">`
- escape XML safely

### 4. Validity Requirements

Generated FB2 must satisfy these minimum quality requirements:

- valid XML
- no inline tags crossing paragraph boundaries
- no malformed nesting such as `<emphasis><p>...`
- no empty heading output like `<title><p></p></title>`
- valid FictionBook root structure with required metadata container

## Technical Design

### New Module

Create a dedicated FB2 builder module:

- [src/lib/fb2.js](/Users/dvorobiev/projects/bookmate-ext/src/lib/fb2.js)

Responsibilities:

- lightweight XHTML tokenization without DOM APIs
- content normalization for service-worker-safe conversion
- spine/order parsing from OPF
- FB2 XML assembly
- binary image embedding

### Updated Files

- [src/lib/yandex.js](/Users/dvorobiev/projects/bookmate-ext/src/lib/yandex.js)
- [src/lib/bookmate.js](/Users/dvorobiev/projects/bookmate-ext/src/lib/bookmate.js)
- [src/background.js](/Users/dvorobiev/projects/bookmate-ext/src/background.js)
- [src/popup.html](/Users/dvorobiev/projects/bookmate-ext/src/popup.html)
- [src/popup.js](/Users/dvorobiev/projects/bookmate-ext/src/popup.js)

### Storage

Persist the chosen book format in extension storage and restore it when the popup is reopened.

## Non-Goals

- redesign of audiobook UX
- support for additional ebook formats beyond EPUB and FB2
- deep metadata enrichment from external services
- perfect preservation of every XHTML semantic edge case

## Constraints

- runs in Chrome Extension Manifest V3 environment
- must work in service worker context
- no external conversion libraries required
- conversion should tolerate imperfect source XHTML while still producing valid FB2

## Edge Cases

The converter must explicitly handle:

- inline emphasis around content separated by `<br>`
- block and inline nesting differences between XHTML and FB2
- relative image paths from spine documents
- source content with decorative or empty headings
- content sections containing images before or after text blocks

## Acceptance Criteria

1. Popup exposes `EPUB` and `FB2` for book downloads.
2. Popup remembers the last selected format.
3. Yandex book downloads work in both EPUB and FB2.
4. Bookmate book downloads work in both EPUB and FB2.
5. Resulting FB2 files use the `.fb2` extension.
6. Resulting FB2 files pass XML validation on real-world samples.
7. EPUB behavior remains unchanged when EPUB is selected.

## Validation Performed

- module imports validated for new and updated files
- popup/background wiring verified in stubbed environment
- synthetic conversion cases tested
- generated FB2 validated with `xmllint`
- real downloaded FB2 samples checked and converter fixed for:
  - inline formatting crossing paragraph boundaries
  - paragraph splits produced from `<br>`
  - empty generated titles

## Release Notes Candidate

Added selectable `FB2` export for books in the popup. Users can now choose between `EPUB` and `FB2` when downloading supported books from Yandex Books and Bookmate.
