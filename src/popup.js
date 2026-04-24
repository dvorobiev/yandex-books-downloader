'use strict';

// Keep in sync with lib/booktype.js and content.js
const BookType = Object.freeze({
  BOOK:      'book',
  SERIAL:    'serial',
  AUDIO:     'audio',
  COMICBOOK: 'comicbook',
  SERIES:    'series',
});

const stripCssCheck  = document.getElementById('strip-css');
const maxBitrateCheck = document.getElementById('max-bitrate');
const formatRow      = document.getElementById('format-row');
const fmtEpub        = document.getElementById('fmt-epub');
const fmtFb2         = document.getElementById('fmt-fb2');
const stripCssRow    = document.getElementById('strip-css-row');
const maxBitrateRow  = document.getElementById('max-bitrate-row');
const downloadBtn    = document.getElementById('download-btn');
const statusBox      = document.getElementById('status-box');
const progressWrap   = document.getElementById('progress-wrap');
const progressBar    = document.getElementById('progress-bar');

let currentBookId   = null;
let currentBookType = null;
let currentSource   = null;
let currentFormat   = 'epub';

// Variables for zip chunked download
let pendingFileHandle = null;
let pendingZipChunks  = [];
let savedFilename     = '';

function updateDownloadButtonLabel() {
  if (currentBookType === BookType.AUDIO) {
    downloadBtn.textContent = 'Download Audio';
    return;
  }
  if (currentBookType === BookType.BOOK) {
    downloadBtn.textContent = currentFormat === 'fb2' ? 'Download FB2' : 'Download EPUB';
    return;
  }
  downloadBtn.textContent = 'Download EPUB';
}

// ── Restore saved settings and read active-tab book ID ────────────────────
(async () => {
  const [tabs, { stripCss, maxBitRate, format }] = await Promise.all([
    chrome.tabs.query({ active: true, currentWindow: true }),
    chrome.storage.sync.get({ stripCss: false, maxBitRate: true, format: 'epub' }),
  ]);

  stripCssCheck.checked  = stripCss;
  maxBitrateCheck.checked = maxBitRate;
  currentFormat = format === 'fb2' ? 'fb2' : 'epub';
  fmtEpub.checked = currentFormat === 'epub';
  fmtFb2.checked = currentFormat === 'fb2';

  const url   = tabs[0]?.url || '';
  // Keep in sync with content.js BOOK_ID_RE
  const match = url.match(/\/\/(?:(?:[a-z]+\.)?bookmate\.com|books\.yandex\.ru)\/(books|serials|audiobooks|comicbooks|series)\/([A-Za-z0-9]{6,12})(?:[/?#]|$)/);
  currentSource = match ? new URL(url).hostname : null;
  currentBookId   = match ? match[2] : null;
  currentBookType = match ? {
    books:      BookType.BOOK,
    serials:    BookType.SERIAL,
    audiobooks: BookType.AUDIO,
    comicbooks: BookType.COMICBOOK,
    series:     BookType.SERIES,
  }[match[1]] : null;

  if (!currentBookId) {
    downloadBtn.disabled = true;
    downloadBtn.title    = 'Navigate to a Bookmate book, serial, or audiobook page first';
    downloadBtn.textContent = 'Navigate to a Bookmate book, serial or audiobook page first...';
    return;
  }

  if (currentBookType === BookType.AUDIO) {
    // Show audio-specific options, hide EPUB-specific ones
    stripCssRow.classList.add('hidden');
    maxBitrateRow.classList.remove('hidden');
    formatRow.classList.add('hidden');
    updateDownloadButtonLabel();
  } else if (currentBookType === BookType.COMICBOOK || currentBookType === BookType.SERIES) {
    // Unsupported types — show disabled button
    stripCssRow.classList.add('hidden');
    maxBitrateRow.classList.add('hidden');
    formatRow.classList.add('hidden');
    downloadBtn.disabled = true;
    downloadBtn.title    = 'Downloading comicbooks and series is not yet supported';
    downloadBtn.textContent = 'Not supported yet';
  } else if (currentBookType === BookType.SERIAL) {
    // Serial books remain EPUB-only
    stripCssRow.classList.remove('hidden');
    maxBitrateRow.classList.add('hidden');
    formatRow.classList.add('hidden');
    updateDownloadButtonLabel();
  } else {
    // Show book format options, hide audio-specific ones
    stripCssRow.classList.remove('hidden');
    maxBitrateRow.classList.add('hidden');
    formatRow.classList.remove('hidden');
    updateDownloadButtonLabel();
  }
})();

// ── Persist preferences whenever they change ───────────────────────────────────
stripCssCheck.addEventListener('change', () => {
  chrome.storage.sync.set({ stripCss: stripCssCheck.checked });
});

maxBitrateCheck.addEventListener('change', () => {
  chrome.storage.sync.set({ maxBitRate: maxBitrateCheck.checked });
});

document.querySelectorAll('input[name="fmt"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    currentFormat = radio.value === 'fb2' ? 'fb2' : 'epub';
    chrome.storage.sync.set({ format: currentFormat });
    updateDownloadButtonLabel();
  });
});

// ── Logging helpers ────────────────────────────────────────────────────────
function log(text, type = 'info') {
  statusBox.classList.add('visible');
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  line.textContent = text;
  statusBox.appendChild(line);
  statusBox.scrollTop = statusBox.scrollHeight;
}

function setProgress(pct) {
  progressWrap.classList.add('visible');
  progressBar.style.width = `${Math.min(100, pct)}%`;
}

function resetUI() {
  statusBox.innerHTML = '';
  statusBox.classList.remove('visible');
  progressWrap.classList.remove('visible');
  progressBar.style.width = '0%';
}

// ── Port-based communication with background service worker ───────────────
let port = null;

function ensurePort() {
  if (port) return port;
  port = chrome.runtime.connect({ name: 'bookmate-download' });

  port.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'audiobook-meta':
        handleAudiobookMeta(msg);
        break;
      case 'progress':
        log(msg.text, 'info');
        if (typeof msg.pct === 'number') setProgress(msg.pct);
        break;
      case 'zip-chunk':
        pendingZipChunks[msg.seq] = new Uint8Array(msg.data);
        break;
      case 'zip-end': {
        const handle = pendingFileHandle;
        const chunks = pendingZipChunks.slice();
        pendingFileHandle = null;
        pendingZipChunks  = [];
        (async () => {
          try {
            const writable = await handle.createWritable();
            for (const chunk of chunks) await writable.write(chunk);
            await writable.close();
            log(`✓ Saved as: ${savedFilename}`, 'success');
            setProgress(100);
          } catch (err) {
            log(`✗ Failed to write file: ${err.message}`, 'error');
          } finally {
            downloadBtn.disabled = false;
            downloadBtn.textContent = 'Download Audio';
          }
        })();
        break;
      }
      case 'success':
        log(`✓ Saved as: ${msg.filename}`, 'success');
        setProgress(100);
        downloadBtn.disabled = false;
        updateDownloadButtonLabel();
        break;
      case 'error':
        log(`✗ ${msg.text}`, 'error');
        downloadBtn.disabled = false;
        updateDownloadButtonLabel();
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    port = null;
  });

  return port;
}

/**
 * Called when the background reports track count for an audiobook.
 * If there's only one track, start downloading immediately.
 * Otherwise show a prompt with two buttons letting the user choose between
 * individual files and a single ZIP archive.
 */
function handleAudiobookMeta(msg) {
  if (msg.trackCount === 1) {
    startAudioDownload(false);
    return;
  }

  statusBox.classList.add('visible');

  const prompt = document.createElement('div');
  prompt.className = 'log-line info';
  prompt.textContent = `Book has ${msg.trackCount} chapters. Choose download format:`;
  statusBox.appendChild(prompt);

  const row = document.createElement('div');
  row.className = 'choice-row';

  const btnIndividual = document.createElement('button');
  btnIndividual.className = 'choice-btn';
  btnIndividual.textContent = 'Individual Files';

  const btnZip = document.createElement('button');
  btnZip.className = 'choice-btn';
  btnZip.textContent = 'As ZIP';

  row.appendChild(btnIndividual);
  row.appendChild(btnZip);
  statusBox.appendChild(row);
  statusBox.scrollTop = statusBox.scrollHeight;

  btnIndividual.addEventListener('click', () => { row.remove(); startAudioDownload(false); });
  btnZip.addEventListener('click',        () => { row.remove(); startAudioDownload(true, msg.titlePart || '', msg.authorSfx || ''); });
}

/** Fire the actual audio download after the user (or auto-logic) has decided on format. */
async function startAudioDownload(asZip, titlePart = '', authorSfx = '') {
  pendingFileHandle = null;

  if (asZip) {
    const suggestedName = `${titlePart}${authorSfx}.zip`;
    try {
      pendingFileHandle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'ZIP Archive', accept: { 'application/zip': ['.zip'] } }],
      });
      savedFilename = (await pendingFileHandle.getFile()).name;
    } catch (err) {
      if (err.name === 'AbortError') return;
      log(`Could not open save dialog: ${err.message}`, 'error');
      downloadBtn.disabled = false;
      downloadBtn.textContent = 'Download Audio';
      return;
    }
  }

  pendingZipChunks = [];
  downloadBtn.textContent = 'Downloading…';
  ensurePort().postMessage({
    action:     'download',
    bookid:     currentBookId,
    bookType:   currentBookType,
    format:     currentFormat,
    asZip,
    stripCss:   stripCssCheck.checked,
    maxBitRate: maxBitrateCheck.checked,
    source:     currentSource,
  });
}

// ── Download button ────────────────────────────────────────────────────────
downloadBtn.addEventListener('click', () => {
  if (!currentBookId) {
    log('Navigate to a Bookmate book, serial, or audiobook page first.', 'error');
    return;
  }

  resetUI();
  downloadBtn.disabled = true;

  if (currentBookType === BookType.AUDIO) {
    // Check track count first so we can ask about ZIP vs individual files
    downloadBtn.textContent = 'Checking tracks…';
    ensurePort().postMessage({ action: 'audiobook-meta', bookid: currentBookId, source: currentSource });
    return;
  }

  downloadBtn.textContent = 'Downloading…';
  ensurePort().postMessage({
    action:     'download',
    bookid:     currentBookId,
    bookType:   currentBookType,
    format:     currentFormat,
    stripCss:   stripCssCheck.checked,
    maxBitRate: maxBitrateCheck.checked,
    source:     currentSource,
  });
});
