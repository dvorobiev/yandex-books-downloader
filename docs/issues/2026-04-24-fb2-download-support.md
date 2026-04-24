# Issue: Add FB2 Download Support for Books

## Summary

The extension currently downloads books only in EPUB format. This is not sufficient for users whose reading workflows depend on FB2-compatible readers, libraries, and devices.

We need to add FB2 as a first-class export option for book downloads from both supported platforms:

- `books.yandex.ru`
- `bookmate.com`

The feature must be available directly from the extension UI, so the user can explicitly choose the output format before downloading a book.

## Problem

At the moment:

- book downloads are generated only as `.epub`
- the popup does not offer a format choice for books
- users who need `.fb2` must manually convert files outside the extension

This creates a poor workflow for users who:

- read in FB2-native applications
- maintain FB2-based personal libraries
- want a direct export without additional post-processing

## Why This Matters

FB2 remains a common and expected format in Russian-language reading ecosystems. For a noticeable part of the audience, FB2 is more practical than EPUB because:

- it is better supported by some local readers and devices
- it fits existing library organization habits
- it removes the need for external conversion tools

Without native FB2 export, the extension solves only part of the actual user task.

## Current Behavior

- user opens a supported book page
- user clicks the extension action or popup button
- the extension downloads a single `.epub`

## Expected Behavior

- user opens a supported book page
- user opens the popup
- user selects the desired book format: `EPUB` or `FB2`
- the extension downloads the book in the selected format

Expected output examples:

- `Book Title - Author.epub`
- `Book Title - Author.fb2`

## Scope

In scope:

- add FB2 export for books
- support both `books.yandex.ru` and `bookmate.com`
- add book format selection to the popup UI
- route download logic by selected format
- generate structurally valid FB2 XML
- preserve book text, section flow, headings, inline emphasis, links, and embedded images as much as possible

Out of scope:

- audiobook format changes
- comic support
- advanced FB2 metadata enrichment beyond existing available source metadata
- perfect semantic preservation of every EPUB/XHTML construct

## User Stories

- As a reader, I want to choose FB2 instead of EPUB before downloading a book.
- As a Bookmate/Yandex Books user, I want the same format-selection flow regardless of platform.
- As a user of FB2 readers, I want the downloaded file to open without XML or structure errors.

## Functional Requirements

1. The extension must provide a visible format selector for book downloads in the popup.
2. The selector must allow choosing between `EPUB` and `FB2`.
3. The selected format must be persisted in extension storage and reused for the next download.
4. The background workflow must route book downloads to the correct generator based on the selected format.
5. FB2 generation must work for books from both supported services.
6. Generated FB2 files must be valid XML and use the FictionBook 2.0 structure.
7. Embedded book images referenced in source content should be included in the resulting FB2 when available.

## Acceptance Criteria

- Popup shows a format choice for books: `EPUB` and `FB2`.
- Selecting `FB2` and downloading a Yandex book saves a `.fb2` file.
- Selecting `FB2` and downloading a Bookmate book saves a `.fb2` file.
- Selecting `EPUB` preserves existing EPUB behavior.
- The selected format remains selected after reopening the popup.
- Generated FB2 opens in common FB2 readers without XML parsing errors.
- The downloaded filename uses the `.fb2` extension for FB2 output.

## Risks

- EPUB/XHTML content can contain markup patterns that do not map cleanly to FB2.
- Invalid nesting during conversion can produce broken XML if paragraph and inline handling are not carefully normalized.
- Some source constructs may require lossy conversion because FB2 is structurally different from XHTML.

## Notes for Implementation

- The service worker environment does not guarantee DOM-based HTML parsing, so conversion should avoid DOM dependencies.
- A tokenizer-based XHTML-to-FB2 conversion path is acceptable.
- Paragraph and inline formatting boundaries must be normalized to avoid invalid XML like inline tags crossing paragraph boundaries.
- Empty headings should not become empty FB2 titles.

## Definition of Done

- FB2 export is implemented for both book providers
- popup format selector is implemented and persisted
- background routing supports both `epub` and `fb2`
- generated FB2 files are validated against real downloaded books
- regressions to EPUB flow are not introduced
