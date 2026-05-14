/**
 * Build square OLED images: top half = loco name on a fill taken from the source image's top-left
 * pixel (black if missing image or that pixel is transparent); bottom half = photo (fit height, crop right if wide).
 * Side padding when the photo is narrower than the strip uses the same RGB as the text bar; the photo is centered horizontally.
 * PNGs are cached on disk; cache key changes when loco id, label, or source image bytes change.
 */

import sharp from 'sharp';
import crypto from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

export const OLED_COMPOSITE_SIZE = 144;

const CACHE_FORMAT_VERSION = 6;

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

export function compositeCacheFileKey(locoId, displayText, sourceHash) {
  return crypto
    .createHash('sha256')
    .update(`${CACHE_FORMAT_VERSION}|${locoId}|${displayText}|${sourceHash}`)
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

async function renderTopHalfPng(displayText, size, half, bgRgb) {
  const fontSize = Math.min(24, Math.max(12, Math.floor(half * 0.32)));
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
    return sharp(data).extract({ left: 0, top: 0, width: size, height: h }).png().toBuffer();
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

export async function renderLocoCompositePng(sourceBuffer, displayText, size = OLED_COMPOSITE_SIZE) {
  const half = size / 2;
  const bgRgb = await getTopLeftBackgroundRgb(sourceBuffer);
  const [bottomPng, topPng] = await Promise.all([
    renderBottomHalfPng(sourceBuffer, size, half, bgRgb),
    renderTopHalfPng(displayText, size, half, bgRgb),
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

/**
 * Returns PNG buffer, using disk cache when the key matches.
 */
export async function getCachedCompositePng(cacheDir, locoId, displayText, sourceBuffer) {
  await mkdir(cacheDir, { recursive: true });
  const srcHash = sourceContentHash(sourceBuffer);
  const key = compositeCacheFileKey(locoId, displayText, srcHash);
  const filePath = join(cacheDir, `${key}.png`);

  try {
    return await readFile(filePath);
  } catch {
    const png = await renderLocoCompositePng(sourceBuffer, displayText);
    await writeFile(filePath, png);
    return png;
  }
}
