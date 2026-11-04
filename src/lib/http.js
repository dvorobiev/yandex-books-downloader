'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Shared HTTP / file utilities — imported by bookmate.js and audiobook.js
// ═══════════════════════════════════════════════════════════════════════════

export const READER_BASE = 'https://reader.bookmate.com';

export async function fetchWithCookie(url) {
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp;
}

/**
 * Convert a Blob to a data-URL via FileReader.
 * Needed because chrome.downloads.download() does not accept blob: URLs
 * from service workers.
 */
export async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

/**
 * Sanitise a string for use as part of a filename.
 * Removes characters forbidden on Windows / macOS / Linux.
 */
export function safeName(s) {
  return String(s).replace(/[/\\?%*:|"<>]/g, '_').trim();
}
