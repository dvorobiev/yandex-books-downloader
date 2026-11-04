'use strict';

// Keep in sync with lib/booktype.js and popup.js
const BookType = Object.freeze({
  BOOK:      'book',
  SERIAL:    'serial',
  AUDIO:     'audio',
  COMICBOOK: 'comicbook',
  SERIES:    'series',
});

const ICON_DOWNLOAD = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor">
  <path d="M12 16.5l-5-5h3.5V5h3v6.5H17l-5 5zm-7 2.5h14v1.5H5V19z"/>
</svg>`;
const ICON_DOWNLOADING = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor">
  <style>
    .arrow {
      animation: download-sink 1.5s ease-in-out infinite;
    }

    @keyframes download-sink {
      0%, 100% {
        transform: translateY(0);
      }
      50% {
        transform: translateY(2px);
      }
    }
  </style>
  <path class="arrow" d="M12 16.5l-5-5h3.5V5h3v6.5H17l-5 5z"/>
  <path d="M5 19h14v1.5H5V19z"/>
</svg>`

function ensureStyles() {
  if (document.getElementById('bm-dl-styles')) return;
  const style = document.createElement('style');
  style.id = 'bm-dl-styles';
  // Blend with the existing <a class="add-button__link"> style; reset button defaults
  style.textContent = `
    #bm-dl-btn {
      cursor: pointer;
      border: none;
      padding: inherit;
      white-space: nowrap;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      line-height: 1;
      width: 48px;
      height: 48px;
    }
    #bm-dl-choice {
      position: absolute;
      z-index: 9999;
      background: #3456f3;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.5);
      white-space: nowrap;
    }
    #bm-dl-choice span {
      font-size: 12px;
      color: #ffffff;
      padding: 0 2px;
    }
    .bm-dl-choice-btn {
      padding: 5px 10px;
      background: #f4f2ef;
      color: #3456f3;
      font-size: 12px;
      font-weight: 600;
      border: none;
      cursor: pointer;
    }
    .bm-dl-choice-btn:hover { 
      color: #f4f2ef;
      background: #3456f3;
    }
    #bm-dl-toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 2147483647;
      width: 300px;
      background: #1a1a2e;
      border: 1px solid #3a3a5c;
      border-radius: 8px;
      box-shadow: 0 6px 24px rgba(0,0,0,0.6);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 12px;
      color: #e0e0e0;
      overflow: hidden;
      opacity: 0;
      transform: translateY(12px);
      transition: opacity 0.2s ease, transform 0.2s ease;
      pointer-events: none;
    }
    #bm-dl-toast.bm-dl-toast-visible {
      opacity: 1;
      transform: translateY(0);
      pointer-events: auto;
    }
    #bm-dl-toast-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px 6px;
      font-size: 11px;
      font-weight: 600;
      color: #a0a0b0;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border-bottom: 1px solid #3a3a5c;
    }
    #bm-dl-toast-close {
      background: none;
      border: none;
      color: #a0a0b0;
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      padding: 0 2px;
    }
    #bm-dl-toast-close:hover { color: #e0e0e0; }
    #bm-dl-toast-progress-wrap {
      height: 3px;
      background: #0f0f23;
    }
    #bm-dl-toast-progress-bar {
      height: 100%;
      width: 0%;
      background: #6c63ff;
      transition: width 0.3s ease;
    }
    #bm-dl-toast-log {
      padding: 8px 10px;
      max-height: 120px;
      overflow-y: auto;
      line-height: 1.6;
    }
    .bm-dl-log-info    { color: #c0c0d0; }
    .bm-dl-log-success { color: #6bffb8; }
    .bm-dl-log-error   { color: #ff6b6b; }
  `;
  document.head.appendChild(style);
}

// ── Toast notification ──────────────────────────────────────────────────

function getOrCreateToast() {
  let toast = document.getElementById('bm-dl-toast');
  if (toast) return toast;

  toast = document.createElement('div');
  toast.id = 'bm-dl-toast';
  toast.innerHTML = `
    <div id="bm-dl-toast-header">
      <span>Bookmate Downloader</span>
      <button id="bm-dl-toast-close" title="Dismiss">&times;</button>
    </div>
    <div id="bm-dl-toast-progress-wrap">
      <div id="bm-dl-toast-progress-bar"></div>
    </div>
    <div id="bm-dl-toast-log"></div>
  `;
  document.body.appendChild(toast);

  document.getElementById('bm-dl-toast-close').addEventListener('click', () => {
    toast.classList.remove('bm-dl-toast-visible');
  });

  return toast;
}

const toast = {
  show() {
    ensureStyles();
    const el = getOrCreateToast();
    // Clear previous log and reset progress
    document.getElementById('bm-dl-toast-log').innerHTML = '';
    document.getElementById('bm-dl-toast-progress-bar').style.width = '0%';
    el.classList.add('bm-dl-toast-visible');
  },
  hide() {
    document.getElementById('bm-dl-toast')?.classList.remove('bm-dl-toast-visible');
  },
  log(text, type = 'info') {
    const log = document.getElementById('bm-dl-toast-log');
    if (!log) return;
    const line = document.createElement('div');
    line.className = `bm-dl-log-${type}`;
    line.textContent = text;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  },
  setProgress(pct) {
    const bar = document.getElementById('bm-dl-toast-progress-bar');
    if (bar) bar.style.width = `${Math.min(100, pct)}%`;
  },
};

// ── Page button ───────────────────────────────────────────────────────────
/** Remove a choice panel and restore the wrapper’s inline styles. */
function dismissPanel(panel, wrapper) {
  panel.remove();
  wrapper.style.position      = '';
  wrapper.style.overflow      = '';
  wrapper.style.verticalAlign = '';
}

/**
 * Show the ZIP-vs-individual-files choice panel anchored below the wrapper.
 * Calls onChoose(asZip) when the user picks an option, or onCancel() on
 * an outside click.
 */
function showChoicePanel(trackCount, wrapper, btn, onChoose, onCancel) {
  const panel = document.createElement('div');
  panel.id = 'bm-dl-choice';

  const label = document.createElement('span');
  label.textContent = `${trackCount} chapters — save as:`;

  const btnFiles = document.createElement('button');
  btnFiles.className   = 'bm-dl-choice-btn';
  btnFiles.textContent = 'Individual files';

  const btnZip = document.createElement('button');
  btnZip.className   = 'bm-dl-choice-btn';
  btnZip.textContent = 'ZIP archive';

  panel.appendChild(label);
  panel.appendChild(btnFiles);
  panel.appendChild(btnZip);

  wrapper.style.position      = 'relative';
  wrapper.style.overflow      = 'visible';
  wrapper.style.verticalAlign = 'top';
  wrapper.appendChild(panel);

  btnFiles.addEventListener('click', () => { dismissPanel(panel, wrapper); onChoose(false); });
  btnZip.addEventListener('click',   () => { dismissPanel(panel, wrapper); onChoose(true);  });

  function onOutside(e) {
    if (!panel.contains(e.target) && e.target !== btn) {
      dismissPanel(panel, wrapper);
      onCancel();
      document.removeEventListener('click', onOutside, true);
    }
  }
  document.addEventListener('click', onOutside, true);
}

function injectButton(bookid, bookType) {
  if (document.getElementById('bm-dl-btn')) return true; // already present

  let container = document.querySelector('.buttons-row__container, [class*="buttons-row"], [class*="ButtonsRow"], [class*="BookCard_actions"], [class*="book-actions"], [class*="BookHeader_actions"]');
  if (!container) {
    const readBtn = document.querySelector('a[href*="/read/"], a[href*="/listen/"], [class*="add-button"]');
    if (readBtn && readBtn.parentElement) {
      container = readBtn.parentElement;
    }
  }
  if (!container) return false; // container not rendered yet

  ensureStyles();

  // Mirror the structure of the existing read button wrapper
  const wrapper = document.createElement('div');
  wrapper.className = 'add-button';

  const btn = document.createElement('button');
  btn.id = 'bm-dl-btn';
  btn.className = 'add-button__link';
  btn.innerHTML = ICON_DOWNLOAD;

  wrapper.appendChild(btn);
  container.appendChild(wrapper);

  btn.addEventListener('click', async () => {
    let state = 'initial';
    let pendingFileHandle = null; // FileSystemFileHandle for zip-chunk/zip-end
    let pendingFileWriter = null;
    let savedFilename = null;
    btn.disabled = true;
    btn.innerHTML = ICON_DOWNLOADING;
    btn.style.opacity = '0.45';

    toast.show();

    const { stripCss, maxBitRate } = await chrome.storage.sync.get({ stripCss: false, maxBitRate: true });

    const port = chrome.runtime.connect({ name: 'bookmate-download' });

    function resetBtn() {
      btn.innerHTML = ICON_DOWNLOAD;
      btn.style.opacity = '1';
      btn.disabled = false;
    }

    function startDownload(asZip = false) {
      port.postMessage({ action: 'download', bookid, bookType, asZip, stripCss, maxBitRate, source: window.location.hostname });
    }

    port.onMessage.addListener(async (msg) => {
      if (msg.type === 'progress') {
        if (msg.type !== state) {
          btn.innerHTML = ICON_DOWNLOADING;
          btn.style.opacity = '0.45';
        }

        toast.log(msg.text, 'info');
        if (typeof msg.pct === 'number') toast.setProgress(msg.pct);
      }

      if (msg.type === 'zip-chunk') {
        try {
          if (!pendingFileWriter) throw new Error('ZIP file is not open for writing');
          await pendingFileWriter.write(new Uint8Array(msg.data));
          port.postMessage({ action: 'zip-ack', seq: msg.seq });
        } catch (err) {
          port.postMessage({ action: 'zip-fail', seq: msg.seq, text: err.message });
        }
      }

      if (msg.type === 'zip-end') {
        const writer = pendingFileWriter;
        pendingFileWriter = null;
        pendingFileHandle = null;
        (async () => {
          try {
            if (!writer) throw new Error('ZIP file writer was closed unexpectedly');
            await writer.close();
            resetBtn();
            toast.setProgress(100);
            toast.log(`✓ Saved as: ${savedFilename ?? msg.filename}`, 'success');
            setTimeout(() => toast.hide(), 6000);
          } catch (err) {
            resetBtn();
            toast.log(`✗ Failed to write file: ${err.message}`, 'error');
          }
        })();
      }

      if (msg.type === state) return;
      state = msg.type;

      if (msg.type === 'audiobook-meta') {
        // Got track count — decide immediately or show choice UI
        if (msg.trackCount === 1) {
          startDownload(false);
          return;
        }

        showChoicePanel(
          msg.trackCount, wrapper, btn,
          async (asZip) => {
            state = 'initial';
            if (!asZip) {
              startDownload(false);
              return;
            }

            pendingFileHandle = null;
            try {
              pendingFileHandle = await window.showSaveFilePicker({
                suggestedName: `${msg.titlePart}${msg.authorSfx}.zip`,
                types: [{ description: 'ZIP Archive', accept: { 'application/zip': ['.zip'] } }],
              });
              pendingFileWriter = await pendingFileHandle.createWritable();
              savedFilename = (await pendingFileHandle.getFile()).name;
            } catch (err) {
              if (err.name === 'AbortError') { resetBtn(); return; }
              toast.log(`Could not open save dialog: ${err.message}`, 'error');
              resetBtn();
              return;
            }
            startDownload(true);
          },
          () => resetBtn(),
        );
        return;
      }

      if (msg.type === 'progress') {
        btn.innerHTML = ICON_DOWNLOADING;
        btn.style.opacity = '0.45';
        toast.log(msg.text, 'info');
        if (typeof msg.pct === 'number') toast.setProgress(msg.pct);
      } else if (msg.type === 'success') {
        resetBtn();
        toast.setProgress(100);
        toast.log(`✓ Saved as: ${msg.filename}`, 'success');
        // Auto-dismiss after 6 s so the user can read the filename
        setTimeout(() => toast.hide(), 6000);
      } else if (msg.type === 'error') {
        resetBtn();
        if (pendingFileWriter) {
          pendingFileWriter.abort().catch(() => {});
          pendingFileWriter = null;
          pendingFileHandle = null;
        }
        toast.log(`✗ ${msg.text}`, 'error');
      }
    });

    port.onDisconnect.addListener(() => {
      // Service worker was killed mid-download (e.g. browser idle timeout)
      if (btn.disabled) {
        resetBtn();
        toast.log('✗ Connection lost — service worker was restarted', 'error');
      }
    });

    // Kick off: audiobooks check track count first, everything else downloads directly
    if (bookType === BookType.AUDIO) {
      port.postMessage({ action: 'audiobook-meta', bookid, source: window.location.hostname });
    } else {
      startDownload();
    }
  });

  return true;
}

// Book-ID regex — keep in sync with popup.js
// Matches /books/{id}, /serials/{id}, /audiobooks/{id}, /comicbooks/{id}, /series/{id}
// Works for both bookmate.com and books.yandex.ru (same URL structure)
function parseBookUrl(urlStr) {
  if (!urlStr) return null;
  try {
    const urlObj = new URL(urlStr);
    const pathname = urlObj.pathname;
    const match = pathname.match(/\/(books?|audiobooks?|serials?|comicbooks?|series|read|listen|reader|audio)\/([A-Za-z0-9_-]{4,64})/i);

    if (!match) {
      const qId = urlObj.searchParams.get('id') || urlObj.searchParams.get('bookid');
      if (qId && /^[A-Za-z0-9_-]{4,64}$/.test(qId)) {
        return { bookid: qId, bookType: pathname.includes('audio') ? BookType.AUDIO : BookType.BOOK };
      }
      return null;
    }

    const category = match[1].toLowerCase();
    const bookid = match[2];

    let bookType = BookType.BOOK;
    if (category.startsWith('audio') || category === 'listen') {
      bookType = BookType.AUDIO;
    } else if (category.startsWith('serial')) {
      bookType = BookType.SERIAL;
    } else if (category.startsWith('comic')) {
      bookType = BookType.COMICBOOK;
    } else if (category === 'series') {
      bookType = BookType.SERIES;
    } else {
      bookType = BookType.BOOK;
    }

    return { bookid, bookType };
  } catch (e) {
    return null;
  }
}

let pendingObserver = null;

function handleUrl(url) {
  if (pendingObserver) {
    pendingObserver.disconnect();
    pendingObserver = null;
  }

  const parsed = parseBookUrl(url);
  if (!parsed) return;

  const { bookid, bookType } = parsed;
  if (bookType === BookType.COMICBOOK || bookType === BookType.SERIES) return;

  if (injectButton(bookid, bookType)) return;

  pendingObserver = new MutationObserver(() => {
    if (injectButton(bookid, bookType)) {
      pendingObserver.disconnect();
      pendingObserver = null;
    }
  });
  pendingObserver.observe(document.body, { childList: true, subtree: true });
}

// Navigation API fires for pushState / replaceState / back / forward (Chrome 102+)
if (window.navigation) {
  window.navigation.addEventListener('navigatesuccess', (e) => handleUrl(window.location.href));
}

// Handle whichever page the content script was injected into at load time
handleUrl(location.href);
