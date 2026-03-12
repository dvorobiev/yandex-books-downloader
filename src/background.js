'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Message handling (long-lived port from popup)
// ═══════════════════════════════════════════════════════════════════════════

import { downloadBook, downloadSerial } from './lib/bookmate.js';
import { downloadAudiobook, fetchAudiobookMeta } from './lib/audiobook.js';
import { BookType } from './lib/booktype.js';

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
        const cookie = await chrome.cookies.get({ url: 'https://bookmate.com', name: 'bms' });
        if (!cookie) throw new Error('bms cookie not found — please log in to bookmate.com first');
        const { bookTitle, tracks, titlePart, authorSfx } = await fetchAudiobookMeta(msg.bookid);
        send('audiobook-meta', { trackCount: tracks.length, title: bookTitle, titlePart, authorSfx });
      } catch (err) {
        console.error('[bookmate] Error:', err);
        send('error', { text: err.message });
      }
      return;
    }

    if (msg.action !== 'download') return;

    const { bookid, bookType, stripCss, maxBitRate, asZip = false } = msg;

    try {
      // Check if user is logged in
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
          filename = await downloadBook(bookid, stripCss, onProgress);
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

