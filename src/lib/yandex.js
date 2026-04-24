'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// books.yandex.ru download logic
// Uses /node-api/p/api/v5/ — no encryption, returns full ZIP from /content/v4
// ═══════════════════════════════════════════════════════════════════════════

import { buildEpub, buildZip }                   from './epub.js';
import { buildFb2 }                              from './fb2.js';
import { fixHtmlFiles, stripCssFiles }           from './bookmate.js';
import { fetchWithCookie, blobToDataUrl, safeName } from './http.js';
import { unzipAll }                              from './zipread.js';

const YANDEX_API = 'https://books.yandex.ru/node-api/p/api/v5';
const ENC        = new TextEncoder();
const DEC        = new TextDecoder('utf-8');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif']);

function extOf(name) {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

// ── Shared helpers ───────────────────────────────────────────────────────────

async function fetchBookMeta(bookid, apiType = 'books') {
  const resp = await fetchWithCookie(`${YANDEX_API}/${apiType}/${bookid}?lang=ru`);
  if (!resp.ok) throw new Error(`books.yandex.ru returned ${resp.status} — are you logged in?`);
  const info     = await resp.json();
  const bookData = info?.book || info?.comicbook || info?.[apiType.replace(/s$/, '')] || {};
  const title    = bookData.title || bookid;
  const raw      = bookData.authors || [];
  const authors  = typeof raw === 'string'
    ? raw
    : raw.map(a => (typeof a === 'object' ? a.name : String(a))).join(', ');
  return { title, authors };
}

async function downloadAndUnzip(bookid, label, onProgress, apiType = 'books') {
  onProgress(`Downloading ${label}…`, 10);
  const resp = await fetchWithCookie(`${YANDEX_API}/${apiType}/${bookid}/content/v4?lang=ru`);
  if (!resp.ok) throw new Error(`Content download failed: ${resp.status}`);

  const total   = parseInt(resp.headers.get('content-length') || '0', 10);
  const reader  = resp.body.getReader();
  const chunks  = [];
  let   downloaded = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    downloaded += value.length;
    if (total) {
      const pct = Math.round(downloaded / total * 100);
      onProgress(`Downloading… ${pct}%`, 10 + Math.round(downloaded / total * 38));
    }
  }

  onProgress('Unpacking…', 50);
  return unzipAll(await new Blob(chunks).arrayBuffer());
}

async function saveBlob(data, filename, mimeType) {
  const blob = new Blob([data], { type: mimeType });
  const url  = await blobToDataUrl(blob);
  await chrome.downloads.download({ url, filename, saveAs: false });
}

// ── Book download ────────────────────────────────────────────────────────────

export async function downloadBookYandex(bookid, stripCss, onProgress) {
  onProgress('Fetching book info…', 5);
  const { title, authors } = await fetchBookMeta(bookid);

  const entries = await downloadAndUnzip(bookid, 'EPUB', onProgress);

  onProgress('Fixing XHTML…', 70);
  const contentFiles = {};
  for (const [name, data] of Object.entries(entries)) {
    if (name === 'mimetype') continue;
    contentFiles[name] = data;
  }
  fixHtmlFiles(contentFiles);
  if (stripCss) stripCssFiles(contentFiles);

  onProgress('Building EPUB…', 88);
  const files = [
    { name: 'mimetype', data: ENC.encode('application/epub+zip') },
    ...Object.entries(contentFiles).map(([name, data]) => ({ name, data })),
  ];
  const epubBytes = await buildEpub(files);

  onProgress('Saving…', 97);
  const filename = `${safeName(authors ? `${title} - ${authors}` : title)}.epub`;
  await saveBlob(epubBytes, filename, 'application/epub+zip');
  return filename;
}

export async function downloadBookFb2Yandex(bookid, onProgress) {
  onProgress('Fetching book info…', 5);
  const { title, authors } = await fetchBookMeta(bookid);

  const entries = await downloadAndUnzip(bookid, 'EPUB', onProgress);

  onProgress('Fixing XHTML…', 70);
  const contentFiles = {};
  for (const [name, data] of Object.entries(entries)) {
    if (name === 'mimetype') continue;
    contentFiles[name] = data;
  }
  fixHtmlFiles(contentFiles);

  const opfKey = Object.keys(contentFiles).find((key) => key.toLowerCase().endsWith('.opf'));
  if (!opfKey) throw new Error('OPF file not found in downloaded EPUB');

  onProgress('Converting to FB2…', 88);
  const fb2Bytes = buildFb2({
    title,
    authors,
    opfDir: opfKey.replace(/[^/]+$/, ''),
    opfText: DEC.decode(contentFiles[opfKey]),
    contentFiles,
  });

  onProgress('Saving…', 97);
  const filename = `${safeName(authors ? `${title} - ${authors}` : title)}.fb2`;
  await saveBlob(fb2Bytes, filename, 'application/x-fictionbook+xml');
  return filename;
}

// ── Audiobook download ───────────────────────────────────────────────────────

export async function fetchAudiobookMetaYandex(bookid) {
  const [infoResp, playlistResp] = await Promise.all([
    fetchWithCookie(`${YANDEX_API}/audiobooks/${bookid}?lang=ru`),
    fetchWithCookie(`${YANDEX_API}/audiobooks/${bookid}/playlists.json?lang=ru`),
  ]);
  if (!infoResp.ok) throw new Error(`Audiobook info failed: ${infoResp.status} — are you logged in?`);
  if (!playlistResp.ok) throw new Error(`Playlist fetch failed: ${playlistResp.status}`);

  const info     = await infoResp.json();
  const playlist = await playlistResp.json();

  const bookData  = info?.audiobook || info?.book || {};
  const bookTitle = bookData.title || bookid;
  const rawAuth   = bookData.authors || [];
  const titlePart = safeName(bookTitle);
  const authorSfx = rawAuth.length
    ? ` - ${safeName(rawAuth.map(a => (typeof a === 'object' ? a.name : String(a))).join(', '))}`
    : '';

  return { bookTitle, tracks: playlist?.tracks || [], titlePart, authorSfx };
}

export async function downloadAudiobookYandex(bookid, maxBitRate, asZip, onProgress, onZipReady = null) {
  onProgress('Fetching audiobook info…', 5);
  const { bookTitle, tracks, titlePart, authorSfx } = await fetchAudiobookMetaYandex(bookid);
  if (!tracks.length) throw new Error('No tracks found for this audiobook');
  onProgress(`Found ${tracks.length} track(s) — "${bookTitle}"`, 10);

  const bitrate = maxBitRate ? 'max_bit_rate' : 'min_bit_rate';

  function resolveUrl(track, idx) {
    const num    = typeof track.number === 'number' ? track.number : idx + 1;
    const rawUrl = track?.offline?.[bitrate]?.url ?? null;
    const url    = rawUrl ? rawUrl.replace(/\.m3u8(\?.*)?$/, '.m4a') : null;
    return { num, url };
  }

  function trackName(num) {
    return tracks.length === 1
      ? `${titlePart}${authorSfx}`
      : `${titlePart} - Chapter ${num}${authorSfx}`;
  }

  if (asZip && onZipReady) {
    const zipFiles = [];
    for (let i = 0; i < tracks.length; i++) {
      const { num, url } = resolveUrl(tracks[i], i);
      onProgress(`Fetching track ${num}/${tracks.length}…`, 10 + Math.round((i + 1) / tracks.length * 80));
      if (!url) continue;
      const resp = await fetch(url); // CDN auth is JWT-in-URL, no cookies needed
      zipFiles.push({ name: `${trackName(num)}.m4a`, data: new Uint8Array(await resp.arrayBuffer()) });
    }
    if (!zipFiles.length) throw new Error('No tracks could be downloaded');
    const { buildZip } = await import('./epub.js');
    onProgress('Building ZIP…', 92);
    await onZipReady(buildZip(zipFiles));
    return null;
  }

  // Individual downloads
  const saved = [];
  for (let i = 0; i < tracks.length; i++) {
    const { num, url } = resolveUrl(tracks[i], i);
    onProgress(`Downloading track ${num}/${tracks.length}…`, 10 + Math.round((i + 1) / tracks.length * 85));
    if (!url) continue;
    const filename = `${trackName(num)}.m4a`;
    await chrome.downloads.download({ url, filename, saveAs: false });
    saved.push(filename);
  }
  if (!saved.length) throw new Error('No tracks could be downloaded');
  return saved.length === 1 ? saved[0] : `${saved.length} tracks for "${bookTitle}"`;
}

// ── Comicbook download ───────────────────────────────────────────────────────

export async function downloadComicYandex(bookid, onProgress) {
  onProgress('Fetching comic info…', 5);
  const { title, authors } = await fetchBookMeta(bookid, 'comicbooks');

  const entries = await downloadAndUnzip(bookid, 'comic', onProgress, 'comicbooks');

  // Detect format: if ZIP has HTML files → EPUB; if only images → CBZ
  const names     = Object.keys(entries);
  const hasHtml   = names.some(n => /\.x?html?$/i.test(n));
  const imageFiles = names
    .filter(n => IMAGE_EXTS.has(extOf(n)))
    .sort(); // alphabetical order = reading order for CBZ

  if (!hasHtml && imageFiles.length > 0) {
    // Pure image archive → CBZ (ZIP of images in reading order, stored = no recompression)
    onProgress(`Packaging ${imageFiles.length} pages as CBZ…`, 80);
    const pages    = imageFiles.map(name => ({ name, data: entries[name] }));
    const cbzBytes = buildZip(pages);
    onProgress('Saving…', 97);
    const filename = `${safeName(authors ? `${title} - ${authors}` : title)}.cbz`;
    await saveBlob(cbzBytes, filename, 'application/vnd.comicbook+zip');
    return filename;
  }

  // Has HTML → treat as EPUB (same path as books)
  onProgress('Fixing XHTML…', 70);
  const contentFiles = {};
  for (const [name, data] of Object.entries(entries)) {
    if (name === 'mimetype') continue;
    contentFiles[name] = data;
  }
  fixHtmlFiles(contentFiles);

  onProgress('Building EPUB…', 88);
  const files = [
    { name: 'mimetype', data: ENC.encode('application/epub+zip') },
    ...Object.entries(contentFiles).map(([name, data]) => ({ name, data })),
  ];
  const epubBytes = await buildEpub(files);

  onProgress('Saving…', 97);
  const filename = `${safeName(authors ? `${title} - ${authors}` : title)}.epub`;
  await saveBlob(epubBytes, filename, 'application/epub+zip');
  return filename;
}
