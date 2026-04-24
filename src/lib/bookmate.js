'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Bookmate download logic
// ═══════════════════════════════════════════════════════════════════════════

import { buildEpub } from './epub.js';
import { buildFb2 } from './fb2.js';
import { decryptValue, extractClientParams } from './decrypt.js';
import { mergeEpisodes } from './merge.js';
import { fetchWithCookie, blobToDataUrl, safeName, READER_BASE } from './http.js';

const ENC = new TextEncoder();

// ── Private helpers ──────────────────────────────────────────────────────────

/** Decrypt all array-valued fields in an encrypted metadata response. */
async function decryptMeta(secret, encMeta) {
  const meta = {};
  for (const [key, val] of Object.entries(encMeta)) {
    meta[key] = Array.isArray(val) ? await decryptValue(secret, val) : val;
  }
  return meta;
}

/**
 * Extract OEBPS content file hrefs from OPF XML.
 * DOMParser is unavailable in service workers — uses regex instead.
 */
function parseOpfHrefs(opfText) {
  return [...opfText.matchAll(/<item\b[^>]*\bhref="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((href) => href && href !== 'toc.ncx');
}

/**
 * Sequentially download OEBPS content files, reporting progress between
 * pctStart and pctEnd.  Returns a plain object: fname → Uint8Array.
 */
async function downloadContentFiles(items, baseUrl, onProgress, pctStart, pctEnd) {
  const contentFiles = {};
  for (let i = 0; i < items.length; i++) {
    const fname = items[i];
    const pct   = pctStart + Math.round((i / items.length) * (pctEnd - pctStart));
    onProgress(`  [${i + 1}/${items.length}] ${fname}`, pct);
    try {
      const r = await fetchWithCookie(baseUrl + fname);
      contentFiles[fname] = new Uint8Array(await r.arrayBuffer());
    } catch (err) {
      console.warn(`Could not download ${fname}:`, err);
    }
  }
  return contentFiles;
}

const REQUIRED_META_NS = [
  'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
  'xmlns:opf="http://www.idpf.org/2007/opf"',
  'xmlns:dcterms="http://purl.org/dc/terms/"',
  'xmlns:calibre="http://calibre.kovidgoyal.net/2009/metadata"',
  'xmlns:dc="http://purl.org/dc/elements/1.1/"',
];

/**
 * Ensure the <metadata> element in an OPF file carries all required namespace
 * declarations.  Missing ones are injected as extra attributes.  Returns a
 * new Uint8Array (or the original if nothing was missing).
 */
function fixOpfMetadata(opfBytes) {
  const dec = new TextDecoder('utf-8');
  let text = dec.decode(opfBytes);
  const fixed = text.replace(/<metadata\b([^>]*)>/i, (match, attrs) => {
    const missing = REQUIRED_META_NS.filter((attr) => !match.includes(attr.split('=')[0]));
    if (!missing.length) return match;
    return `<metadata${attrs} ${missing.join(' ')}>`;
  });
  return fixed === text ? opfBytes : ENC.encode(fixed);
}

/**
 * Fix HTML content files to be valid XHTML as required by EPUB readers.
 * Replaces the HTML doctype with an XML declaration and adds XHTML namespace
 * attributes to the <html> opening tag.  Mutates the map in-place.
 */
export function fixHtmlFiles(contentFiles) {
  const dec = new TextDecoder('utf-8');
  for (const fname of Object.keys(contentFiles)) {
    if (!fname.match(/\.x?html$/i)) continue;
    let text = dec.decode(contentFiles[fname]);
    text = text.replace(/<!DOCTYPE\s+html[^>]*>/i, "<?xml version='1.0' encoding='utf-8'?>");
    text = text.replace(/<html\b[^>]*>/i, '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">');
    text = text.replace(/<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)(\b[^>]*)(?<!\/)>/gi, '<$1$2/>');
    text = text.replace(/&nbsp;/g, '&#160;');
    contentFiles[fname] = ENC.encode(text);
  }
}

/** Zero out every CSS file in a content-file map (mutates in-place). */
export function stripCssFiles(contentFiles) {
  for (const fname of Object.keys(contentFiles)) {
    if (fname.toLowerCase().endsWith('.css')) contentFiles[fname] = new Uint8Array(0);
  }
}

/** Build a safe EPUB filename from title and authors. */
function buildEpubFilename(title, authors) {
  const raw = authors ? `${title} - ${authors}` : title;
  return `${safeName(raw)}.epub`;
}

/** Encode epubBytes as a data-URL and trigger a browser download. */
async function saveEpubBlob(epubBytes, filename) {
  const blob = new Blob([epubBytes], { type: 'application/epub+zip' });
  const url  = await blobToDataUrl(blob);
  await chrome.downloads.download({ url, filename, saveAs: false });
}

export async function downloadBook(bookid, stripCss, onProgress) {
  // 1. Fetch reader page → extract secret
  onProgress('Fetching reader page…', 5);
  const pageResp = await fetchWithCookie(`${READER_BASE}/${bookid}`);
  const secret   = extractClientParams(await pageResp.text()).secret;
  if (!secret) throw new Error('Could not extract secret from page');

  // 2. Fetch encrypted metadata + book info in parallel
  onProgress('Fetching metadata…', 15);
  const [metaResp, bookInfoResp] = await Promise.all([
    fetchWithCookie(`${READER_BASE}/p/api/v5/books/${bookid}/metadata/v4`),
    fetchWithCookie(`${READER_BASE}/p/api/v5/books/${bookid}`),
  ]);
  const bookInfo    = await bookInfoResp.json();
  const bookTitle   = bookInfo?.book?.title   || bookid;
  const bookAuthors = bookInfo?.book?.authors || '';

  // 3. Decrypt metadata
  onProgress('Decrypting metadata…', 25);
  const meta = await decryptMeta(secret, await metaResp.json());
  meta.opf = fixOpfMetadata(meta.opf);

  // 4. Parse OPF manifest → content file list
  onProgress('Parsing OPF manifest…', 35);
  const items   = parseOpfHrefs(new TextDecoder().decode(meta.opf));
  const baseUrl = `${READER_BASE}/p/a/4/d/${meta.document_uuid}/contents/OEBPS/`;

  // 5. Download content files
  onProgress(`Downloading ${items.length} content files…`, 40);
  const contentFiles = await downloadContentFiles(items, baseUrl, onProgress, 40, 85);

  // 6. Fix HTML → XHTML and optionally strip CSS
  onProgress('Fixing HTML files…', 86);
  fixHtmlFiles(contentFiles);
  if (stripCss) { onProgress('Stripping CSS…', 87); stripCssFiles(contentFiles); }

  // 7. Assemble EPUB — mimetype MUST be first and MUST be ZIP_STORED (EPUB spec)
  onProgress('Building EPUB…', 90);
  const files = [
    { name: 'mimetype',               data: ENC.encode('application/epub+zip') },
    { name: 'META-INF/container.xml', data: meta.container },
    { name: 'OEBPS/content.opf',      data: meta.opf },
    { name: 'OEBPS/toc.ncx',          data: meta.ncx },
    ...Object.entries(contentFiles).map(([fname, data]) => ({ name: `OEBPS/${fname}`, data })),
  ];
  const epubBytes = await buildEpub(files);

  // 8. Trigger browser download
  onProgress('Saving file…', 98);
  const filename = buildEpubFilename(bookTitle, bookAuthors);
  await saveEpubBlob(epubBytes, filename);
  return filename;
}

export async function downloadBookFb2(bookid, onProgress) {
  const dec = new TextDecoder('utf-8');

  onProgress('Fetching reader page…', 5);
  const pageResp = await fetchWithCookie(`${READER_BASE}/${bookid}`);
  const secret = extractClientParams(await pageResp.text()).secret;
  if (!secret) throw new Error('Could not extract secret from page');

  onProgress('Fetching metadata…', 15);
  const [metaResp, bookInfoResp] = await Promise.all([
    fetchWithCookie(`${READER_BASE}/p/api/v5/books/${bookid}/metadata/v4`),
    fetchWithCookie(`${READER_BASE}/p/api/v5/books/${bookid}`),
  ]);
  const bookInfo = await bookInfoResp.json();
  const bookTitle = bookInfo?.book?.title || bookid;
  const bookAuthors = bookInfo?.book?.authors || '';

  onProgress('Decrypting metadata…', 25);
  const meta = await decryptMeta(secret, await metaResp.json());
  meta.opf = fixOpfMetadata(meta.opf);

  onProgress('Parsing OPF manifest…', 35);
  const items = parseOpfHrefs(dec.decode(meta.opf));
  const baseUrl = `${READER_BASE}/p/a/4/d/${meta.document_uuid}/contents/OEBPS/`;

  onProgress(`Downloading ${items.length} content files…`, 40);
  const rawContentFiles = await downloadContentFiles(items, baseUrl, onProgress, 40, 85);

  fixHtmlFiles(rawContentFiles);

  const contentFiles = {};
  for (const [fname, data] of Object.entries(rawContentFiles)) {
    contentFiles[`OEBPS/${fname}`] = data;
  }
  contentFiles['OEBPS/content.opf'] = meta.opf;

  onProgress('Converting to FB2…', 88);
  const fb2Bytes = buildFb2({
    title: bookTitle,
    authors: bookAuthors,
    opfDir: 'OEBPS/',
    opfText: dec.decode(meta.opf),
    contentFiles,
  });

  onProgress('Saving file…', 98);
  const filename = `${safeName(bookAuthors ? `${bookTitle} - ${bookAuthors}` : bookTitle)}.fb2`;
  const blob = new Blob([fb2Bytes], { type: 'application/x-fictionbook+xml' });
  const url = await blobToDataUrl(blob);
  await chrome.downloads.download({ url, filename, saveAs: false });
  return filename;
}

// ═══════════════════════════════════════════════════════════════════════════
// Serial (multi-episode) download
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Download a serialised book: fetch all episodes, merge them into one EPUB,
 * and trigger a browser download.  Mirrors Python BookDownloader._download_serial_book.
 *
 * @param {string}   bookid     - The serial's book ID (from /serials/{bookid} URL)
 * @param {boolean}  stripCss   - Zero out CSS files in the final EPUB
 * @param {Function} onProgress - (text: string, pct: number) => void
 * @returns {Promise<string>} filename of the saved .epub file
 */
export async function downloadSerial(bookid, stripCss, onProgress) {
  // 1. Fetch reader page → extract AES secret
  onProgress('Fetching reader page…', 3);
  const pageResp = await fetchWithCookie(`${READER_BASE}/${bookid}`);
  const secret   = extractClientParams(await pageResp.text()).secret;
  if (!secret) throw new Error('Could not extract secret from serial page');

  // 2. Fetch serial info + episodes list in parallel
  onProgress('Fetching serial info and episode list…', 8);
  const [bookInfoResp, episodesResp] = await Promise.all([
    fetchWithCookie(`${READER_BASE}/p/api/v5/books/${bookid}`),
    fetchWithCookie(`${READER_BASE}/p/api/v5/books/${bookid}/episodes`),
  ]);
  const bookInfo    = await bookInfoResp.json();
  const epListData  = await episodesResp.json();
  const bookTitle   = bookInfo?.book?.title   || bookid;
  const bookAuthors = bookInfo?.book?.authors || '';
  const episodes    = epListData?.episodes    || [];

  if (!episodes.length) throw new Error('No episodes found for this serial');

  // 3. Download and decrypt each episode
  const episodeData = [];
  for (let i = 0; i < episodes.length; i++) {
    const ep      = episodes[i];
    const epTitle = ep.title || ep.uuid;
    const pctBase = 10 + Math.round((i       / episodes.length) * 72);
    const pctEnd  = 10 + Math.round(((i + 1) / episodes.length) * 72);

    onProgress(`[${i + 1}/${episodes.length}] Episode: ${epTitle}`, pctBase);

    const encMetaResp = await fetchWithCookie(`${READER_BASE}/p/api/v5/books/${ep.uuid}/metadata/v4`);
    const meta        = await decryptMeta(secret, await encMetaResp.json());
    meta.opf = fixOpfMetadata(meta.opf);
    const items       = parseOpfHrefs(new TextDecoder().decode(meta.opf));
    const baseUrl     = `${READER_BASE}/p/a/4/d/${meta.document_uuid}/contents/OEBPS/`;
    const contentFiles = await downloadContentFiles(items, baseUrl, onProgress, pctBase, pctEnd);

    fixHtmlFiles(contentFiles);
    if (stripCss) stripCssFiles(contentFiles);
    episodeData.push({ title: epTitle, meta, contentFiles });
  }

  // 4. Merge all episodes into a single EPUB file list
  onProgress('Merging episodes…', 85);
  const files = mergeEpisodes(episodeData, bookTitle);

  // 5. Build EPUB
  onProgress('Building EPUB…', 92);
  const epubBytes = await buildEpub(files);

  // 6. Trigger download
  onProgress('Saving file…', 98);
  const filename = buildEpubFilename(bookTitle, bookAuthors);
  await saveEpubBlob(epubBytes, filename);
  return filename;
}
