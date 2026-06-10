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

const CACHE_FORMAT_VERSION = 8;

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
  const svg = Buffer.from(
    `<svg width="${size}" height="${half}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="rgb(${r},${g},${b})"/>
      <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="${textFill}" font-size="${fontSize}" font-family="system-ui,Segoe UI,sans-serif">${escapeXml(displayText)}</text>
    </svg>`
  );
  return sharp(svg).png().toBuffer();
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
    const svg = Buffer.from(
      `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${size}" height="${size}" fill="rgb(${bgRgb.r},${bgRgb.g},${bgRgb.b})"/>
        <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="${fg}" font-size="${fs}" font-family="${fontFamily}">${escapeXml(single)}</text>
      </svg>`
    );
    return sharp(svg).png().toBuffer();
  }

  // mode === 'both': speed text on the top half, direction arrow on the bottom half.
  const fsTop =
    fontSizePx != null && Number.isFinite(fontSizePx)
      ? Math.min(MAX_OLED_TEXT_FONT_PX, Math.max(8, Math.round(fontSizePx)))
      : Math.min(22, Math.max(11, Math.floor(half * 0.28)));
  const topSvg = Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${size}" height="${size}" fill="rgb(${bgRgb.r},${bgRgb.g},${bgRgb.b})"/>
      <text x="50%" y="${half * 0.5}" dominant-baseline="middle" text-anchor="middle" fill="${fg}" font-size="${fsTop}" font-family="${fontFamily}">${escapeXml(String(speedText ?? ''))}</text>
    </svg>`
  );
  const box = Math.round(half * 0.82);
  const arrow = await getDirectionArrowPng(dirForward, box, fg);
  const left = Math.round((size - box) / 2);
  const top = Math.round(half + (half - box) / 2);
  return sharp(topSvg).composite([{ input: arrow, left, top }]).png().toBuffer();
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
  const key = `${labelText}|${on ? 1 : 0}|${fs}|${size}`;
  const cached = _fnLabelTileCache.get(key);
  if (cached) return cached;

  // Wrap to what fits at this font size (approx. average glyph width 0.58 em).
  const maxChars = Math.max(3, Math.floor((size - 8) / (fs * 0.58)));
  const maxLines = Math.max(1, Math.min(5, Math.floor(size / (fs * 1.3))));
  const lines = wrapLabelLines(labelText, maxChars, maxLines);

  const bg = on ? '#ffffff' : '#000000';
  const fg = on ? '#000000' : '#ffffff';
  const lineH = fs * 1.25;
  const firstCenterY = size / 2 - ((lines.length - 1) * lineH) / 2;
  const texts = lines
    .map(
      (line, i) =>
        `<text x="50%" y="${firstCenterY + i * lineH}" dominant-baseline="middle" text-anchor="middle" fill="${fg}" font-size="${fs}" font-family="system-ui,Segoe UI,sans-serif">${escapeXml(line)}</text>`
    )
    .join('');
  const svg = Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${size}" height="${size}" fill="${bg}"/>
      ${texts}
    </svg>`
  );
  const png = await sharp(svg).png().toBuffer();
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
