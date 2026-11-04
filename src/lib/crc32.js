'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// CRC-32
// ═══════════════════════════════════════════════════════════════════════════

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[n] = c;
  }
  return t;
})();

export function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

export async function crc32Async(data) {
  let crc = 0xFFFFFFFF;
  const blockSize = 2 * 1024 * 1024;

  for (let start = 0; start < data.length; start += blockSize) {
    const end = Math.min(start + blockSize, data.length);
    for (let i = start; i < end; i++) {
      crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    }
    if (end < data.length) await new Promise(resolve => setTimeout(resolve, 0));
  }

  return (crc ^ 0xFFFFFFFF) >>> 0;
}
