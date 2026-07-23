/**
 * Build square OLED images: top half = loco name on a fill taken from the source image's top-left
 * pixel (black if missing image or that pixel is transparent); bottom half = photo (fit height, crop left if wide).
 * Side padding when the photo is narrower than the strip uses the same RGB as the text bar; the photo is centered horizontally.
 * PNGs are cached on disk; cache key changes when loco id, label, font size, or source image bytes change.
 */

import sharp from 'sharp';
import crypto from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { accessoryOriRotationCw } from './rocrail-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Direction arrow glyphs (monochrome SVGs) reused on speed/direction throttle tiles. */
const DIRECTION_ARROW_SVG = {
  forward: join(__dirname, 'icons', 'forward.svg'),
  reverse: join(__dirname, 'icons', 'reverse.svg'),
};
/** Cache rasterised, recoloured direction arrows by `${dir}|${box}|${color}`. */
const _directionArrowCache = new Map();

/**
 * Rasterise the forward/reverse arrow SVG at `boxSize`, recoloured to `color`
 * (the monochrome glyph uses #000000, swapped here for the tile foreground).
 */
async function getDirectionArrowPng(forward, boxSize, color) {
  const key = `${forward ? 'fwd' : 'rev'}|${boxSize}|${color}`;
  const cached = _directionArrowCache.get(key);
  if (cached) return cached;
  let svg = await readFile(DIRECTION_ARROW_SVG[forward ? 'forward' : 'reverse'], 'utf8');
  svg = svg.replace(/#000000/gi, color);
  const png = await sharp(Buffer.from(svg))
    .resize(boxSize, boxSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  _directionArrowCache.set(key, png);
  return png;
}

export const OLED_COMPOSITE_SIZE = 144;

/** Upper bound for any user-configured OLED text font size (px). */
export const MAX_OLED_TEXT_FONT_PX = 48;

const CACHE_FORMAT_VERSION = 9;

const ICON_CACHE_FORMAT_VERSION = 2;

/** Max per-channel deviation from the mean (over opaque pixels) for an icon to count as a single-colour / monochrome glyph. */
const ICON_MONOCHROME_TOLERANCE = 48;

export function formatLocoDisplayName(loco) {
  const raw = (loco?.name || loco?.id || '?').toString();
  if (raw.length > 8) return `${raw.slice(0, 8)}.`;
  return raw;
}

function escapeXml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Alphabetic baseline Y that visually centers a line at `centerY`.
 * Prefer this over `dominant-baseline="middle"`: near the top of an SVG,
 * librsvg/sharp often clips the em-box and leaves ink artifacts above glyphs.
 */
function svgTextBaselineY(centerY, fontSizePx) {
  return centerY + fontSizePx * 0.35;
}

/** Lowest safe vertical center so glyph ink stays inside the SVG viewBox. */
function svgTextMinCenterY(fontSizePx) {
  return fontSizePx * 0.85;
}

/**
 * Rasterise an SVG that may draw text near y=0. Extra top rows absorb librsvg
 * em-box overflow (otherwise wrapped into the first image row as letter artifacts),
 * then the pad is cropped away.
 */
async function sharpSvgPngCropTopPad(svgBodyInner, width, height, topPad, background = '#000000') {
  const pad = Math.max(0, Math.ceil(topPad));
  const svg = Buffer.from(
    `<svg width="${width}" height="${height + pad}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height + pad}" fill="${background}"/>
      <g transform="translate(0 ${pad})">${svgBodyInner}</g>
    </svg>`
  );
  if (pad <= 0) return sharp(svg).png().toBuffer();
  return sharp(svg)
    .extract({ left: 0, top: pad, width, height })
    .png()
    .toBuffer();
}

export function sourceContentHash(buffer) {
  if (!buffer?.length) return 'NOIMG';
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function compositeCacheFileKey(locoId, displayText, sourceHash, fontSizePx = null) {
  const fs = fontSizePx == null || !Number.isFinite(fontSizePx) ? 'auto' : String(Math.round(fontSizePx));
  return crypto
    .createHash('sha256')
    .update(`${CACHE_FORMAT_VERSION}|${locoId}|${displayText}|${sourceHash}|${fs}`)
    .digest('hex')
    .slice(0, 32);
}

/** sRGB luminance 0–255; above → treat as bright background */
function luminance255(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function textColorForBackground(r, g, b) {
  const L = luminance255(r, g, b);
  return L > 140 ? '#1a1a1a' : '#f5f5f5';
}

/**
 * Background for the name strip: top-left pixel of the (EXIF-oriented) loco image.
 * Fully transparent → black. No image → black.
 */
async function getTopLeftBackgroundRgb(sourceBuffer) {
  if (!sourceBuffer?.length) {
    return { r: 0, g: 0, b: 0 };
  }
  try {
    const { data, info } = await sharp(sourceBuffer)
      .rotate()
      .ensureAlpha()
      .extract({ left: 0, top: 0, width: 1, height: 1 })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const ch = info.channels;
    if (ch === 4) {
      const a = data[3];
      if (a < 128) return { r: 0, g: 0, b: 0 };
      return {
        r: Math.min(255, Math.max(0, Math.round(data[0]))),
        g: Math.min(255, Math.max(0, Math.round(data[1]))),
        b: Math.min(255, Math.max(0, Math.round(data[2]))),
      };
    }
    if (ch === 3) {
      return {
        r: Math.min(255, Math.max(0, Math.round(data[0]))),
        g: Math.min(255, Math.max(0, Math.round(data[1]))),
        b: Math.min(255, Math.max(0, Math.round(data[2]))),
      };
    }
    if (ch === 2) {
      const a = data[1];
      if (a < 128) return { r: 0, g: 0, b: 0 };
      const v = data[0];
      return { r: v, g: v, b: v };
    }
    if (ch === 1) {
      const v = data[0];
      return { r: v, g: v, b: v };
    }
    return { r: 0, g: 0, b: 0 };
  } catch {
    return { r: 0, g: 0, b: 0 };
  }
}

async function renderTopHalfPng(displayText, size, half, bgRgb, fontSizePx = null) {
  const auto = Math.min(24, Math.max(12, Math.floor(half * 0.32)));
  const fontSize =
    fontSizePx != null && Number.isFinite(fontSizePx)
      ? Math.min(MAX_OLED_TEXT_FONT_PX, Math.max(8, Math.round(fontSizePx)))
      : auto;
  const { r, g, b } = bgRgb;
  const textFill = textColorForBackground(r, g, b);
  const centerY = Math.max(svgTextMinCenterY(fontSize), half / 2);
  const textY = svgTextBaselineY(centerY, fontSize);
  const bg = `rgb(${r},${g},${b})`;
  const pad = Math.ceil(fontSize * 0.55);
  return sharpSvgPngCropTopPad(
    `<rect width="${size}" height="${half}" fill="${bg}"/>
      <text x="50%" y="${textY}" text-anchor="middle" fill="${textFill}" font-size="${fontSize}" font-family="system-ui,Segoe UI,sans-serif">${escapeXml(displayText)}</text>`,
    size,
    half,
    pad,
    bg
  );
}

async function renderBottomHalfPng(sourceBuffer, size, half, padRgb) {
  const pad = padRgb || { r: 0, g: 0, b: 0 };
  if (!sourceBuffer?.length) {
    return sharp({
      create: { width: size, height: half, channels: 3, background: pad },
    })
      .png()
      .toBuffer();
  }

  const resized = await sharp(sourceBuffer)
    .rotate()
    .resize({ height: half, fit: 'inside' })
    .toBuffer({ resolveWithObject: true });

  const { data, info } = resized;
  const w = info.width;
  const h = info.height;

  if (w > size) {
    const left = Math.max(0, w - size);
    return sharp(data).extract({ left, top: 0, width: size, height: h }).png().toBuffer();
  }
  if (w < size) {
    const left = Math.floor((size - w) / 2);
    return sharp({
      create: { width: size, height: half, channels: 3, background: pad },
    })
      .composite([{ input: data, left, top: 0 }])
      .png()
      .toBuffer();
  }
  return sharp(data).png().toBuffer();
}

/**
 * Throttle OLED: speed and/or direction on a solid black key with light typography.
 * @param {string} speedText
 * @param {boolean} dirForward
 * @param {number} size
 * @param {number|null} fontSizePx
 * @param {'both'|'speed'|'direction'} mode `both` = speed (top) + direction (bottom); `speed`/`direction` = single centered line.
 */
export async function renderThrottleSpeedDirPng(
  speedText,
  dirForward,
  size = OLED_COMPOSITE_SIZE,
  fontSizePx = null,
  mode = 'both'
) {
  const half = size / 2;
  /** Speed/direction OLED: solid black backing and light typography. */
  const bgRgb = { r: 0, g: 0, b: 0 };
  const fg = '#e8e8e8';
  const fontFamily = 'system-ui,Segoe UI,sans-serif';
  const blackTile = () =>
    sharp({ create: { width: size, height: size, channels: 4, background: { ...bgRgb, alpha: 1 } } });

  if (mode === 'direction') {
    const box = Math.round(size * 0.62);
    const arrow = await getDirectionArrowPng(dirForward, box, fg);
    const off = Math.round((size - box) / 2);
    return blackTile().composite([{ input: arrow, left: off, top: off }]).png().toBuffer();
  }

  if (mode === 'speed') {
    const single = String(speedText ?? '');
    const fs =
      fontSizePx != null && Number.isFinite(fontSizePx)
        ? Math.min(MAX_OLED_TEXT_FONT_PX, Math.max(8, Math.round(fontSizePx)))
        : Math.min(40, Math.max(14, Math.floor(size * 0.22)));
    const centerY = Math.max(svgTextMinCenterY(fs), size / 2);
    const textY = svgTextBaselineY(centerY, fs);
    return sharpSvgPngCropTopPad(
      `<rect width="${size}" height="${size}" fill="rgb(${bgRgb.r},${bgRgb.g},${bgRgb.b})"/>
        <text x="50%" y="${textY}" text-anchor="middle" fill="${fg}" font-size="${fs}" font-family="${fontFamily}">${escapeXml(single)}</text>`,
      size,
      size,
      Math.ceil(fs * 0.55),
      '#000000'
    );
  }

  // mode === 'both': speed text on the top half, direction arrow on the bottom half.
  const fsTop =
    fontSizePx != null && Number.isFinite(fontSizePx)
      ? Math.min(MAX_OLED_TEXT_FONT_PX, Math.max(8, Math.round(fontSizePx)))
      : Math.min(22, Math.max(11, Math.floor(half * 0.28)));
  const speedCenterY = Math.max(svgTextMinCenterY(fsTop), half * 0.5);
  const speedTextY = svgTextBaselineY(speedCenterY, fsTop);
  const topPng = await sharpSvgPngCropTopPad(
    `<rect width="${size}" height="${size}" fill="rgb(${bgRgb.r},${bgRgb.g},${bgRgb.b})"/>
      <text x="50%" y="${speedTextY}" text-anchor="middle" fill="${fg}" font-size="${fsTop}" font-family="${fontFamily}">${escapeXml(String(speedText ?? ''))}</text>`,
    size,
    size,
    Math.ceil(fsTop * 0.55),
    '#000000'
  );
  const box = Math.round(half * 0.82);
  const arrow = await getDirectionArrowPng(dirForward, box, fg);
  const left = Math.round((size - box) / 2);
  const top = Math.round(half + (half - box) / 2);
  return sharp(topPng).composite([{ input: arrow, left, top }]).png().toBuffer();
}

export async function renderLocoCompositePng(
  sourceBuffer,
  displayText,
  size = OLED_COMPOSITE_SIZE,
  fontSizePx = null
) {
  const half = size / 2;
  const bgRgb = await getTopLeftBackgroundRgb(sourceBuffer);
  const [bottomPng, topPng] = await Promise.all([
    renderBottomHalfPng(sourceBuffer, size, half, bgRgb),
    renderTopHalfPng(displayText, size, half, bgRgb, fontSizePx),
  ]);

  return sharp({
    create: { width: size, height: size, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .composite([
      { input: topPng, top: 0, left: 0 },
      { input: bottomPng, top: half, left: 0 },
    ])
    .png()
    .toBuffer();
}

/** Function OFF: black key (white title = manifest state 0). */
let _fnKeyOffBlackDataUri;

/** Function ON: white key (black title = manifest state 1). */
let _fnKeyOnWhiteDataUri;

/**
 * @returns {Promise<string>} data:image/png;base64,…
 */
export async function getFnKeyOnBackgroundDataUri() {
  if (_fnKeyOnWhiteDataUri) return _fnKeyOnWhiteDataUri;
  const buf = await sharp({
    create: {
      width: OLED_COMPOSITE_SIZE,
      height: OLED_COMPOSITE_SIZE,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .png()
    .toBuffer();
  _fnKeyOnWhiteDataUri = `data:image/png;base64,${buf.toString('base64')}`;
  return _fnKeyOnWhiteDataUri;
}

/**
 * @returns {Promise<string>} data:image/png;base64,…
 */
export async function getFnKeyOffBackgroundDataUri() {
  if (_fnKeyOffBlackDataUri) return _fnKeyOffBlackDataUri;
  const buf = await sharp({
    create: {
      width: OLED_COMPOSITE_SIZE,
      height: OLED_COMPOSITE_SIZE,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .png()
    .toBuffer();
  _fnKeyOffBlackDataUri = `data:image/png;base64,${buf.toString('base64')}`;
  return _fnKeyOffBlackDataUri;
}

/* ------------------------------------------------------------------------ *
 * Accessory tiles (turnouts, signals, outputs, sensors, blocks, tracks, …)
 * ------------------------------------------------------------------------ */

const ACC_ACTIVE = '#f7dc6f';
const ACC_INACTIVE = '#5a5a6e';
const ACC_TEXT = '#e8e8e8';

/** Built-in SVG glyph (100×100 viewBox contents) for an accessory kind/type/state. */
function accessoryGlyphSvg(info) {
  const kind = info.kind || '';
  const type = String(info.type ?? '').toLowerCase();
  const state = String(info.state ?? '').toLowerCase();
  const lw = 10;
  const line = (x1, y1, x2, y2, color, w = lw) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`;

  if (kind === 'sw') {
    if (type === 'decoupler') {
      const on = state === 'on';
      return line(5, 50, 95, 50, ACC_ACTIVE) + `<rect x="40" y="28" width="20" height="44" rx="4" fill="${on ? '#e74c3c' : ACC_INACTIVE}"/>`;
    }
    if (type === 'crossing' || type === 'ccrossing') {
      return line(5, 50, 95, 50, ACC_ACTIVE) + line(20, 90, 80, 10, ACC_ACTIVE);
    }
    if (type === 'threeway') {
      const cLeft = state === 'left' ? ACC_ACTIVE : ACC_INACTIVE;
      const cRight = state === 'right' ? ACC_ACTIVE : ACC_INACTIVE;
      const cStraight = state === 'left' || state === 'right' ? ACC_INACTIVE : ACC_ACTIVE;
      return (
        line(5, 50, 50, 50, ACC_ACTIVE) +
        line(50, 50, 95, 50, cStraight) +
        line(50, 50, 90, 15, cLeft) +
        line(50, 50, 90, 85, cRight)
      );
    }
    if (type === 'dcrossing') {
      const thrown = state === 'turnout' || state === 'left' || state === 'right';
      return (
        line(5, 50, 95, 50, thrown ? ACC_INACTIVE : ACC_ACTIVE) +
        line(20, 90, 80, 10, thrown ? ACC_ACTIVE : ACC_INACTIVE)
      );
    }
    // plain left / right turnout
    const thrown = state === 'turnout';
    const up = type !== 'right';
    const branch = line(50, 50, 90, up ? 15 : 85, thrown ? ACC_ACTIVE : ACC_INACTIVE);
    const straight = line(50, 50, 95, 50, thrown ? ACC_INACTIVE : ACC_ACTIVE);
    return line(5, 50, 50, 50, ACC_ACTIVE) + straight + branch;
  }

  if (kind === 'sg') {
    const aspect =
      state === 'green' ? '#2ecc71' : state === 'yellow' ? '#f1c40f' : state === 'white' ? '#ecf0f1' : state === 'blank' ? ACC_INACTIVE : '#e74c3c';
    return (
      line(50, 95, 50, 60, ACC_TEXT, 7) +
      line(30, 95, 70, 95, ACC_TEXT, 7) +
      `<circle cx="50" cy="35" r="24" fill="${aspect}" stroke="${ACC_TEXT}" stroke-width="5"/>`
    );
  }

  if (kind === 'co') {
    const on = state === 'on';
    const fill = on ? '#2ecc71' : '#e74c3c';
    return `<rect x="20" y="20" width="60" height="60" rx="12" fill="${fill}" stroke="${fill}" stroke-width="4"/>`;
  }

  if (kind === 'fb') {
    const on = state === 'true';
    return (
      line(5, 50, 95, 50, ACC_INACTIVE) +
      `<circle cx="50" cy="50" r="22" fill="${on ? '#e74c3c' : '#1a1a1a'}" stroke="${on ? '#e74c3c' : ACC_INACTIVE}" stroke-width="7"/>`
    );
  }

  if (kind === 'bk') {
    const occupied = !!String(info.locid ?? '').trim();
    const reserved = occupied && state.startsWith('res');
    const closed = state === 'closed';
    const fill = reserved ? '#b7950b' : occupied ? '#922b21' : 'none';
    const cross = closed ? line(18, 32, 82, 68, '#e74c3c', 7) + line(18, 68, 82, 32, '#e74c3c', 7) : '';
    return `<rect x="8" y="26" width="84" height="48" rx="6" fill="${fill}" stroke="${ACC_TEXT}" stroke-width="6"/>${cross}`;
  }

  if (kind === 'tk') {
    if (type === 'curve') return `<path d="M 5 95 Q 50 50 95 95" fill="none" stroke="${ACC_ACTIVE}" stroke-width="${lw}" stroke-linecap="round"/>`;
    if (type === 'buffer') return line(5, 50, 75, 50, ACC_ACTIVE) + line(75, 25, 75, 75, '#e74c3c', 8);
    if (type === 'dir' || type === 'dirall') return line(5, 50, 80, 50, ACC_ACTIVE) + `<path d="M 65 30 L 92 50 L 65 70 Z" fill="${ACC_ACTIVE}"/>`;
    return line(5, 50, 95, 50, ACC_ACTIVE);
  }

  if (kind === 'tt') {
    const pos = String(info.bridgepos ?? '').trim();
    return (
      `<circle cx="50" cy="50" r="42" fill="none" stroke="${ACC_INACTIVE}" stroke-width="6"/>` +
      line(22, 78, 78, 22, ACC_ACTIVE, 9) +
      (pos
        ? `<text x="50" y="56" text-anchor="middle" fill="${ACC_TEXT}" font-size="30" font-family="system-ui,sans-serif">${escapeXml(pos)}</text>`
        : '')
    );
  }

  return `<text x="50" y="62" text-anchor="middle" fill="${ACC_INACTIVE}" font-size="56" font-family="system-ui,sans-serif">?</text>`;
}

/**
 * Accessory OLED tile: item name on top, state-dependent symbol below.
 * Uses `info.iconBuffer` (icon fetched from the Rocrail server / SVG theme) when
 * given, otherwise a built-in glyph. Black background, light typography.
 *
 * @param {{kind?: string, type?: string, state?: string, locid?: string, bridgepos?: string|number, ori?: string, name: string, iconBuffer?: Buffer|null}} info
 */
export async function renderAccessoryTilePng(info, size = OLED_COMPOSITE_SIZE, fontSizePx = null) {
  const name = String(info?.name ?? '').trim() || '?';
  const rot = accessoryOriRotationCw(info?.ori);
  const fs =
    fontSizePx != null && Number.isFinite(fontSizePx)
      ? Math.min(MAX_OLED_TEXT_FONT_PX, Math.max(8, Math.round(fontSizePx)))
      : Math.min(22, Math.max(12, Math.floor(size * 0.13)));
  // Tall enough strip; text is drawn with a cropped top pad so librsvg em-box overflow
  // cannot wrap into the first image row (artifacts above letters).
  const stripH = Math.max(Math.round(size * 0.24), Math.round(fs * 1.9));
  const iconBox = size - stripH;
  const iconCx = size / 2;
  const iconCy = stripH + iconBox / 2;
  const centerY = Math.max(svgTextMinCenterY(fs), stripH / 2);
  const textY = svgTextBaselineY(centerY, fs);
  const topPad = Math.ceil(fs * 0.55);

  const maxChars = Math.max(3, Math.floor((size - 6) / (fs * 0.58)));
  const label = name.length > maxChars ? `${name.slice(0, maxChars - 1)}…` : name;
  const labelSvg = `<text x="50%" y="${textY}" text-anchor="middle" fill="${ACC_TEXT}" font-size="${fs}" font-family="system-ui,Segoe UI,sans-serif">${escapeXml(label)}</text>`;

  if (info?.iconBuffer?.length) {
    try {
      const basePng = await sharpSvgPngCropTopPad(
        `<rect width="${size}" height="${size}" fill="#000000"/>${labelSvg}`,
        size,
        size,
        topPad,
        '#000000'
      );
      const inner = Math.round(iconBox * 0.92);
      let pipeline = sharp(info.iconBuffer).resize(inner, inner, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      });
      if (rot) {
        pipeline = pipeline.rotate(rot, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
      }
      const { data, info: meta } = await pipeline.png().toBuffer({ resolveWithObject: true });
      const left = Math.round(iconCx - meta.width / 2);
      const top = Math.round(iconCy - meta.height / 2);
      return sharp(basePng).composite([{ input: data, left, top }]).png().toBuffer();
    } catch {
      // fall through to the built-in glyph
    }
  }

  const glyphScale = (iconBox * 0.9) / 100;
  return sharpSvgPngCropTopPad(
    `<rect width="${size}" height="${size}" fill="#000000"/>
      ${labelSvg}
      <g transform="translate(${iconCx} ${iconCy}) rotate(${rot}) scale(${glyphScale}) translate(-50 -50)">${accessoryGlyphSvg(info || {})}</g>`,
    size,
    size,
    topPad,
    '#000000'
  );
}

/** Word-wrap a function label into at most `maxLines` lines of `maxCharsPerLine` characters. */
function wrapLabelLines(text, maxCharsPerLine, maxLines) {
  let s = (String(text ?? '').trim() || '?').replace(/\s+/g, ' ');
  const lines = [];
  for (let L = 0; L < maxLines && s.length; L++) {
    if (s.length <= maxCharsPerLine || L === maxLines - 1) {
      lines.push(L === maxLines - 1 && s.length > maxCharsPerLine ? `${s.slice(0, maxCharsPerLine - 1)}…` : s);
      break;
    }
    let cut = s.lastIndexOf(' ', maxCharsPerLine);
    if (cut <= 0) cut = maxCharsPerLine;
    lines.push(s.slice(0, cut).trimEnd());
    s = s.slice(cut).trimStart();
  }
  return lines;
}

/** @type {Map<string, Buffer>} rendered function-label tiles keyed by label|on|fontSize|size */
const _fnLabelTileCache = new Map();

/**
 * Function-key tile with the label text baked into the image (white-on-black when off,
 * black-on-white when on). Needed because OpenDeck ignores `setTitleParameters`, so title
 * font sizes cannot follow the configured OLED font size; image text can.
 */
export async function renderFunctionLabelPng(labelText, on, size = OLED_COMPOSITE_SIZE, fontSizePx = null) {
  const fs =
    fontSizePx != null && Number.isFinite(fontSizePx)
      ? Math.min(MAX_OLED_TEXT_FONT_PX, Math.max(8, Math.round(fontSizePx)))
      : Math.min(26, Math.max(14, Math.floor(size * 0.15)));
  const key = `${labelText}|${on ? 1 : 0}|${fs}|${size}|v3`;
  const cached = _fnLabelTileCache.get(key);
  if (cached) return cached;

  // Wrap to what fits at this font size (approx. average glyph width 0.58 em).
  const maxChars = Math.max(3, Math.floor((size - 8) / (fs * 0.58)));
  const lineH = fs * 1.25;
  const topMin = svgTextMinCenterY(fs);
  const bottomMax = size - fs * 0.45;
  const usableH = Math.max(lineH, bottomMax - topMin + lineH);
  const maxLines = Math.max(1, Math.min(5, Math.floor(usableH / lineH)));
  const lines = wrapLabelLines(labelText, maxChars, maxLines);

  const bg = on ? '#ffffff' : '#000000';
  const fg = on ? '#000000' : '#ffffff';
  let firstCenterY = size / 2 - ((lines.length - 1) * lineH) / 2;
  if (firstCenterY < topMin) firstCenterY = topMin;
  const lastCenterY = firstCenterY + (lines.length - 1) * lineH;
  if (lastCenterY > bottomMax) {
    firstCenterY = Math.max(topMin, bottomMax - (lines.length - 1) * lineH);
  }
  const texts = lines
    .map((line, i) => {
      const y = svgTextBaselineY(firstCenterY + i * lineH, fs);
      return `<text x="50%" y="${y}" text-anchor="middle" fill="${fg}" font-size="${fs}" font-family="system-ui,Segoe UI,sans-serif">${escapeXml(line)}</text>`;
    })
    .join('');
  const png = await sharpSvgPngCropTopPad(
    `<rect width="${size}" height="${size}" fill="${bg}"/>${texts}`,
    size,
    size,
    Math.ceil(fs * 0.55),
    bg
  );
  _fnLabelTileCache.set(key, png);
  return png;
}

/**
 * Returns PNG buffer, using disk cache when the key matches.
 */
export async function getCachedCompositePng(cacheDir, locoId, displayText, sourceBuffer, fontSizePx = null) {
  await mkdir(cacheDir, { recursive: true });
  const srcHash = sourceContentHash(sourceBuffer);
  const key = compositeCacheFileKey(locoId, displayText, srcHash, fontSizePx);
  const filePath = join(cacheDir, `${key}.png`);

  try {
    return await readFile(filePath);
  } catch {
    const png = await renderLocoCompositePng(sourceBuffer, displayText, OLED_COMPOSITE_SIZE, fontSizePx);
    await writeFile(filePath, png);
    return png;
  }
}

/**
 * True if every sufficiently-opaque pixel in a raw RGBA buffer shares (within tolerance) the same colour,
 * i.e. the icon is a single-colour / monochrome glyph (black line art, a white symbol, one solid hue, …).
 */
function isMonochromeRgba(data, channels) {
  if (channels !== 4) return false;
  let count = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 16) continue;
    sumR += data[i];
    sumG += data[i + 1];
    sumB += data[i + 2];
    count++;
  }
  if (count === 0) return false;
  const mR = sumR / count;
  const mG = sumG / count;
  const mB = sumB / count;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 16) continue;
    if (
      Math.abs(data[i] - mR) > ICON_MONOCHROME_TOLERANCE ||
      Math.abs(data[i + 1] - mG) > ICON_MONOCHROME_TOLERANCE ||
      Math.abs(data[i + 2] - mB) > ICON_MONOCHROME_TOLERANCE
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Function-key tile showing a Rocrail function icon centered on the on/off state background
 * (white when on, black when off). Falls back to a blank state tile when no icon bytes are given.
 *
 * Monochrome glyphs are recoloured to contrast with the background (black on the white "on" key,
 * white on the black "off" key) so a single-colour icon never blends into its background.
 */
export async function renderFunctionIconPng(iconBuffer, on, size = OLED_COMPOSITE_SIZE) {
  const bg = on ? { r: 255, g: 255, b: 255, alpha: 1 } : { r: 0, g: 0, b: 0, alpha: 1 };
  const base = () => sharp({ create: { width: size, height: size, channels: 4, background: bg } });
  if (!iconBuffer?.length) {
    return base().png().toBuffer();
  }
  try {
    const inner = Math.round(size * 0.7);
    const { data, info } = await sharp(iconBuffer)
      .rotate()
      .resize({ width: inner, height: inner, fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let pixels = data;
    if (isMonochromeRgba(data, info.channels)) {
      // Contrast colour: black glyph on the white (on) key, white glyph on the black (off) key.
      const c = on ? 0 : 255;
      pixels = Buffer.from(data);
      for (let i = 0; i < pixels.length; i += 4) {
        pixels[i] = c;
        pixels[i + 1] = c;
        pixels[i + 2] = c;
      }
    }

    const left = Math.max(0, Math.floor((size - info.width) / 2));
    const top = Math.max(0, Math.floor((size - info.height) / 2));
    return base()
      .composite([
        { input: pixels, raw: { width: info.width, height: info.height, channels: info.channels }, left, top },
      ])
      .png()
      .toBuffer();
  } catch {
    return base().png().toBuffer();
  }
}

export function functionIconCacheFileKey(iconName, on, sourceHash) {
  return crypto
    .createHash('sha256')
    .update(`icon|${ICON_CACHE_FORMAT_VERSION}|${iconName}|${on ? 1 : 0}|${sourceHash}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Returns a function-icon PNG buffer, rendered once and cached on disk per icon bytes + on/off state.
 */
export async function getCachedFunctionIconPng(cacheDir, iconName, on, sourceBuffer) {
  await mkdir(cacheDir, { recursive: true });
  const srcHash = sourceContentHash(sourceBuffer);
  const key = functionIconCacheFileKey(iconName, on, srcHash);
  const filePath = join(cacheDir, `${key}.png`);
  try {
    return await readFile(filePath);
  } catch {
    const png = await renderFunctionIconPng(sourceBuffer, on, OLED_COMPOSITE_SIZE);
    await writeFile(filePath, png);
    return png;
  }
}
