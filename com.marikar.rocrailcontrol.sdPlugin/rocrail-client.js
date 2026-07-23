/**
 * Rocrail RCP (Rocrail Client Protocol) client
 * Communicates with Rocrail server via TCP socket using XML messages
 * Default port: 8051
 * Protocol: https://wiki.rocrail.net/doku.php?id=develop:cs-protocol-en
 */

import net from 'net';

const RR_DEBUG =
  process.env.ROCRAIL_PLUGIN_DEBUG === '1' || process.env.ROCRAIL_PLUGIN_DEBUG === 'true';

/**
 * RCP frame: header only carries byte length + logical name; the XML payload follows
 * immediately after </xmlh> and is what `size` counts (same as official Rocview/Rocrail clients).
 */
function buildHeader(xmlMsg, name) {
  const size = Buffer.byteLength(xmlMsg, 'utf8');
  return `<xmlh><xml size="${size}" name="${name}"/></xmlh>${xmlMsg}`;
}

function parseXmlHeader(buffer) {
  const str = buffer.toString('utf8');
  const startIdx = str.indexOf('<xmlh>');
  const endIdx = str.indexOf('</xmlh>', startIdx === -1 ? 0 : startIdx);
  if (startIdx === -1 || endIdx === -1) return null;
  const headerStr = str.slice(startIdx, endIdx + '</xmlh>'.length);

  const sizeMatch = headerStr.match(/size="(\d+)"/);
  const nameMatch = headerStr.match(/name="([^"]+)"/);
  if (!sizeMatch) return null;

  const bodyLen = parseInt(sizeMatch[1], 10);
  const name = nameMatch ? nameMatch[1] : '';
  const headerLen = Buffer.byteLength(headerStr, 'utf8');
  const headerStart = Buffer.byteLength(str.slice(0, startIdx), 'utf8');
  return {
    headerStart,
    headerLen,
    bodyLen,
    name,
    totalLen: headerStart + headerLen + bodyLen,
  };
}

function parseAttrs(str) {
  const attrs = {};
  const regex = /(\w+)=["']([^"']*)["']/g;
  let m;
  while ((m = regex.exec(str)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

/** Interpret Rocrail / Rocview XML attribute values as booleans (decoder f0–f32, etc.). */
function rocrailAttrBool(v) {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'on' || s === 'yes';
}

/** True when Rocrail controls this loco in km/h (`V` / `V_max` are km/h, not percent). */
export function isLocoKmhMode(loco) {
  const mode = String(loco?.V_mode ?? loco?.rawAttrs?.V_mode ?? 'percent')
    .trim()
    .toLowerCase();
  return mode === 'kmh' || mode === 'km/h';
}

/**
 * Max settable speed for dial / buttons: Rocrail `V_max` (km/h or %), with `Vmaxkmh` as km/h fallback.
 */
export function locoVMax(loco) {
  const rawMax = parseInt(String(loco?.V_max ?? loco?.rawAttrs?.V_max ?? ''), 10);
  if (Number.isFinite(rawMax) && rawMax > 0) {
    return isLocoKmhMode(loco) ? rawMax : Math.min(100, rawMax);
  }
  if (isLocoKmhMode(loco)) {
    const vmaxkmh = parseInt(String(loco?.Vmaxkmh ?? loco?.rawAttrs?.Vmaxkmh ?? ''), 10);
    if (Number.isFinite(vmaxkmh) && vmaxkmh > 0) return vmaxkmh;
    return 120;
  }
  return 100;
}

/** Clamp commanded `V` to `0 … locoVMax(loco)`. */
export function clampLocoVelocity(loco, v) {
  const n = parseInt(String(v), 10);
  const val = Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.min(locoVMax(loco), val));
}

/**
 * True if locomotive function `fnIndex` (0–32) is on, using top-level `locoProps` and/or `rawAttrs`.
 * Falls back to Rocrail's catalog status fields `fn` (F0/lights) and `fx` (bitmask for F1+).
 */
export function rocrailFnIsActive(locoProps, fnIndex) {
  if (!locoProps) return false;
  const n = Number(fnIndex);
  if (!Number.isFinite(n) || n < 0 || n > 32) return false;
  const kLower = `f${n}`;
  const kUpper = `F${n}`;
  let v;
  if (Object.prototype.hasOwnProperty.call(locoProps, kLower)) v = locoProps[kLower];
  else if (Object.prototype.hasOwnProperty.call(locoProps, kUpper)) v = locoProps[kUpper];
  else if (locoProps.rawAttrs) {
    const r = locoProps.rawAttrs;
    if (Object.prototype.hasOwnProperty.call(r, kLower)) v = r[kLower];
    else if (Object.prototype.hasOwnProperty.call(r, kUpper)) v = r[kUpper];
    else if (n === 0 && Object.prototype.hasOwnProperty.call(r, 'fn')) v = r.fn;
    else if (n >= 1 && Object.prototype.hasOwnProperty.call(r, 'fx')) {
      const fx = parseInt(String(r.fx), 10) || 0;
      return !!(fx & (1 << (n - 1)));
    }
  }
  return rocrailAttrBool(v);
}

/**
 * Apply Rocrail function status from an attribute map into `locoProps` / `rawAttrs`.
 * Accepts explicit `f0`…`f32` (from `<fn/>` traffic) and catalog fields `fn` (F0/lights)
 * + `fx` (bitmask, bit0=F1 …). Explicit `fN` wins over `fn`/`fx`.
 * @returns {boolean} true if any function bit changed
 */
function mergeFnAttrsFromAttrMap(locoProps, attrs) {
  if (!locoProps || !attrs || typeof attrs !== 'object') return false;
  let updated = false;
  if (!locoProps.rawAttrs || typeof locoProps.rawAttrs !== 'object') locoProps.rawAttrs = {};

  const setBit = (i, on, rawVal) => {
    const kl = `f${i}`;
    const b = !!on;
    if (!!locoProps[kl] !== b) updated = true;
    locoProps[kl] = b;
    locoProps.rawAttrs[kl] = rawVal != null && `${rawVal}`.trim() !== '' ? String(rawVal) : b ? 'true' : 'false';
  };

  // Catalog / live <lc> status: lights + function bitmask (display).
  if (Object.prototype.hasOwnProperty.call(attrs, 'fn')) {
    setBit(0, rocrailAttrBool(attrs.fn), attrs.fn);
    locoProps.rawAttrs.fn = String(attrs.fn);
  }
  if (Object.prototype.hasOwnProperty.call(attrs, 'fx')) {
    const fx = parseInt(String(attrs.fx), 10) || 0;
    locoProps.rawAttrs.fx = String(attrs.fx);
    for (let i = 1; i <= 32; i++) {
      setBit(i, !!(fx & (1 << (i - 1))), null);
    }
  }

  // Explicit per-function flags override fn/fx when present (typical on <fn/>).
  for (let i = 0; i <= 32; i++) {
    const kl = `f${i}`;
    const ku = `F${i}`;
    const hasL = Object.prototype.hasOwnProperty.call(attrs, kl);
    const hasU = Object.prototype.hasOwnProperty.call(attrs, ku);
    if (!hasL && !hasU) continue;
    const rawVal = attrs[kl] ?? attrs[ku];
    setBit(i, rocrailAttrBool(rawVal), rawVal);
  }
  return updated;
}

/** Merge live throttle fields (`V`, `V_realkmh`, `dir`) from a Rocrail `<lc/>` / `<fn/>` attribute map. */
function mergeLcMotionAttrsFromAttrMap(locoProps, attrs) {
  if (!locoProps || !attrs || typeof attrs !== 'object') return false;
  let updated = false;
  if (!locoProps.rawAttrs || typeof locoProps.rawAttrs !== 'object') locoProps.rawAttrs = {};

  if (Object.prototype.hasOwnProperty.call(attrs, 'V')) {
    // Do not clamp to 100: in km/h mode `V` can exceed 100 (limited by V_max when commanding).
    const v = Math.max(0, parseInt(String(attrs.V), 10) || 0);
    if (locoProps.V !== v) updated = true;
    locoProps.V = v;
    locoProps.rawAttrs.V = String(v);
  }
  if (Object.prototype.hasOwnProperty.call(attrs, 'V_max')) {
    const vmax = parseInt(String(attrs.V_max), 10) || 0;
    if (vmax > 0) {
      if (locoProps.V_max !== vmax) updated = true;
      locoProps.V_max = vmax;
      locoProps.rawAttrs.V_max = String(vmax);
    }
  }
  if (Object.prototype.hasOwnProperty.call(attrs, 'V_mode')) {
    const mode = String(attrs.V_mode);
    if (locoProps.V_mode !== mode) updated = true;
    locoProps.V_mode = mode;
    locoProps.rawAttrs.V_mode = mode;
  }
  if (Object.prototype.hasOwnProperty.call(attrs, 'V_realkmh')) {
    const rk = parseInt(String(attrs.V_realkmh), 10) || 0;
    if (locoProps.V_realkmh !== rk) updated = true;
    locoProps.V_realkmh = rk;
    locoProps.rawAttrs.V_realkmh = String(rk);
  }
  if (Object.prototype.hasOwnProperty.call(attrs, 'dir')) {
    const d = rocrailAttrBool(attrs.dir);
    if (locoProps.dir !== d) updated = true;
    locoProps.dir = d;
    locoProps.rawAttrs.dir = d ? 'true' : 'false';
  }
  return updated;
}

/** Apply function bits and throttle motion fields from one Rocrail attribute map. */
function mergeLcOrFnAttrsFromAttrMap(locoProps, attrs) {
  let any = false;
  if (mergeFnAttrsFromAttrMap(locoProps, attrs)) any = true;
  if (mergeLcMotionAttrsFromAttrMap(locoProps, attrs)) any = true;
  return any;
}

/**
 * Merge live `<lc/>` / `<fn/>` snippets from Rocrail broadcasts into the selected loco's props.
 * @returns {boolean} true if any function bit or throttle field changed for `locoId`
 */
function idsMatchRocrailLc(aId, locoId) {
  if (aId == null || locoId == null) return false;
  const a = String(aId);
  const b = String(locoId);
  return a === b || a.toLowerCase() === b.toLowerCase();
}

export function mergeLcOrFnAttrsIntoLocoProps(locoProps, bodyXml, locoId) {
  if (!locoProps || !bodyXml || !locoId) return false;
  let any = false;
  const lcRe = /<lc\s+([^>]+)\/?>/gi;
  let m;
  while ((m = lcRe.exec(bodyXml)) !== null) {
    const a = parseAttrs(m[1]);
    if (!idsMatchRocrailLc(a.id, locoId)) continue;
    if (mergeLcOrFnAttrsFromAttrMap(locoProps, a)) any = true;
  }
  const fnRe = /<fn\s+([^>]+)\/?>/gi;
  while ((m = fnRe.exec(bodyXml)) !== null) {
    const a = parseAttrs(m[1]);
    if (!idsMatchRocrailLc(a.id, locoId)) continue;
    if (mergeLcOrFnAttrsFromAttrMap(locoProps, a)) any = true;
  }
  return any;
}

/** @typedef {Record<string, any> & { rawAttrs?: Record<string, string> }} LocoFnCacheSlice */

/**
 * Locate cached slice for locomotive id, matching keys case‑insensitively (Rocview id casing may vary).
 *
 * @param {Map<string, LocoFnCacheSlice>} cacheMap
 */
export function lookupLocoFnCacheSlice(cacheMap, locoId) {
  if (!cacheMap || locoId == null) return undefined;
  const s = String(locoId);
  if (cacheMap.has(s)) return cacheMap.get(s);
  for (const [key, slice] of cacheMap) {
    if (idsMatchRocrailLc(key, s)) return slice;
  }
  return undefined;
}

/** @internal */
function getOrCreateFnCacheSlot(cacheMap, rawIdFromXml) {
  if (!cacheMap || rawIdFromXml == null) return null;
  const s = String(rawIdFromXml);
  for (const key of cacheMap.keys()) {
    if (idsMatchRocrailLc(key, s)) return cacheMap.get(key);
  }
  const slot = {};
  cacheMap.set(s, slot);
  return slot;
}

/**
 * Populate / merge locomotive decoder function keys from every `<lc/>` / `<fn/>` snippet (lclist, plan, unsolicited push, …). Sparse merge.
 */
export function ingestLcFnXmlIntoCaches(cacheMap, bodyXml) {
  if (!cacheMap || !bodyXml || typeof bodyXml !== 'string') return;
  const lcRe = /<lc\s+([^>]+)\/?>/gi;
  let m;
  while ((m = lcRe.exec(bodyXml)) !== null) {
    const a = parseAttrs(m[1]);
    if (!a?.id) continue;
    const slot = getOrCreateFnCacheSlot(cacheMap, a.id);
    if (!slot) continue;
    mergeLcOrFnAttrsFromAttrMap(slot, a);
  }
  const fnRe = /<fn\s+([^>]+)\/?>/gi;
  while ((m = fnRe.exec(bodyXml)) !== null) {
    const a = parseAttrs(m[1]);
    if (!a?.id) continue;
    const slot = getOrCreateFnCacheSlot(cacheMap, a.id);
    if (!slot) continue;
    mergeLcOrFnAttrsFromAttrMap(slot, a);
  }
}

/**
 * Overlay cached `f*` keys that originated from Rocrail traffic onto lcprops-loaded state before drawing throttle OLED tiles.
 *
 * @param {LocoFnCacheSlice | undefined} cached
 */
export function overlayCachedLcFnOntoLocoProps(locoProps, cached) {
  if (!locoProps || !cached || typeof cached !== 'object') return;
  const ra = cached.rawAttrs && typeof cached.rawAttrs === 'object' ? cached.rawAttrs : null;
  for (let i = 0; i <= 32; i++) {
    const kl = `f${i}`;
    if (!Object.prototype.hasOwnProperty.call(cached, kl)) continue;
    locoProps[kl] = !!cached[kl];
    if (!locoProps.rawAttrs || typeof locoProps.rawAttrs !== 'object') locoProps.rawAttrs = {};
    if (ra && Object.prototype.hasOwnProperty.call(ra, kl)) {
      locoProps.rawAttrs[kl] = String(ra[kl]);
    } else {
      locoProps.rawAttrs[kl] = locoProps[kl] ? 'true' : 'false';
    }
  }
  if (Object.prototype.hasOwnProperty.call(cached, 'V')) {
    locoProps.V = cached.V;
    if (ra?.V != null) locoProps.rawAttrs.V = String(ra.V);
  }
  if (Object.prototype.hasOwnProperty.call(cached, 'V_realkmh')) {
    locoProps.V_realkmh = cached.V_realkmh;
    if (ra?.V_realkmh != null) locoProps.rawAttrs.V_realkmh = String(ra.V_realkmh);
  }
  if (Object.prototype.hasOwnProperty.call(cached, 'dir')) {
    locoProps.dir = !!cached.dir;
    if (ra?.dir != null) locoProps.rawAttrs.dir = String(ra.dir);
  }
}

/**
 * Write known `locoProps` function bits back into cache (after local merges or lcprops+friends).
 * Only keys that are actually present on `locoProps` are written — never invent 33× false
 * (that previously poisoned the cache after lcprops omitted live `fN` / only sent `fn`/`fx`).
 *
 * @param {Map<string, LocoFnCacheSlice>} cacheMap
 */
export function syncLocoFnCacheFromLocoProps(cacheMap, locoProps) {
  if (!cacheMap || !locoProps?.id) return;
  const slot = getOrCreateFnCacheSlot(cacheMap, locoProps.id);
  if (!slot || typeof slot !== 'object') return;
  if (!slot.rawAttrs || typeof slot.rawAttrs !== 'object') slot.rawAttrs = {};
  for (let i = 0; i <= 32; i++) {
    const kl = `f${i}`;
    if (!Object.prototype.hasOwnProperty.call(locoProps, kl)) continue;
    slot[kl] = !!locoProps[kl];
    if (locoProps.rawAttrs && typeof locoProps.rawAttrs === 'object' && kl in locoProps.rawAttrs) {
      slot.rawAttrs[kl] = String(locoProps.rawAttrs[kl]);
    } else {
      slot.rawAttrs[kl] = locoProps[kl] ? 'true' : 'false';
    }
  }
  if (locoProps.rawAttrs && typeof locoProps.rawAttrs === 'object') {
    if ('fn' in locoProps.rawAttrs) slot.rawAttrs.fn = String(locoProps.rawAttrs.fn);
    if ('fx' in locoProps.rawAttrs) slot.rawAttrs.fx = String(locoProps.rawAttrs.fx);
  }
  if (locoProps.V != null) {
    slot.V = locoProps.V;
    slot.rawAttrs.V = String(locoProps.rawAttrs?.V ?? locoProps.V);
  }
  if (locoProps.V_realkmh != null) {
    slot.V_realkmh = locoProps.V_realkmh;
    slot.rawAttrs.V_realkmh = String(locoProps.rawAttrs?.V_realkmh ?? locoProps.V_realkmh);
  }
  if (locoProps.dir != null) {
    slot.dir = !!locoProps.dir;
    slot.rawAttrs.dir = String(locoProps.rawAttrs?.dir ?? (locoProps.dir ? 'true' : 'false'));
  }
}

/* ------------------------------------------------------------------------ *
 * Accessories (track diagram elements): turnouts (sw), signals (sg),
 * outputs/buttons (co), sensors (fb), blocks (bk), tracks (tk), turntables (tt)
 * ------------------------------------------------------------------------ */

/** XML tags of track-diagram elements mirrored into the accessory state cache. */
export const ACCESSORY_KINDS = ['sw', 'sg', 'co', 'fb', 'bk', 'tk', 'tt'];

/** Accessory kinds that accept a command on key press (others are status-only). */
export const CONTROLLABLE_ACCESSORY_KINDS = ['sw', 'sg', 'co', 'tt'];

export function accessoryCacheKey(kind, id) {
  return `${kind}|${String(id).toLowerCase()}`;
}

/**
 * Clockwise rotation (degrees) for plan element orientation. Default layout is **east** (0°).
 * north/nord = 90° CW, west = 180°, south/süd = 270° CW.
 */
export function accessoryOriRotationCw(ori) {
  const s = String(ori ?? 'east')
    .trim()
    .toLowerCase()
    .replace(/ü/g, 'u');
  const map = {
    east: 0,
    ost: 0,
    north: 90,
    nord: 90,
    west: 180,
    south: 270,
    sud: 270,
  };
  return map[s] ?? 0;
}

/**
 * Merge every `<sw/> <sg/> <co/> <fb/> <bk/> <tk/> <tt/>` snippet from any Rocrail
 * XML body (plan reply, list replies, unsolicited pushes) into the accessory cache.
 * @param {Map<string, {kind: string, id: string, attrs: Record<string,string>}>} cacheMap
 * @returns {string[]} cache keys whose attributes changed
 */
export function ingestAccessoryXmlIntoCache(cacheMap, bodyXml) {
  if (!cacheMap || typeof bodyXml !== 'string' || !bodyXml) return [];
  const changed = [];
  for (const kind of ACCESSORY_KINDS) {
    const re = new RegExp(`<${kind}\\s+([^>]+?)/?>`, 'gi');
    let m;
    while ((m = re.exec(bodyXml)) !== null) {
      const a = parseAttrs(m[1]);
      if (!a?.id) continue;
      const key = accessoryCacheKey(kind, a.id);
      const prev = cacheMap.get(key);
      const entry = prev || { kind, id: a.id, attrs: {} };
      let any = !prev;
      for (const [k, v] of Object.entries(a)) {
        if (entry.attrs[k] !== v) {
          entry.attrs[k] = v;
          any = true;
        }
      }
      if (!prev) cacheMap.set(key, entry);
      if (any && !changed.includes(key)) changed.push(key);
    }
  }
  return changed;
}

/**
 * Find a cached accessory by id (case-insensitive). `kind` restricts to one element
 * type; 'auto' scans all kinds in controllable-first order.
 */
export function lookupAccessoryEntry(cacheMap, itemId, kind = 'auto') {
  if (!cacheMap || !itemId) return undefined;
  const kinds = kind && kind !== 'auto' ? [kind] : ACCESSORY_KINDS;
  const idLower = String(itemId).toLowerCase();
  for (const k of kinds) {
    const direct = cacheMap.get(`${k}|${idLower}`);
    if (direct) return direct;
  }
  return undefined;
}

/**
 * Rocrail SVG theme file (e.g. SpDrS60) visualising this accessory's current state.
 * Naming follows the official themes: `turnoutleft[-t].svg`, `threeway[-tl|-tr].svg`,
 * `signalmain-r.svg`, `button-0-on.svg`, `sensor-on.svg`, `block-occ.svg`, `straight.svg`, …
 * @returns {string | null} file name, or null when no static theme file exists (e.g. turntable)
 */
export function accessoryThemeIconFile(entry) {
  if (!entry) return null;
  const a = entry.attrs || {};
  const state = String(a.state ?? '').toLowerCase();
  if (entry.kind === 'sw') {
    const t = String(a.type ?? 'left').toLowerCase();
    if (t === 'decoupler') return `decoupler${state === 'on' ? '-on' : ''}.svg`;
    if (t === 'threeway') {
      return `threeway${state === 'left' ? '-tl' : state === 'right' ? '-tr' : ''}.svg`;
    }
    if (t === 'dcrossing') {
      const suffix = state === 'left' ? '-tl' : state === 'right' ? '-tr' : state === 'turnout' ? '-t' : '';
      return `dcrossingleft${suffix}.svg`;
    }
    if (t === 'crossing' || t === 'ccrossing') return `${t}.svg`;
    const base = t === 'right' ? 'turnoutright' : 'turnoutleft';
    return `${base}${state === 'turnout' ? '-t' : ''}.svg`;
  }
  if (entry.kind === 'sg') {
    const semaphore = String(a.type ?? '').toLowerCase() === 'semaphore';
    const sgKind = String(a.signal ?? '').toLowerCase();
    const base =
      (semaphore ? 'semaphore' : 'signal') +
      (sgKind === 'distant' ? 'distant' : sgKind === 'shunting' ? 'shunting' : 'main');
    const aspect =
      state === 'green' ? '-g' : state === 'yellow' ? '-y' : state === 'white' ? '-w' : state === 'blank' ? '-b' : '-r';
    return `${base}${aspect}.svg`;
  }
  // Outputs/buttons: built-in tile uses red (off) / green (on); SpDrS60 theme SVGs are yellow.
  if (entry.kind === 'co') return null;
  if (entry.kind === 'fb') return `sensor-${state === 'true' ? 'on' : 'off'}.svg`;
  if (entry.kind === 'bk') {
    const locid = String(a.locid ?? '').trim();
    if (locid) return state.startsWith('res') ? 'block-res.svg' : 'block-occ.svg';
    if (state === 'closed') return 'block-closed.svg';
    if (state === 'ghost') return 'block-ghost.svg';
    return 'block.svg';
  }
  if (entry.kind === 'tk') {
    const t = String(a.type ?? 'straight').toLowerCase();
    if (['curve', 'buffer', 'dir', 'dirall', 'connector'].includes(t)) return `${t}.svg`;
    return 'straight.svg';
  }
  return null;
}

function escapeXmlAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function parseLcList(xml) {
  const locos = [];
  const lcRegex = /<lc\s+([^>]+)\/?>/gi;
  let m;
  while ((m = lcRegex.exec(xml)) !== null) {
    const attrs = parseAttrs(m[1]);
    if (attrs.id) {
      locos.push({
        id: attrs.id,
        addr: parseInt(attrs.addr, 10) || 0,
        name: attrs.name || attrs.id,
        image: attrs.image || '',
        V_raw: parseInt(attrs.V_raw, 10) ?? -1,
        V_rawMax: parseInt(attrs.V_rawMax, 10) ?? 100,
        dir: attrs.dir === 'true',
        fncnt: parseInt(attrs.fncnt, 10) || 4,
        V_mode: attrs.V_mode || 'percent',
        V: parseInt(attrs.V, 10) ?? -1,
        V_max: parseInt(attrs.V_max, 10) || 0,
        V_realkmh: parseInt(attrs.V_realkmh, 10) || 0,
        Vmaxkmh: parseInt(attrs.Vmaxkmh, 10) || 0,
        /** Rocrail operating mode: stop, idle, auto, … */
        mode: attrs.mode || '',
      });
    }
  }
  return locos;
}

function sortLocosByName(locos) {
  if (!Array.isArray(locos)) return [];
  return [...locos].sort((a, b) => {
    const na = (a.name || a.id || '').toString();
    const nb = (b.name || b.id || '').toString();
    return na.localeCompare(nb, undefined, { sensitivity: 'base', numeric: true });
  });
}

function parseLcProps(xml, preferredId = null) {
  let lcAttrString = null;
  if (preferredId) {
    const re = /<lc\s+([^>]+)\/?>/gi;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const a = parseAttrs(m[1]);
      if (idsMatchRocrailLc(a.id, preferredId)) {
        lcAttrString = m[1];
        break;
      }
    }
  }
  if (!lcAttrString) {
    const lcMatch = xml.match(/<lc\s+([^>]+)\/?>/i);
    if (!lcMatch) return null;
    const attrs0 = parseAttrs(lcMatch[1]);
    if (preferredId && !idsMatchRocrailLc(attrs0.id, preferredId)) return null;
    lcAttrString = lcMatch[1];
  }
  const attrs = parseAttrs(lcAttrString);
  const fundefs = [];
  const fundefRegex = /<fundef\s+([^>]+)\/?>/g;
  let m;
  while ((m = fundefRegex.exec(xml)) !== null) {
    const f = parseAttrs(m[1]);
    fundefs.push({
      fn: parseInt(f.fn, 10) || 0,
      text: f.text || `F${f.fn || 0}`,
      icon: f.icon || '',
      hide: f.hide === 'true',
      disable: f.disable === 'true',
    });
  }
  const loco = {
    id: attrs.id,
    addr: parseInt(attrs.addr, 10) || 0,
    name: attrs.name || attrs.id,
    V_raw: parseInt(attrs.V_raw, 10) ?? 0,
    V_rawMax: parseInt(attrs.V_rawMax, 10) ?? 100,
    dir: attrs.dir === 'true',
    fncnt: parseInt(attrs.fncnt, 10) || 4,
    V_mode: attrs.V_mode || 'percent',
    V: parseInt(attrs.V, 10) ?? 0,
    V_max: parseInt(attrs.V_max, 10) || 0,
    V_realkmh: parseInt(attrs.V_realkmh, 10) || 0,
    Vmaxkmh: parseInt(attrs.Vmaxkmh, 10) || 0,
    fundefs: fundefs.filter((f) => !f.hide && !f.disable).sort((a, b) => a.fn - b.fn),
    /** Full `<lc …/>` attribute map for replay on `<fn …/>` (Rocview sends a merged snapshot). */
    rawAttrs: { ...attrs },
  };
  // Decode fn/fx and any explicit fN — do not invent 33× false for missing attrs.
  mergeFnAttrsFromAttrMap(loco, attrs);
  return loco;
}

/**
 * True only for a real lcprops-style payload, not a live <lc> status tick that happens
 * to carry the same id (those are small and usually lack <fundef>).
 */
function isLcpropsReplyXml(body, locoId) {
  const p = parseLcProps(body, locoId);
  if (!p || p.id !== locoId) return false;
  if (/<fundef\s/i.test(body)) return true;
  if (Array.isArray(p.fundefs) && p.fundefs.length > 0) return true;
  if (body.length >= 1000) return true;
  return false;
}

/** Rocrail `fn/@group`: 0=all, 1=f1-f4, 2=f5-f8, ... 8=f29-f32 */
function fnGroupForIndex(fn) {
  const n = Number(fn);
  if (!Number.isFinite(n) || n < 0) return 0;
  if (n === 0) return 0;
  if (n <= 32) return Math.floor((n - 1) / 4) + 1;
  return 0;
}

function fnBoolAt(snap, raw, i, changedIndex, newOn) {
  if (i === changedIndex) return !!newOn;
  const k = `f${i}`;
  /** Prefer live `locoProps` (updated after toggles + getLocoProps); `rawAttrs` is last lcprops snapshot and can be stale. */
  if (snap && Object.prototype.hasOwnProperty.call(snap, k)) return rocrailAttrBool(snap[k]);
  if (raw && Object.prototype.hasOwnProperty.call(raw, k)) return rocrailAttrBool(raw[k]);
  if (raw && Object.prototype.hasOwnProperty.call(raw, `F${i}`)) return rocrailAttrBool(raw[`F${i}`]);
  return false;
}

/**
 * Attribute order and set copied from Rocview / official Rocrail client `<fn/>` (not a full `<lc/>` dump).
 * See user reference: no `cmd` on `<fn>`, `throttleid=""`, and a fixed subset of loco fields.
 */
const ROCVIEW_FN_ATTR_ORDER = [
  'shift',
  'longclick',
  'group',
  'fnchanged',
  'fndesc',
  'fnchangedstate',
  'fncnt',
  'id',
  ...Array.from({ length: 33 }, (_, i) => `f${i}`),
  'throttleid',
  'controlcode',
  'slavecode',
  'actor',
  'server',
  'iid',
  'shortid',
  'uid',
  'sid',
  'dir',
  'addr',
  'secaddr',
  'V',
  'placing',
  'blockenterside',
  'blockenterid',
  'modeevent',
  'mode',
  'modereason',
  'resumeauto',
  'manual',
  'shunting',
  'standalone',
  'blockid',
  'destblockid',
  'fn',
  'runtime',
  'mtime',
  'rdate',
  'mint',
  'active',
  'waittime',
  'scidx',
  'scheduleid',
  'tourid',
  'scheduleinithour',
  'len',
  'weight',
  'train',
  'trainlen',
  'trainweight',
  'V_realkmh',
  'fifotop',
  'image',
  'imagenr',
  'energypercentage',
  'lookupschedule',
  'pause',
  'consist',
];

function coalesceFnAttr(raw, snap, k, defaultVal = '') {
  if (raw && Object.prototype.hasOwnProperty.call(raw, k)) {
    const v = raw[k];
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    return String(v);
  }
  if (snap && Object.prototype.hasOwnProperty.call(snap, k)) {
    const v = snap[k];
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    return String(v);
  }
  return defaultVal;
}

/**
 * Prefer live `snap` values (direction / speed refreshed locally or from merges) over stale lcprops copy in `raw`.
 * Rocrail applies `<fn/>` attributes verbatim; stale `dir`/`V` from lcprops wrongly reset throttle state.
 */
function snapFirstLcMotionAttr(raw, snap, k, defaultVal = '') {
  if (snap && Object.prototype.hasOwnProperty.call(snap, k)) {
    const v = snap[k];
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (typeof v === 'string' && v.length) return String(v);
  }
  if (raw && Object.prototype.hasOwnProperty.call(raw, k)) {
    const v = raw[k];
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    return String(v);
  }
  return defaultVal;
}

/**
 * Build an `<fn …/>` body matching Rocview: fixed attribute set/order, no `cmd`, `throttleid=""`.
 * @param {string} locoId
 * @param {number} fnIndex
 * @param {boolean} on
 * @param {string} _throttleId  Unused on `<fn/>` (Rocview sends `throttleid=""`); kept for API stability.
 * @param {Record<string, any> | null} snapshot  Loco props from getLocoProps (includes rawAttrs when available)
 */
function buildFnCommandXml(locoId, fnIndex, on, _throttleId, snapshot) {
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const raw = snap.rawAttrs && typeof snap.rawAttrs === 'object' ? { ...snap.rawAttrs } : {};
  const n = Math.min(32, Math.max(0, parseInt(String(fnIndex), 10) || 0));
  const idVal = snap.id ?? raw.id ?? locoId;
  const fnc = parseInt(String(snap.fncnt ?? raw.fncnt ?? 28), 10) || 28;

  const fundefs = Array.isArray(snap.fundefs) ? snap.fundefs : [];
  const fd = fundefs.find((x) => x.fn === n);
  const fndesc = fd?.text ?? `F${n}`;

  const parts = [];
  const pushAttr = (k, v) => {
    const s = v === undefined || v === null ? '' : String(v);
    parts.push(`${k}="${escapeXmlAttr(s)}"`);
  };

  for (const k of ROCVIEW_FN_ATTR_ORDER) {
    if (k === 'group') {
      pushAttr(k, String(fnGroupForIndex(n)));
    } else if (k === 'fnchanged') {
      pushAttr(k, String(n));
    } else if (k === 'fndesc') {
      pushAttr(k, fndesc);
    } else if (k === 'fnchangedstate') {
      pushAttr(k, on ? 'true' : 'false');
    } else if (k === 'fncnt') {
      pushAttr(k, String(fnc));
    } else if (k === 'id') {
      pushAttr(k, idVal);
    } else if (/^f\d+$/.test(k)) {
      const i = parseInt(k.slice(1), 10);
      pushAttr(k, fnBoolAt(snap, raw, i, n, on) ? 'true' : 'false');
    } else if (k === 'throttleid') {
      pushAttr(k, '');
    } else if (k === 'dir') {
      pushAttr(k, snapFirstLcMotionAttr(raw, snap, k, 'false'));
    } else if (
      k === 'shift' ||
      k === 'longclick' ||
      k === 'placing' ||
      k === 'modeevent' ||
      k === 'resumeauto' ||
      k === 'manual' ||
      k === 'shunting' ||
      k === 'standalone' ||
      k === 'fifotop' ||
      k === 'lookupschedule' ||
      k === 'pause'
    ) {
      pushAttr(k, coalesceFnAttr(raw, snap, k, 'false'));
    } else if (k === 'active' || k === 'blockenterside') {
      pushAttr(k, coalesceFnAttr(raw, snap, k, 'true'));
    } else if (k === 'mode') {
      pushAttr(k, coalesceFnAttr(raw, snap, k, 'stop'));
    } else if (k === 'uid' || k === 'sid') {
      pushAttr(k, coalesceFnAttr(raw, snap, k, '0'));
    } else if (k === 'scidx') {
      pushAttr(k, coalesceFnAttr(raw, snap, k, '-1'));
    } else if (k === 'V' || k === 'V_realkmh') {
      pushAttr(k, snapFirstLcMotionAttr(raw, snap, k, '0'));
    } else if (k === 'actor') {
      pushAttr(k, coalesceFnAttr(raw, snap, k, 'user'));
    } else if (k === 'fn') {
      pushAttr(k, coalesceFnAttr(raw, snap, 'fn', 'false'));
    } else {
      pushAttr(k, coalesceFnAttr(raw, snap, k, ''));
    }
  }

  return `<fn ${parts.join(' ')}/>`;
}

function parsePlanLclist(planXml) {
  const lclistMatch = planXml.match(/<lclist>([\s\S]*?)<\/lclist>/);
  if (!lclistMatch) return [];
  return parseLcList(lclistMatch[1]);
}

/**
 * Rocrail pushes many unsolicited events to all TCP clients (clock, state, lc updates…).
 * Those must NOT consume the same FIFO as request/response pairs, or the next await
 * resolves with the wrong XML and the queue drifts until everything hangs.
 *
 * @param {string} body
 * @param {{ waitKind?: string, locoId?: string, matchBody?: (b: string) => boolean } | null} head
 */
function isBroadcastXml(body, head) {
  if (!body || typeof body !== 'string') return true;
  const s = body.slice(0, 400);
  if (/<clock\s/i.test(s)) return true;
  if (/<state\s/i.test(s)) return true;
  if (/<exception/i.test(s)) return true;
  if (/<auto\s/i.test(s)) return true;
  if (/<sys\s/i.test(s)) return true;
  if (/<cmderr/i.test(s)) return true;
  if (/<rnacc/i.test(s)) return true;
  if (/<stlink/i.test(s)) return true;
  if (/<(sensor|sw|co|fb|bk|st|sg|output|module|zlevel)\s/i.test(s)) return true;
  if (/<plan\s/i.test(s) && !/<lclist>/i.test(body) && head?.waitKind === 'lclist') return true;

  if (head?.waitKind === 'lclist' && /<lc\s/i.test(body) && !body.includes('<lclist>')) return true;

  if (head?.waitKind === 'lcprops' && head.locoId && /<lc\s/i.test(body)) {
    const p = parseLcProps(body, head.locoId);
    if (!p || p.id !== head.locoId) return true;
    if (head.matchBody && !head.matchBody(body)) return true;
  }

  if (/<plan\s/i.test(s) && !/<lclist>/i.test(body) && head?.waitKind === 'plan') return true;

  return false;
}

export class RocrailClient {
  constructor(host = '127.0.0.1', port = 8051, { log = () => {} } = {}) {
    this.host = host;
    this.port = port;
    this.log = log;
    this.socket = null;
    this.throttleId = `opendeck-${Math.random().toString(36).slice(2, 10)}`;
    this._buffer = Buffer.alloc(0);
    /** @type {{ resolve: Function, reject: Function, matchBody: (b: string) => boolean }[]} */
    this._pending = [];
    /** Serialize TCP commands so two awaits cannot interleave replies. */
    this._ioChain = Promise.resolve();
    /** @type {null | ((body: string, xmlName: string) => void)} */
    this.onPush = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();
      this._buffer = Buffer.alloc(0);
      this.socket.on('error', (err) => {
        this.log(`socket error: ${err?.message || String(err)}`);
        reject(err);
      });
      this.socket.on('close', (hadError) => {
        this.log(`socket closed${hadError ? ' (hadError)' : ''}`);
        while (this._pending.length) {
          const p = this._pending.shift();
          p?.reject?.(new Error('Socket closed'));
        }
      });
      this.socket.on('connect', () => {
        this.log(`connected to ${this.host}:${this.port}`);
        resolve();
      });
      this.log(`connecting to ${this.host}:${this.port}...`);
      this.socket.connect(this.port, this.host);
      this.socket.on('data', (data) => this._onData(data));
    });
  }

  disconnect() {
    if (this.socket) {
      this.log('disconnect requested');
      this.socket.destroy();
      this.socket = null;
    }
  }

  _onData(data) {
    if (RR_DEBUG) this.log(`rx bytes=${data.length}`);
    this._buffer = Buffer.concat([this._buffer, data]);
    while (this._buffer.length > 0) {
      const info = parseXmlHeader(this._buffer);
      if (!info) {
        if (this._buffer.length > 200) {
          const preview = this._buffer.toString('utf8', 0, 200);
          this.log(
            `unable to parse xml header yet, bufferPreview="${preview
              .replace(/\s+/g, ' ')
              .slice(0, 160)}..."`
          );
        }
        break;
      }
      if (this._buffer.length < info.totalLen) break;
      const bodyStart = info.headerStart + info.headerLen;
      const bodyEnd = bodyStart + info.bodyLen;
      const body = this._buffer.subarray(bodyStart, bodyEnd).toString('utf8');
      // Drop everything up to the end of this message.
      this._buffer = this._buffer.subarray(info.totalLen);
      if (RR_DEBUG) {
        this.log(`rx xml name=${info.name} size=${info.bodyLen} body=${body}`);
      } else {
        this.log(`rx xml name=${info.name || '(empty)'} size=${info.bodyLen}`);
      }
      try {
        this.onPush?.(body, info.name || '');
      } catch (e) {
        this.log(`onPush handler error: ${e?.message || String(e)}`);
      }
      if (this._pending.length === 0) {
        if (RR_DEBUG && !isBroadcastXml(body, null)) {
          this.log(`rx orphan (no pending waiter) name=${info.name || '(empty)'} preview=${body.slice(0, 80)}`);
        }
        continue;
      }
      const head = this._pending[0];
      if (isBroadcastXml(body, head)) {
        continue;
      }
      if (!head.matchBody(body)) {
        if (RR_DEBUG) {
          this.log(`rx skip (matcher mismatch) name=${info.name || '(empty)'} preview=${body.slice(0, 120)}`);
        }
        continue;
      }
      this._pending.shift();
      head.resolve({ name: info.name, body });
    }
  }

  /**
   * @param {string} xmlType
   * @param {string} xmlMsg
   * @param {{ expectResponse?: boolean, matchBody?: (body: string) => boolean, waitKind?: string, locoId?: string }} [opts]
   */
  _send(xmlType, xmlMsg, opts = {}) {
    const expectResponse = opts.expectResponse !== false;
    const matchBody = opts.matchBody ?? (() => true);
    const waitKind = opts.waitKind;
    const locoId = opts.locoId;

    const run = () =>
      new Promise((resolve, reject) => {
        if (!this.socket || !this.socket.writable) {
          reject(new Error('Not connected'));
          return;
        }
        if (expectResponse) {
          this._pending.push({ resolve, reject, matchBody, waitKind, locoId });
        }
        const msg = buildHeader(xmlMsg, xmlType);
        if (RR_DEBUG) {
          this.log(`tx xmlType=${xmlType} body=${xmlMsg}`);
        } else {
          this.log(`tx xmlType=${xmlType} bytes=${Buffer.byteLength(xmlMsg, 'utf8')}`);
        }
        this.socket.write(msg, 'utf8', (err) => {
          if (err) {
            if (expectResponse) {
              const p = this._pending.pop();
              if (p) p.reject(err);
            } else {
              reject(err);
            }
            return;
          }
          if (!expectResponse) resolve({ name: '', body: '' });
        });
      });

    this._ioChain = this._ioChain.then(run, run);
    return this._ioChain;
  }

  async getLclistBody() {
    const res = await this._send('model', '<model cmd="lclist"/>', {
      waitKind: 'lclist',
      matchBody: (b) => b.includes('<lclist>') || (b.includes('<plan>') && b.includes('<lclist')),
    });
    return res.body;
  }

  async ingestPlanXmlIntoFnCaches(perLocoFnCacheMap = null) {
    if (!perLocoFnCacheMap || !this.socket?.writable) return;
    try {
      const res = await this._send('model', '<model cmd="plan"/>', {
        waitKind: 'plan',
        matchBody: (b) => b.includes('<plan>') || b.includes('<lclist>'),
      });
      ingestLcFnXmlIntoCaches(perLocoFnCacheMap, res.body);
    } catch (e) {
      this.log(`plan→fn-cache ingest failed: ${e?.message || String(e)}`);
    }
  }

  async getLocoList(perLocoFnCacheMap = null) {
    const body = await this.getLclistBody();
    if (perLocoFnCacheMap) {
      ingestLcFnXmlIntoCaches(perLocoFnCacheMap, body);
      await this.ingestPlanXmlIntoFnCaches(perLocoFnCacheMap);
    }
    let locos;
    if (body.includes('<plan>') || body.includes('<lclist>')) {
      locos = parsePlanLclist(body) || parseLcList(body);
    } else {
      locos = parseLcList(body);
    }
    return sortLocosByName(locos);
  }

  /** `lcprops` may omit live `fN` flags; merge from latest `lclist` / plan `<lc/>` row for the same id. */
  async syncLocoFnFromLclist(locoProps, perLocoFnCacheMap = null) {
    if (!locoProps?.id || !this.socket?.writable) return;
    try {
      const body = await this.getLclistBody();
      if (perLocoFnCacheMap) {
        ingestLcFnXmlIntoCaches(perLocoFnCacheMap, body);
      }
      mergeLcOrFnAttrsIntoLocoProps(locoProps, body, locoProps.id);
    } catch (e) {
      this.log(`syncLocoFnFromLclist failed: ${e?.message || String(e)}`);
    }
  }

  async getPlan() {
    const res = await this._send('model', '<model cmd="plan"/>', {
      waitKind: 'plan',
      matchBody: (b) => b.includes('<plan>') || b.includes('<lclist>'),
    });
    const locos = parsePlanLclist(res.body);
    return locos;
  }

  async getLocoProps(locoId) {
    const id = escapeXmlAttr(locoId);
    const res = await this._send('model', `<model cmd="lcprops" val="${id}"/>`, {
      waitKind: 'lcprops',
      locoId,
      matchBody: (b) => isLcpropsReplyXml(b, locoId),
    });
    return parseLcProps(res.body, locoId);
  }

  // Send V in the loco's mode units: percent (0…V_max) or km/h (0…V_max).
  async setVelocity(locoId, V) {
    const id = escapeXmlAttr(locoId);
    const msg = `<lc id="${id}" V="${Math.max(0, V)}" cmd="velocity" throttleid="${this.throttleId}"/>`;
    await this._send('lc', msg, { expectResponse: false });
  }

  async setDirection(locoId, dir) {
    const id = escapeXmlAttr(locoId);
    const msg = `<lc id="${id}" dir="${dir}" cmd="direction" throttleid="${this.throttleId}"/>`;
    await this._send('lc', msg, { expectResponse: false });
  }

  async dispatchLoco(locoId) {
    const id = escapeXmlAttr(locoId);
    const msg = `<lc id="${id}" cmd="dispatch" throttleid="${this.throttleId}"/>`;
    await this._send('lc', msg, { expectResponse: false });
  }

  async releaseLoco(locoId) {
    const id = escapeXmlAttr(locoId);
    const msg = `<lc id="${id}" cmd="release" throttleid="${this.throttleId}"/>`;
    await this._send('lc', msg, { expectResponse: false });
  }

  /**
   * Toggle one function. Pass `snapshot` (current `locoProps` from getLocoProps) for `rawAttrs` and
   * function state; the `<fn/>` body matches Rocview (fixed attribute set/order, `throttleid=""`, no `cmd`).
   */
  async setFunction(locoId, fn, on, snapshot = null) {
    const msg = buildFnCommandXml(locoId, fn, on, this.throttleId, snapshot);
    await this._send('fn', msg, { expectResponse: false });
  }

  async stopLoco(locoId) {
    await this.setVelocity(locoId, 0);
  }

  /**
   * Send the press command for a track-diagram accessory:
   * turnouts / signals / outputs flip, turntables step to the next track.
   * @param {'sw'|'sg'|'co'|'tt'} kind
   */
  async commandAccessory(kind, itemId) {
    const id = escapeXmlAttr(itemId);
    if (kind === 'tt') {
      await this._send('tt', `<tt id="${id}" cmd="next"/>`, { expectResponse: false });
      return;
    }
    if (kind === 'sw' || kind === 'sg' || kind === 'co') {
      await this._send(kind, `<${kind} id="${id}" cmd="flip"/>`, { expectResponse: false });
      return;
    }
    throw new Error(`accessory kind ${kind} is not controllable`);
  }

  formatSpeed(loco) {
    if (!loco) return '---';
    // Commanded `V` in mode units — not RailCom `V_realkmh` (lags / interpolates).
    const v = clampLocoVelocity(loco, loco.V ?? 0);
    if (isLocoKmhMode(loco)) return `${v} km/h`;
    return `${v}%`;
  }
}
