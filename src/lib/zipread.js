'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Minimal ZIP reader using the browser's built-in DecompressionStream API.
// Supports stored (method 0) and deflate (method 8) entries.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse a ZIP ArrayBuffer and return a plain object: filename → Uint8Array.
 * Skips directory entries. Throws on unsupported compression methods.
 */
export async function unzipAll(buffer) {
  const view   = new DataView(buffer);
  const result = {};
  let   offset = 0;

  while (offset + 30 <= buffer.byteLength) {
    const sig = view.getUint32(offset, true);
    if (sig !== 0x04034b50) break; // not a local file header — reached central directory

    const compression    = view.getUint16(offset + 8,  true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLen        = view.getUint16(offset + 26, true);
    const extraLen       = view.getUint16(offset + 28, true);
    const name           = new TextDecoder().decode(new Uint8Array(buffer, offset + 30, nameLen));
    const dataStart      = offset + 30 + nameLen + extraLen;

    if (!name.endsWith('/')) { // skip directory entries
      const compressed = new Uint8Array(buffer, dataStart, compressedSize);
      if (compression === 0) {
        result[name] = compressed.slice();
      } else if (compression === 8) {
        result[name] = await inflateRaw(compressed);
      } else {
        throw new Error(`Unsupported ZIP compression method ${compression} for "${name}"`);
      }
    }

    offset = dataStart + compressedSize;
  }

  return result;
}

async function inflateRaw(compressed) {
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
