'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Message handling (long-lived port from popup)
// ═══════════════════════════════════════════════════════════════════════════

import { downloadBook, downloadBookFb2, downloadSerial } from './lib/bookmate.js';
import { downloadAudiobook, fetchAudiobookMeta } from './lib/audiobook.js';
import { downloadBookFb2Yandex, downloadBookYandex, downloadComicYandex, downloadAudiobookYandex, fetchAudiobookMetaYandex } from './lib/yandex.js';
import { BookType } from './lib/booktype.js';
import { streamZip } from './lib/epub.js';

const YANDEX_HOSTS = ['books.yandex.ru', 'yandex.ru', 'books.yandex.net', 'bookmate.ru'];
function isYandexSource(source) {
  if (!source) return false;
  return YANDEX_HOSTS.some(h => source.includes(h)) || source.includes('yandex');
}

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
        if (isYandexSource(msg.source)) {
          const { bookTitle, tracks, titlePart, authorSfx } = await fetchAudiobookMetaYandex(msg.bookid);
          send('audiobook-meta', { trackCount: tracks.length, title: bookTitle, titlePart, authorSfx });
        } else {
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
      if (isYandexSource(source)) {
        let filename;
        if (bookType === BookType.BOOK) {
          filename = format === 'fb2'
            ? await downloadBookFb2Yandex(bookid, onProgress)
            : await downloadBookYandex(bookid, stripCss, onProgress);
        } else if (bookType === BookType.AUDIO) {
          const onZipReady = asZip ? sendBackZipInChunks(port) : null;
          filename = await downloadAudiobookYandex(bookid, maxBitRate, asZip, onProgress, onZipReady);
        } else {
          throw new Error(`Download not supported for type "${bookType}" on Yandex Books`);
        }
        if (filename != null) send('success', { filename });
        return;
      }

      // ── bookmate.com path ───────────────────────────────────────────────
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
 * Stream ZIP chunks to the popup/content and wait for each disk write
 * before sending the next chunk.
 * 
 * @param {chrome.runtime.Port} port - The port to send messages back to
 * @returns {Function} - Async callback that accepts zipBytes
 */
function sendBackZipInChunks(port) {
  return async (zipData) => {
    let seq = 0;
    let pendingAck = null;

    const onControlMessage = (msg) => {
      if (!pendingAck || msg.seq !== pendingAck.seq) return;
      if (msg.action === 'zip-ack') pendingAck.finish();
      if (msg.action === 'zip-fail') pendingAck.finish(new Error(msg.text || 'Could not write ZIP data'));
    };
    const onDisconnect = () => pendingAck?.finish(new Error('Connection lost while writing ZIP'));

    port.onMessage.addListener(onControlMessage);
    port.onDisconnect.addListener(onDisconnect);

    const writeChunk = async (bytes) => {
      const chunkSeq = seq++;
      const acknowledged = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingAck = null;
          reject(new Error('Timed out while writing ZIP data'));
        }, 120000);
        pendingAck = {
          seq: chunkSeq,
          finish(error) {
            clearTimeout(timer);
            pendingAck = null;
            if (error) reject(error);
            else resolve();
          },
        };
      });

      try {
        port.postMessage({ type: 'zip-chunk', seq: chunkSeq, data: Array.from(bytes) });
      } catch (error) {
        pendingAck?.finish(error);
      }
      await acknowledged;
    };

    try {
      if (zipData && typeof zipData[Symbol.asyncIterator] === 'function') {
        await streamZip(zipData, writeChunk);
      } else {
        const zipBytes = zipData instanceof Uint8Array ? zipData : new Uint8Array(zipData);
        const chunkSize = 512 * 1024;
        for (let start = 0; start < zipBytes.length; start += chunkSize) {
          await writeChunk(zipBytes.subarray(start, Math.min(start + chunkSize, zipBytes.length)));
        }
      }
      port.postMessage({ type: 'zip-end' });
    } finally {
      port.onMessage.removeListener(onControlMessage);
      port.onDisconnect.removeListener(onDisconnect);
    }
  };
}
