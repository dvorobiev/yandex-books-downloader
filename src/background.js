'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Message handling (long-lived port from popup)
// ═══════════════════════════════════════════════════════════════════════════

import { downloadBook, downloadBookFb2, downloadSerial } from './lib/bookmate.js';
import { downloadAudiobook, fetchAudiobookMeta } from './lib/audiobook.js';
import { downloadBookFb2Yandex, downloadBookYandex, downloadComicYandex, downloadAudiobookYandex, fetchAudiobookMetaYandex } from './lib/yandex.js';
import { BookType } from './lib/booktype.js';

const YANDEX_HOST = 'books.yandex.ru';

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'bookmate-download') return;

  port.onMessage.addListener(async (msg) => {
    function send(type, payload) {
      try { port.postMessage({ type, ...payload }); } catch (_) { /* port closed */ }
    }

    function onProgress(text, pct) {
      console.log(`[bookmate] ${text}`);
      send('progress', { text, pct });
    }

    // ── audiobook-meta: fetch track count so popup can ask about ZIP vs individual
    if (msg.action === 'audiobook-meta') {
      try {
        if (msg.source === YANDEX_HOST) {
          const { bookTitle, tracks, titlePart, authorSfx } = await fetchAudiobookMetaYandex(msg.bookid);
          send('audiobook-meta', { trackCount: tracks.length, title: bookTitle, titlePart, authorSfx });
        } else {
          const cookie = await chrome.cookies.get({ url: 'https://bookmate.com', name: 'bms' });
          if (!cookie) throw new Error('bms cookie not found — please log in to bookmate.com first');
          const { bookTitle, tracks, titlePart, authorSfx } = await fetchAudiobookMeta(msg.bookid);
          send('audiobook-meta', { trackCount: tracks.length, title: bookTitle, titlePart, authorSfx });
        }
      } catch (err) {
        console.error('[bookmate] Error:', err);
        send('error', { text: err.message });
      }
      return;
    }

    if (msg.action !== 'download') return;

    const { bookid, bookType, stripCss, maxBitRate, asZip = false, source, format = 'epub' } = msg;

    try {
      // ── Yandex Books path ───────────────────────────────────────────────
      if (source === YANDEX_HOST) {
        let filename;
        if (bookType === BookType.BOOK) {
          filename = format === 'fb2'
            ? await downloadBookFb2Yandex(bookid, onProgress)
            : await downloadBookYandex(bookid, stripCss, onProgress);
        } else if (bookType === BookType.AUDIO) {
          const onZipReady = asZip ? sendBackZipInChunks(port) : null;
          filename = await downloadAudiobookYandex(bookid, maxBitRate, asZip, onProgress, onZipReady);
        } else {
          throw new Error(`Download not supported for type "${bookType}" on books.yandex.ru`);
        }
        if (filename != null) send('success', { filename });
        return;
      }

      // ── bookmate.com path ───────────────────────────────────────────────
      const cookie = (await chrome.cookies.get({ url: 'https://bookmate.com', name: 'bms' }));
      if (!cookie) throw new Error('bms cookie not found — please log in to bookmate.com first');

      let filename;
      switch (bookType) {
        case BookType.AUDIO: {
          const onZipReady = asZip
            ? sendBackZipInChunks(port)
            : null;
          filename = await downloadAudiobook(bookid, maxBitRate, asZip, onProgress, onZipReady);
          break;
        }
        case BookType.SERIAL:
          filename = await downloadSerial(bookid, stripCss, onProgress);
          break;
        case BookType.BOOK:
          filename = format === 'fb2'
            ? await downloadBookFb2(bookid, onProgress)
            : await downloadBook(bookid, stripCss, onProgress);
          break;
        default:
          throw new Error(`Download not supported for book type: ${bookType}`);
      }
      // filename is null when the ZIP was streamed back via zip-chunk/zip-end;
      // the popup/content sends its own success UI after writing the file.
      if (filename != null) send('success', { filename });
    } catch (err) {
      console.error('[bookmate] Error:', err);
      send('error', { text: err.message });
    }
  });
});

/**
 * Send ZIP bytes back to the popup/content in 16 MB chunks so the
 * window-context FileSystemFileHandle can write them directly
 * 
 * @param {chrome.runtime.Port} port - The port to send messages back to
 * @returns {Function} - Async callback that accepts zipBytes
 */
function sendBackZipInChunks(port) {
  return async (zipBytes) => {
    const CHUNK = 1024 * 1024 * 16;
    const total = Math.ceil(zipBytes.byteLength / CHUNK);
    for (let i = 0; i < total; i++) {
      const slice = zipBytes.slice(i * CHUNK, (i + 1) * CHUNK);
      try { port.postMessage({ type: 'zip-chunk', seq: i, data: Array.from(slice), ln: slice.length }); }
      catch (_) { break; }
    }

    try { port.postMessage({ type: 'zip-end' }); }
    catch (_) { }
  };
}
