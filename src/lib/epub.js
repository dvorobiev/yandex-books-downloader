'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// DEFLATE via CompressionStream (built-in, no deps)
// ═══════════════════════════════════════════════════════════════════════════

import { crc32, crc32Async } from './crc32.js';

const ENC = new TextEncoder();

export async function deflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ═══════════════════════════════════════════════════════════════════════════
// ZIP / EPUB builder  (no external libraries)
// ═══════════════════════════════════════════════════════════════════════════
// The EPUB spec requires:
//   • "mimetype" is the FIRST entry and must be ZIP_STORED (method 0)
//   • Everything else may be ZIP_DEFLATE (method 8)

function u16le(view, off, val) { view.setUint16(off, val, true); }
function u32le(view, off, val) { view.setUint32(off, val, true); }

function mkLocalHeader(nameBytes, method, crc, compLen, rawLen) {
  const buf = new Uint8Array(30 + nameBytes.length);
  const v = new DataView(buf.buffer);
  u32le(v,  0, 0x04034B50); // local file header sig
  u16le(v,  4, 20);          // version needed
  u16le(v,  6, 0);           // flags
  u16le(v,  8, method);
  u32le(v, 10, 0);           // mod time/date (zeroed)
  u32le(v, 14, crc);
  u32le(v, 18, compLen);
  u32le(v, 22, rawLen);
  u16le(v, 26, nameBytes.length);
  u16le(v, 28, 0);           // extra field length
  buf.set(nameBytes, 30);
  return buf;
}

function mkCentralEntry(nameBytes, method, crc, compLen, rawLen, offset) {
  const buf = new Uint8Array(46 + nameBytes.length);
  const v = new DataView(buf.buffer);
  u32le(v,  0, 0x02014B50); // central dir sig
  u16le(v,  4, 20);          // version made by
  u16le(v,  6, 20);          // version needed
  u16le(v,  8, 0);           // flags
  u16le(v, 10, method);
  u32le(v, 12, 0);           // mod time/date
  u32le(v, 16, crc);
  u32le(v, 20, compLen);
  u32le(v, 24, rawLen);
  u16le(v, 28, nameBytes.length);
  u16le(v, 30, 0);           // extra field length
  u16le(v, 32, 0);           // comment length
  u16le(v, 34, 0);           // disk number start
  u16le(v, 36, 0);           // internal attrs
  u32le(v, 38, 0);           // external attrs
  u32le(v, 42, offset);      // relative offset of local header
  buf.set(nameBytes, 46);
  return buf;
}

function mkEndRecord(count, cdSize, cdOffset) {
  const buf = new Uint8Array(22);
  const v = new DataView(buf.buffer);
  u32le(v,  0, 0x06054B50);
  u16le(v,  4, 0);       // disk number
  u16le(v,  6, 0);       // start disk
  u16le(v,  8, count);
  u16le(v, 10, count);
  u32le(v, 12, cdSize);
  u32le(v, 16, cdOffset);
  u16le(v, 20, 0);       // comment length
  return buf;
}

function concat(arrays) {
  const total = arrays.reduce((acc, a) => acc + a.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of arrays) { out.set(a, pos); pos += a.length; }
  return out;
}

// ── ZIP assembly core ──────────────────────────────────────────────────────────────────

/**
 * Assemble local file headers, central directory, and EOCD record from an
 * array of pre-computed entries.  Shared by buildEpub and buildZip.
 *
 * @param {Array<{nameBytes:Uint8Array, method:number, crc:number, comp:Uint8Array, raw:Uint8Array}>} entries
 */
function assembleParts(entries) {
  const localBlocks  = [];
  const centralParts = [];
  let offset = 0;

  for (const e of entries) {
    const lh = mkLocalHeader(e.nameBytes, e.method, e.crc, e.comp.length, e.raw.length);
    localBlocks.push(lh, e.comp);
    centralParts.push(mkCentralEntry(e.nameBytes, e.method, e.crc, e.comp.length, e.raw.length, offset));
    offset += lh.length + e.comp.length;
  }

  const cdSize = centralParts.reduce((acc, p) => acc + p.length, 0);
  return concat([...localBlocks, ...centralParts, mkEndRecord(entries.length, cdSize, offset)]);
}

/**
 * Build an EPUB-compliant ZIP blob from an array of { name, data } entries.
 * The caller must ensure "mimetype" is the first entry.
 */
export async function buildEpub(files) {
  const entries = [];
  for (const file of files) {
    const nameBytes  = ENC.encode(file.name);
    const raw        = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
    const isMimetype = file.name === 'mimetype';
    const method     = isMimetype ? 0 : 8;
    const comp       = isMimetype ? raw : await deflateRaw(raw);
    entries.push({ nameBytes, method, crc: crc32(raw), comp, raw });
  }
  return assembleParts(entries);
}

/**
 * Build a plain ZIP blob from an array of { name, data } entries.
 * All entries are ZIP_STORED (method 0) — no compression.
 * Suitable for already-compressed binary files such as .m4a audio tracks.
 */
export function buildZip(files) {
  const entries = files.map((file) => {
    const nameBytes = ENC.encode(file.name);
    const raw       = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
    return { nameBytes, method: 0, crc: crc32(raw), comp: raw, raw };
  });
  return assembleParts(entries);
}

/** Stream a plain ZIP from an async iterable of files without assembling a second full copy. */
export async function streamZip(files, writeChunk) {
  const entries = [];
  const chunkSize = 512 * 1024;
  let offset = 0;

  for await (const file of files) {
    const nameBytes = ENC.encode(file.name);
    const raw = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
    const crc = await crc32Async(raw);
    const localHeader = mkLocalHeader(nameBytes, 0, crc, raw.length, raw.length);

    await writeChunk(localHeader);
    for (let start = 0; start < raw.length; start += chunkSize) {
      await writeChunk(raw.subarray(start, Math.min(start + chunkSize, raw.length)));
    }

    entries.push({ nameBytes, crc, size: raw.length, offset });
    offset += localHeader.length + raw.length;
  }

  if (!entries.length) throw new Error('No tracks could be downloaded');

  const centralParts = entries.map(entry =>
    mkCentralEntry(entry.nameBytes, 0, entry.crc, entry.size, entry.size, entry.offset)
  );
  const cdSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  await writeChunk(concat([...centralParts, mkEndRecord(entries.length, cdSize, offset)]));
}
