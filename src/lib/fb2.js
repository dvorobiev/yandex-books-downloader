'use strict';

const DEC = new TextDecoder('utf-8');
const ENC = new TextEncoder();

function xmlEsc(s) {
  return String(s)
    .replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function b64(data) {
  let s = '';
  for (let i = 0; i < data.length; i++) s += String.fromCharCode(data[i]);
  return btoa(s);
}

const MIME_MAP = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};

function imgMime(src) {
  const clean = String(src || '').split('?')[0].split('#')[0];
  const ext = clean.includes('.') ? clean.split('.').pop().toLowerCase() : '';
  return MIME_MAP[ext] || 'image/jpeg';
}

function imgId(key) {
  return `img_${String(key).replace(/[^a-zA-Z0-9._-]/g, '_') || 'image'}`;
}

function normalizePath(path) {
  const parts = String(path || '').split('/');
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function getAttr(attrStr, name) {
  const match = String(attrStr).match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return match ? match[1] : null;
}

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

const SKIP_TAGS = new Set(['script', 'style', 'svg', 'noscript', 'head']);

function* tokenize(html) {
  const re = /<!--[\s\S]*?-->|<(!DOCTYPE[^>]*)>|<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\/?)>/g;
  let last = 0;
  for (const m of html.matchAll(re)) {
    if (m.index > last) yield { type: 'text', value: html.slice(last, m.index) };
    last = m.index + m[0].length;
    if (m[0].startsWith('<!--') || m[0].startsWith('<!')) continue;
    const closing = m[2] === '/';
    const tag = m[3].toLowerCase();
    const attrStr = m[4];
    const selfClose = m[5] === '/' || VOID_TAGS.has(tag);
    yield { type: closing ? 'close' : 'open', tag, attrStr, selfClose };
  }
  if (last < html.length) yield { type: 'text', value: html.slice(last) };
}

function resolveContentKey(path, contentFiles) {
  const cleanPath = String(path || '').split('?')[0].split('#')[0];
  const normalized = normalizePath(cleanPath);
  if (normalized && contentFiles[normalized]) return normalized;
  if (cleanPath && contentFiles[cleanPath]) return cleanPath;

  const base = cleanPath.split('/').pop();
  const keys = Object.keys(contentFiles);
  return keys.find((k) => k === base || k.endsWith(`/${base}`) || normalizePath(k).endsWith(`/${base}`)) || null;
}

function resolveImg(src, baseDir, contentFiles) {
  if (!src || src.startsWith('data:')) return null;
  const cleanSrc = String(src).split('?')[0].split('#')[0];
  const direct = resolveContentKey(normalizePath(`${baseDir || ''}${cleanSrc}`), contentFiles);
  if (direct) return direct;
  return resolveContentKey(cleanSrc, contentFiles);
}

function parseSpineOrder(opfText) {
  const manifestMatch = String(opfText).match(/<manifest[^>]*>([\s\S]*?)<\/manifest>/i);
  const spineMatch = String(opfText).match(/<spine[^>]*>([\s\S]*?)<\/spine>/i);
  if (!manifestMatch || !spineMatch) return [];

  const idHref = new Map();
  for (const item of manifestMatch[1].matchAll(/<item\b[^>]*>/gi)) {
    const tag = item[0];
    const id = getAttr(tag, 'id');
    const href = getAttr(tag, 'href');
    if (id && href) idHref.set(id, href);
  }

  const order = [];
  for (const item of spineMatch[1].matchAll(/<itemref\b[^>]*>/gi)) {
    const tag = item[0];
    const idref = getAttr(tag, 'idref');
    const href = idref ? idHref.get(idref) : null;
    if (href) order.push(href);
  }
  return order;
}

function normalizeAuthors(authors) {
  if (Array.isArray(authors)) {
    return authors
      .map((author) => {
        if (typeof author === 'string') return author;
        if (!author || typeof author !== 'object') return '';
        return author.name || author.full_name || author.fullName || author.nickname || '';
      })
      .filter(Boolean)
      .join(', ');
  }
  return String(authors || '');
}

/**
 * Convert one XHTML file to a FB2 <section> XML string.
 *
 * @param {string} xhtml
 * @param {string} baseDir
 * @param {Object<string, Uint8Array>} contentFiles
 * @returns {{ sectionXml: string, images: Map<string, { key: string, mime: string }> }}
 */
export function xhtmlToSection(xhtml, baseDir, contentFiles) {
  const bodyMatch = String(xhtml).match(/<body[^>]*>([\s\S]*?)<\/body\s*>/i);
  const html = bodyMatch ? bodyMatch[1] : String(xhtml);

  const images = new Map();
  const out = [];
  let skipTag = null;
  let skipDepth = 0;
  let paraOpen = false;
  let sectionOpen = false;
  let inTitle = false;
  let titleHasText = false;
  const inlineStack = [];

  const ensureSection = () => {
    if (!sectionOpen) {
      out.push('<section>');
      sectionOpen = true;
    }
  };

  const closePara = () => {
    if (paraOpen) {
      for (let i = inlineStack.length - 1; i >= 0; i--) {
        if (inlineStack[i].emitted) out.push(inlineStack[i].close);
        inlineStack[i].emitted = false;
        inlineStack[i].blocked = true;
      }
      out.push('</p>');
      paraOpen = false;
    }
  };

  const openPara = () => {
    ensureSection();
    if (!paraOpen) {
      out.push('<p>');
      paraOpen = true;
      for (const inline of inlineStack) {
        if (inline.blocked) continue;
        out.push(inline.open);
        inline.emitted = true;
      }
    }
  };

  const openInline = (open, close) => {
    if (inTitle) {
      out.push(open);
      inlineStack.push({ open, close, emitted: true, titleOnly: true, blocked: false });
      return;
    }
    if (paraOpen) out.push(open);
    inlineStack.push({ open, close, emitted: paraOpen, titleOnly: false, blocked: false });
  };

  const closeInline = (close) => {
    for (let i = inlineStack.length - 1; i >= 0; i--) {
      if (inlineStack[i].close !== close) continue;
      const [entry] = inlineStack.splice(i, 1);
      if (entry.emitted) out.push(close);
      return;
    }
  };

  for (const tok of tokenize(html)) {
    if (skipTag) {
      if (tok.type === 'open' && tok.tag === skipTag && !tok.selfClose) skipDepth++;
      if (tok.type === 'close' && tok.tag === skipTag) {
        if (skipDepth > 0) skipDepth--;
        else skipTag = null;
      }
      continue;
    }

    if (tok.type === 'text') {
      const text = tok.value.replace(/\s+/g, ' ');
      if (text.trim()) {
        if (inTitle) {
          out.push(xmlEsc(text));
          titleHasText = true;
        }
        else {
          openPara();
          out.push(xmlEsc(text));
        }
      }
      continue;
    }

    const { tag, attrStr, type } = tok;

    if (type === 'open' && SKIP_TAGS.has(tag)) {
      if (!tok.selfClose) {
        skipTag = tag;
        skipDepth = 0;
      }
      continue;
    }

    if (/^h[1-6]$/.test(tag)) {
      if (type === 'open') {
        closePara();
        ensureSection();
        out.push('<title><p>');
        inTitle = true;
        titleHasText = false;
      } else {
        while (inlineStack.length && inlineStack[inlineStack.length - 1].titleOnly) {
          out.push(inlineStack.pop().close);
        }
        if (!titleHasText) out.pop();
        else out.push('</p></title>');
        inTitle = false;
        titleHasText = false;
      }
      continue;
    }

    if (['p', 'div', 'section', 'article', 'main', 'header', 'footer', 'nav', 'aside'].includes(tag)) {
      closePara();
      continue;
    }

    if (tag === 'br') {
      if (paraOpen) {
        closePara();
        openPara();
      }
      continue;
    }

    if (tag === 'hr') {
      closePara();
      ensureSection();
      out.push('<empty-line/>');
      continue;
    }

    if (tag === 'img' && type === 'open') {
      const src = getAttr(attrStr, 'src') || '';
      const key = resolveImg(src, baseDir, contentFiles);
      if (key) {
        const id = imgId(key);
        if (!images.has(id)) images.set(id, { key, mime: imgMime(key) });
        closePara();
        ensureSection();
        out.push(`<image l:href="#${id}"/>`);
      }
      continue;
    }

    if (tag === 'strong' || tag === 'b') {
      if (type === 'open') openInline('<strong>', '</strong>');
      else closeInline('</strong>');
      continue;
    }

    if (tag === 'em' || tag === 'i') {
      if (type === 'open') openInline('<emphasis>', '</emphasis>');
      else closeInline('</emphasis>');
      continue;
    }

    if (tag === 'a') {
      if (type === 'open') {
        const href = getAttr(attrStr, 'href') || '';
        openInline(`<a l:href="${xmlEsc(href)}">`, '</a>');
      } else {
        closeInline('</a>');
      }
      continue;
    }

    if (tag === 'blockquote') {
      if (type === 'open') {
        closePara();
        ensureSection();
        out.push('<cite>');
      } else {
        closePara();
        out.push('</cite>');
      }
      continue;
    }

    if (tag === 'li') {
      if (type === 'open') {
        closePara();
        openPara();
        out.push('• ');
      } else {
        closePara();
      }
      continue;
    }

    if (tag === 'sup') {
      out.push(type === 'open' ? '<sup>' : '</sup>');
      continue;
    }

    if (tag === 'sub') {
      out.push(type === 'open' ? '<sub>' : '</sub>');
      continue;
    }

    if (tag === 's' || tag === 'strike' || tag === 'del') {
      out.push(type === 'open' ? '<strikethrough>' : '</strikethrough>');
    }
  }

  closePara();
  if (!sectionOpen) out.push('<section><p> </p>');
  out.push('</section>');

  return { sectionXml: out.join(''), images };
}

/**
 * Assemble a complete FB2 XML document.
 *
 * @param {object} p
 * @param {string} p.title
 * @param {string|Array} p.authors
 * @param {string} [p.lang='ru']
 * @param {string} p.opfDir
 * @param {string} p.opfText
 * @param {Object<string, Uint8Array>} p.contentFiles
 * @returns {Uint8Array}
 */
export function buildFb2({ title, authors, lang = 'ru', opfDir = '', opfText, contentFiles }) {
  const spineHrefs = parseSpineOrder(opfText);
  const htmlOrder = spineHrefs
    .map((href) => normalizePath(`${opfDir || ''}${href}`))
    .filter((key) => /\.x?html?$/i.test(key));

  const allImages = new Map();
  const sections = [];

  for (const fullKey of htmlOrder) {
    const key = resolveContentKey(fullKey, contentFiles);
    if (!key) continue;
    const data = contentFiles[key];
    if (!data) continue;
    const xhtml = DEC.decode(data);
    const baseDir = key.replace(/[^/]+$/, '');
    const { sectionXml, images } = xhtmlToSection(xhtml, baseDir, contentFiles);
    sections.push(sectionXml);
    for (const [id, meta] of images) {
      if (!allImages.has(id)) allImages.set(id, meta);
    }
  }

  const binaries = [];
  for (const [id, { key, mime }] of allImages) {
    const data = contentFiles[key];
    if (!data) continue;
    binaries.push(`<binary id="${id}" content-type="${mime}">${b64(data)}</binary>`);
  }

  const authorText = normalizeAuthors(authors);
  const authorEls = (authorText || '')
    .split(/\s*,\s*/)
    .filter(Boolean)
    .map((name) => {
      const parts = String(name).trim().split(/\s+/);
      const [first, ...rest] = parts;
      return rest.length
        ? `      <author><first-name>${xmlEsc(first)}</first-name><last-name>${xmlEsc(rest.join(' '))}</last-name></author>`
        : `      <author><nickname>${xmlEsc(first || 'Unknown')}</nickname></author>`;
    })
    .join('\n') || '      <author><nickname>Unknown</nickname></author>';

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink" xml:lang="${xmlEsc(lang)}">
  <description>
    <title-info>
      <genre>prose</genre>
${authorEls}
      <book-title>${xmlEsc(title)}</book-title>
      <lang>${xmlEsc(lang)}</lang>
    </title-info>
  </description>
  <body>
    ${sections.join('\n    ') || '<section><p> </p></section>'}
  </body>
${binaries.map((b) => `  ${b}`).join('\n')}
</FictionBook>`;

  return ENC.encode(xml);
}
