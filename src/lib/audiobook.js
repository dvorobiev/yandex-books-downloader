'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Audiobook download
// Fetches track playlist via the Bookmate API and triggers individual
// chrome.downloads.download() calls for each .m4a track, or packages them
// all into a single .zip file.
// ═══════════════════════════════════════════════════════════════════════════

import { buildZip } from './epub.js';
import { fetchWithCookie, blobToDataUrl, safeName, READER_BASE } from './http.js';

// ── Private helpers ──────────────────────────────────────────────────────────

/**
 * Resolve a single track's display number and direct .m4a URL.
 * Returns { num, audioUrl } where audioUrl is null if no URL is available.
 */
function resolveTrack(track, bitrate, fallbackIndex) {
  const num      = typeof track.number === 'number' ? track.number : fallbackIndex + 1;
  const rawUrl   = track?.offline?.[bitrate]?.url ?? null;
  const audioUrl = rawUrl ? rawUrl.replace(/\.m3u8(\?.*)?$/, '.m4a') : null;
  return { num, audioUrl };
}

/** Build the per-track base filename (without extension). */
function trackBaseName(titlePart, authorSfx, num, totalTracks) {
  return totalTracks === 1
    ? `${titlePart}${authorSfx}`
    : `${titlePart} - Chapter ${num}${authorSfx}`;
}

/**
 * Fetch audiobook title, authors and raw track list without downloading anything.
 * Used by the background service worker to report track count to the popup
 * before the user commits to a download format.
 *
 * @param {string} bookid
 * @returns {Promise<{ bookTitle: string, tracks: object[], titlePart: string, authorSfx: string }>
 */
export async function fetchAudiobookMeta(bookid) {
  const [infoResp, playlistResp] = await Promise.all([
    fetchWithCookie(`${READER_BASE}/p/api/v5/audiobooks/${bookid}`),
    fetchWithCookie(`${READER_BASE}/p/api/v5/audiobooks/${bookid}/playlists.json`),
  ]);
  const info     = await infoResp.json();
  const playlist = await playlistResp.json();

  const bookTitle = info?.audiobook?.title || bookid;
  const bookAuthors = info?.audiobook?.authors || [];
  const titlePart = safeName(bookTitle);
  const authorSfx = bookAuthors.length ? ` - ${safeName(bookAuthors.map(a => a.name).join(', '))}` : '';

  return {
    bookTitle: bookTitle,
    tracks: playlist?.tracks || [],
    titlePart: titlePart,
    authorSfx: authorSfx,
  };
}

/**
 * Download an audiobook.
 *
 * When asZip is false (default):
 *   Triggers one chrome.downloads.download() per track — files land in the
 *   browser's default download folder individually.
 *
 * When asZip is true:
 *   Fetches every .m4a track as a binary blob, packs them into a ZIP archive
 *   (stored, no compression — audio is already compressed).
 *   If onZipReady is provided the raw bytes are handed to that callback
 *   (caller is responsible for saving — used to stream bytes back to the
 *   popup/content window where FileSystemFileHandle can be used directly).
 *   Otherwise falls back to the data-URL + chrome.downloads path.
 *
 * Filename rules:
 *   • 1 track  → "{title} - {author}.m4a"  (or .zip)
 *   • N tracks → individual: "{title} - Chapter {N} - {author}.m4a"
 *               zip:         "{title} - {author}.zip"
 *
 * @param {string}            bookid
 * @param {boolean}           maxBitRate   – true = max_bit_rate, false = min_bit_rate
 * @param {boolean}           asZip        – true = bundle all tracks into one .zip
 * @param {Function}          onProgress   – (text: string, pct: number) => void
 * @param {Function|null}     onZipReady   – async (zipBytes: Uint8Array, zipName: string) => void
 *                                           When provided, called with the finished ZIP bytes
 *                                           instead of triggering chrome.downloads.
 *                                           downloadAudiobook returns null in this case so the
 *                                           background knows not to send a separate 'success'.
 * @returns {Promise<string|null>}  – filename summary, or null when onZipReady handled saving
 */
export async function downloadAudiobook(bookid, maxBitRate, asZip, onProgress, onZipReady = null) {
  // ── 1. Fetch audiobook info + playlist ────────────────────────────────
  onProgress('Fetching audiobook info…', 5);
  const { bookTitle, tracks, titlePart, authorSfx } = await fetchAudiobookMeta(bookid);

  if (!tracks.length) throw new Error('No tracks found for this audiobook');

  onProgress(`Found ${tracks.length} track(s) — "${bookTitle}"`, 10);

  const bitrate = maxBitRate ? 'max_bit_rate' : 'min_bit_rate';

  // 2a. ZIP download — fetch all tracks, pack into one archive
  if (asZip) {
    return await downloadAudiobookAsZip(tracks, bitrate, onProgress, titlePart, authorSfx, onZipReady);
  }

  // 2b. Individual file download — trigger one chrome.downloads call per track
  return await downloadAudiobookIndividual(tracks, bitrate, onProgress, titlePart, authorSfx);

}

/**
 * Download an audiobook as individual files.
 * 
 * @param {Array<Object>} tracks - Array of track objects from fetchAudiobookMeta
 * @param {string} bitrate - 'max_bit_rate' or 'min_bit_rate'
 * @param {Function} onProgress - Callback for progress updates
 * @param {string} titlePart - Sanitized book title
 * @param {string} authorSfx - Author suffix for filenames
 * @returns {Promise<string|null>} - Filename summary, or null when onZipReady handled saving
 */
async function downloadAudiobookIndividual(tracks, bitrate, onProgress, titlePart, authorSfx) {
  const savedNames = [];

  for (let i = 0; i < tracks.length; i++) {
    const { num, audioUrl } = resolveTrack(tracks[i], bitrate, i);
    const pct = 10 + Math.round(((i + 1) / tracks.length) * 85);
    onProgress(`Downloading track ${num}/${tracks.length}…`, pct);

    if (!audioUrl) {
      console.warn(`[bookmate] No ${bitrate} URL for track ${num} — skipping`);
      continue;
    }

    const filename = `${trackBaseName(titlePart, authorSfx, num, tracks.length)}.m4a`;
    await chrome.downloads.download({ url: audioUrl, filename, saveAs: false });
    savedNames.push(filename);
  }

  if (!savedNames.length) throw new Error('No tracks could be downloaded');

  return savedNames.length === 1
    ? savedNames[0]
    : `${savedNames.length} tracks for "${bookTitle}"`;
}

/**
 * Download an audiobook as a ZIP archive.
 *
 * @param {Array<Object>} tracks - Array of track objects from fetchAudiobookMeta
 * @param {string} bitrate - 'max_bit_rate' or 'min_bit_rate'
 * @param {Function} onProgress - Callback for progress updates
 * @param {string} titlePart - Sanitized book title
 * @param {string} authorSfx - Author suffix for filenames
 * @param {Function|null} onZipReady - Callback for streaming ZIP bytes
 * @returns {Promise<string|null>} - Filename summary, or null when onZipReady handled saving
 */
async function downloadAudiobookAsZip(tracks, bitrate, onProgress, titlePart, authorSfx, onZipReady) {
  const zipFiles = [];

  for (let i = 0; i < tracks.length; i++) {
    const { num, audioUrl } = resolveTrack(tracks[i], bitrate, i);
    const pct = 10 + Math.round(((i + 1) / tracks.length) * 80);
    onProgress(`Fetching track ${num}/${tracks.length}…`, pct);

    if (!audioUrl) {
      console.warn(`[bookmate] No ${bitrate} URL for track ${num} — skipping`);
      continue;
    }

    const resp = await fetchWithCookie(audioUrl);
    const data = new Uint8Array(await resp.arrayBuffer());
    zipFiles.push({ name: `${trackBaseName(titlePart, authorSfx, num, tracks.length)}.m4a`, data });
  }

  if (!zipFiles.length) throw new Error('No tracks could be downloaded');

  onProgress('Building ZIP archive…', 92);
  const zipBytes = buildZip(zipFiles);

  onProgress('Saving ZIP…', 97);

  // Hand bytes back to the caller (popup/content window context) which
  // writes them via FileSystemFileHandle
  await onZipReady(zipBytes);

  return null;
}

