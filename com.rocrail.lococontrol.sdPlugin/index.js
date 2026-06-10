#!/usr/bin/env node
/**
 * Rocrail Loco Control - OpenAction plugin for OpenDeck
 * Controls model trains via Rocrail using Stream Deck / AJAZZ AKP03
 * Supports multiple devices: shared Rocrail connection + image cache, per-device UI and throttle.
 */

import WebSocket from 'ws';
import {
  RocrailClient,
  ingestLcFnXmlIntoCaches,
  lookupLocoFnCacheSlice,
  mergeLcOrFnAttrsIntoLocoProps,
  overlayCachedLcFnOntoLocoProps,
  rocrailFnIsActive,
  syncLocoFnCacheFromLocoProps,
} from './rocrail-client.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  MAX_OLED_TEXT_FONT_PX,
  formatLocoDisplayName,
  getCachedCompositePng,
  getCachedFunctionIconPng,
  getFnKeyOffBackgroundDataUri,
  getFnKeyOnBackgroundDataUri,
  renderFunctionLabelPng,
  renderThrottleSpeedDirPng,
  sourceContentHash,
} from './loco-composite.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPOSITE_CACHE_DIR = join(__dirname, 'loco-image-cache');
const PLUGIN_UUID = 'com.rocrail.lococontrol';

const View = { LOCO_LIST: 'loco', THROTTLE: 'throttle' };

const PLUGIN_DEBUG =
  process.env.ROCRAIL_PLUGIN_DEBUG === '1' || process.env.ROCRAIL_PLUGIN_DEBUG === 'true';

const OLED_ACTION = `${PLUGIN_UUID}.oled`;

const OLED_THROTTLE_VIEW_FN = 'function';
const OLED_THROTTLE_VIEW_LOCO = 'loco';
const OLED_THROTTLE_VIEW_SPEED = 'speed';
const OLED_THROTTLE_VIEW_SPEED_ONLY = 'speedonly';
const OLED_THROTTLE_VIEW_DIR_ONLY = 'directiononly';

/** True for any of the speed/direction display tiles (speed & direction, speed only, direction only). */
function isSpeedFamilyThrottleView(tv) {
  return (
    tv === OLED_THROTTLE_VIEW_SPEED ||
    tv === OLED_THROTTLE_VIEW_SPEED_ONLY ||
    tv === OLED_THROTTLE_VIEW_DIR_ONLY
  );
}

/** Render mode for renderThrottleSpeedDirPng based on the configured throttle view. */
function speedTileRenderMode(tv) {
  if (tv === OLED_THROTTLE_VIEW_SPEED_ONLY) return 'speed';
  if (tv === OLED_THROTTLE_VIEW_DIR_ONLY) return 'direction';
  return 'both';
}

/** Normalize host event names (OpenAction / bridges may use different casing or separators). */
function normalizeOaEventName(event) {
  const s = typeof event === 'string' ? event.trim() : '';
  if (!s) return '';
  return s.replace(/_/g, '').toLowerCase();
}

/**
 * OpenDeck sends Stream-Deck-shaped JSON; some bridges or versions may use different key casing
 * or nest the payload. Merge into a single shape the rest of handleMessage expects.
 */
function coerceInboundPluginMessage(raw) {
  const m = raw && typeof raw === 'object' ? raw : {};
  const inner = m.message && typeof m.message === 'object' ? m.message : null;
  const base = inner ? { ...m, ...inner } : m;

  const event = base.event ?? base.Event;
  const action = base.action ?? base.Action ?? base.actionUUID;
  const context = base.context ?? base.Context;
  const device = base.device ?? base.Device ?? base.payload?.device;
  const payload = base.payload ?? base.Payload ?? {};

  return { event, action, context, device, payload, _topKeys: Object.keys(m) };
}

/** Physical press / release / touch (not rotate). Logged even when action is not our OLED UUID. */
function isHardwarePressLikeEvent(evNorm) {
  return (
    evNorm === 'keydown' ||
    evNorm === 'keyup' ||
    evNorm === 'dialdown' ||
    evNorm === 'dialup' ||
    evNorm === 'dialpress' ||
    evNorm === 'touchtap' ||
    evNorm === 'touchpress' ||
    evNorm === 'encoderdown' ||
    evNorm === 'encoderup'
  );
}

function defaultDeviceState() {
  return {
    view: View.LOCO_LIST,
    selectedLoco: null,
    locoProps: null,
    locoScroll: 0,
    /** First visible function index when paging on OLED keys (throttle view). */
    fnScroll: 0,
  };
}

/** Rocrail lcprops may omit `<fundef>`; fall back to F0..F(n-1) from fncnt. */
function functionDefsForDisplay(locoProps, selectedLoco) {
  const raw = locoProps?.fundefs;
  if (Array.isArray(raw) && raw.length > 0) return raw;
  const n = parseInt(locoProps?.fncnt ?? selectedLoco?.fncnt ?? 4, 10) || 4;
  const defs = [];
  for (let i = 0; i < n; i++) defs.push({ fn: i, text: `F${i}` });
  return defs;
}

/** Word-wrap label onto multiple lines for narrow OLED titles. */
function wrapFnLabel(text, maxCharsPerLine, maxLines) {
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
  return lines.join('\n');
}

function listMaxScrollStart(listLen, pageSize) {
  const ps = Math.max(1, pageSize);
  return Math.max(0, listLen - ps);
}

/** True when the list is longer than one OLED page (scrolling / wrap applies). */
function listCanScroll(listLen, pageSize) {
  return listLen > Math.max(1, pageSize);
}

/**
 * Cyclic scroll index: when the list fits on one page, always 0.
 * Otherwise `current + delta` wrapped to `0 … listMaxScrollStart`.
 */
function applyWrappedListScroll(current, delta, listLen, pageSize) {
  const ps = Math.max(1, pageSize);
  if (!listCanScroll(listLen, ps)) return 0;
  const maxStart = listMaxScrollStart(listLen, ps);
  const n = maxStart + 1;
  const v = current + delta;
  return ((v % n) + n) % n;
}

/** First index of each scrolled "page": 0, visibleSlots, …, ending at listMaxScrollStart (short final page when len is not a multiple). */
function listPageScrollAnchors(listLen, visibleSlots) {
  const vs = Math.max(1, visibleSlots);
  if (listLen <= 0) return [0];
  const maxStart = listMaxScrollStart(listLen, vs);
  if (!listCanScroll(listLen, vs)) return [0];
  const anchors = [];
  let s = 0;
  for (;;) {
    anchors.push(s);
    if (s >= maxStart) break;
    s = Math.min(s + vs, maxStart);
  }
  return anchors;
}

/** Largest anchor index whose start offset ≤ scrollPos */
function anchorIndexAtOrBelow(anchors, scrollPos) {
  let i = anchors.length - 1;
  while (i > 0 && anchors[i] > scrollPos) i--;
  return i;
}

/**
 * "One page per dial step": advance by whole page boundaries (fixes unreachable last partial page vs raw index+delta modulo).
 * @param {number} pageTurnTicks Encoder delta (positive/negative), one tick → next/prev anchor.
 */
function advanceListScrollByPageTicks(currentScroll, pageTurnTicks, listLen, visibleSlots) {
  const vs = Math.max(1, visibleSlots);
  const anchors = listPageScrollAnchors(listLen, vs);
  const nAnch = anchors.length;
  if (nAnch <= 1 || pageTurnTicks === 0) return Math.min(Math.max(0, currentScroll), Math.max(0, listLen - vs));
  const maxStart = listMaxScrollStart(listLen, vs);
  const clamped = Math.min(Math.max(0, currentScroll), maxStart);
  let idx = anchorIndexAtOrBelow(anchors, clamped);
  idx = ((idx + pageTurnTicks) % nAnch + nAnch) % nAnch;
  return anchors[idx];
}

/** Sync `fN` boolean and `rawAttrs.fN` string for Rocrail `<fn/>` replays and UI reads. */
function setLocoFnLocal(locoProps, fnKey, on) {
  const lp = locoProps || {};
  lp[fnKey] = !!on;
  if (!lp.rawAttrs || typeof lp.rawAttrs !== 'object') lp.rawAttrs = {};
  lp.rawAttrs[fnKey] = on ? 'true' : 'false';
}

/** Keep `lc` direction / velocity on `snap` and `snap.rawAttrs` aligned for `<fn/>` payloads. */
function syncLcThrottleIntoRawAttrs(locoProps) {
  if (!locoProps || typeof locoProps !== 'object') return;
  if (!locoProps.rawAttrs || typeof locoProps.rawAttrs !== 'object') locoProps.rawAttrs = {};
  const raw = locoProps.rawAttrs;
  raw.dir = locoProps.dir === true ? 'true' : 'false';
  const vPct = Math.max(0, Math.min(100, parseInt(String(locoProps.V ?? raw.V ?? '0'), 10) || 0));
  locoProps.V = vPct;
  raw.V = String(vPct);
  if (locoProps.V_realkmh != null && `${locoProps.V_realkmh}`.trim() !== '') {
    const rk = `${parseInt(String(locoProps.V_realkmh), 10) || 0}`;
    locoProps.V_realkmh = rk;
    raw.V_realkmh = rk;
  }
}

class RocrailPlugin {
  constructor() {
    this.ws = null;
    this.rocrail = null;
    this.globalSettings = {};
    this._requestedGlobal = false;
    this.locos = [];
    this.port = null;
    this.pluginUUID = null;
    this.registerEvent = null;

    /** @type {Map<string, { row?: number, column?: number, device: string }>} */
    this.oledContexts = new Map();
    /** @type {Map<string, { type: string, device: string }>} */
    this.simpleContexts = new Map();
    /** @type {Map<string, string>} deviceId -> speed dial action context */
    this.dialContextByDevice = new Map();
    /** @type {Map<string, string>} deviceId -> list scroll encoder action context */
    this.scrollDialContextByDevice = new Map();
    /** @type {Map<string, string>} deviceId -> back action context */
    this.backContextByDevice = new Map();
    /** @type {{ context: string, device: string }[]} */
    this.scrollUpContexts = [];
    /** @type {{ context: string, device: string }[]} */
    this.scrollDownContexts = [];

    /** @type {Map<string, ReturnType<typeof defaultDeviceState>>} */
    this._deviceStates = new Map();
    /** locoId -> deviceId (throttle owner until that device returns to list) */
    this._locoLocks = new Map();

    /** @type {Map<string, string|null>} key: locoId|displayText|sourceHash -> dataUri */
    this._locoImageCache = new Map();
    /** @type {Map<string, Buffer|null>} fetched function icon source bytes keyed by URL (icons are static) */
    this._fnIconSourceByUrl = new Map();
    /** @type {Map<string, string|null>} key: iconName|on|sourceHash -> dataUri */
    this._fnIconCache = new Map();

    /** Serialize initRocrail / getLocoList so parallel willAppear from multiple decks cannot mix TCP replies. */
    this._initRocrailChain = Promise.resolve();
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._lcPushRefreshTimer = null;

    /** OLED action-instance settings (keys: OLED context id from OpenDeck / Stream Deck PI). */
    /** @type {Map<string, { throttleView?: string }>} */
    this.oledSettingsByContext = new Map();
    /** @type {Map<string, Record<string, any>>} per-loco `f*` booleans/rawAttrs stitched from lcprops, lclist, and `<lc>/<fn>` pushes */
    this.perLocoFnCacheById = new Map();
  }

  log(msg, extra) {
    const ts = new Date().toISOString();
    const line = `[rocrail-plugin ${ts}] ${msg}`;
    if (extra !== undefined) console.log(line, extra);
    else console.log(line);
    if (process.env.ROCRAIL_PLUGIN_LOG_STDERR === '1' || process.env.ROCRAIL_PLUGIN_LOG_STDERR === 'true') {
      if (extra !== undefined) console.error(line, extra);
      else console.error(line);
    }
  }

  _deviceId(device) {
    return device && String(device).length > 0 ? String(device) : 'default';
  }

  _effectiveOledTextFontPx() {
    const n = parseInt(this.globalSettings?.oledTextFontSize, 10);
    return Number.isFinite(n) ? Math.min(MAX_OLED_TEXT_FONT_PX, Math.max(8, n)) : null;
  }

  _normalizeThrottleViewSetting(v) {
    const s = String(v ?? '').trim().toLowerCase();
    if (s === OLED_THROTTLE_VIEW_LOCO) return OLED_THROTTLE_VIEW_LOCO;
    if (s === OLED_THROTTLE_VIEW_SPEED) return OLED_THROTTLE_VIEW_SPEED;
    if (s === OLED_THROTTLE_VIEW_SPEED_ONLY) return OLED_THROTTLE_VIEW_SPEED_ONLY;
    if (s === OLED_THROTTLE_VIEW_DIR_ONLY) return OLED_THROTTLE_VIEW_DIR_ONLY;
    return OLED_THROTTLE_VIEW_FN;
  }

  _mergeOledActionSettings(oledCtx, settings) {
    if (oledCtx == null || settings == null || typeof settings !== 'object') return;
    const prev = this.oledSettingsByContext.get(oledCtx) || {};
    const merged = { ...prev };
    if (Object.prototype.hasOwnProperty.call(settings, 'throttleView')) {
      merged.throttleView = this._normalizeThrottleViewSetting(settings.throttleView);
    }
    this.oledSettingsByContext.set(oledCtx, merged);
  }

  _throttleViewForOledContext(oledCtx) {
    const row = this.oledSettingsByContext.get(oledCtx);
    const v = row?.throttleView;
    return v != null ? this._normalizeThrottleViewSetting(v) : OLED_THROTTLE_VIEW_FN;
  }

  _countThrottleFunctionOledSlots(deviceId) {
    const entries = this.getOledEntriesForDevice(deviceId);
    let n = 0;
    for (const [ctx] of entries) {
      if (this._throttleViewForOledContext(ctx) === OLED_THROTTLE_VIEW_FN) n++;
    }
    return n;
  }

  _setTitleParametersMaybe(context, target = 0) {
    const fs = this._effectiveOledTextFontPx();
    if (fs == null) return;
    this.send({
      event: 'setTitleParameters',
      context,
      payload: {
        payload: {
          showTitle: true,
          titleAlignment: 'middle',
          fontUnderline: false,
          fontSize: fs,
        },
        target,
      },
    });
  }

  getDeviceState(deviceId) {
    const id = this._deviceId(deviceId);
    if (!this._deviceStates.has(id)) {
      this._deviceStates.set(id, defaultDeviceState());
    }
    return this._deviceStates.get(id);
  }

  _countContextsForDevice(deviceId) {
    const d = this._deviceId(deviceId);
    let n = 0;
    for (const [, v] of this.oledContexts) if (v.device === d) n++;
    for (const [, v] of this.simpleContexts) if (v.device === d) n++;
    if (this.dialContextByDevice.has(d)) n++;
    if (this.scrollDialContextByDevice.has(d)) n++;
    if (this.backContextByDevice.has(d)) n++;
    for (const x of this.scrollUpContexts) if (x.device === d) n++;
    for (const x of this.scrollDownContexts) if (x.device === d) n++;
    return n;
  }

  /** Remove locks and server claim when a device unplugs / loses all actions */
  async _cleanupDevice(deviceId) {
    const d = this._deviceId(deviceId);
    const st = this._deviceStates.get(d);
    if (st?.selectedLoco && this.rocrail) {
      this.log(`device cleanup: stopping loco=${st.selectedLoco.id} device=${d}`);
      try {
        await this.rocrail.stopLoco(st.selectedLoco.id);
      } catch (_) {}
      try {
        await this.rocrail.releaseLoco(st.selectedLoco.id);
      } catch (_) {}
    }
    for (const [locoId, owner] of [...this._locoLocks.entries()]) {
      if (owner === d) this._locoLocks.delete(locoId);
    }
    this._deviceStates.delete(d);
    this.dialContextByDevice.delete(d);
    this.scrollDialContextByDevice.delete(d);
    this.backContextByDevice.delete(d);
  }

  _maybeCleanupDeviceAfterContextRemoved(deviceId) {
    const d = this._deviceId(deviceId);
    if (this._countContextsForDevice(d) === 0) {
      return this._cleanupDevice(d);
    }
    return Promise.resolve();
  }

  _isLocoLockedByOther(locoId, deviceId) {
    const d = this._deviceId(deviceId);
    const owner = this._locoLocks.get(locoId);
    return owner != null && owner !== d;
  }

  _setLocoLock(locoId, deviceId) {
    this._locoLocks.set(locoId, this._deviceId(deviceId));
  }

  _clearLocoLockIfOwner(locoId, deviceId) {
    const d = this._deviceId(deviceId);
    if (this._locoLocks.get(locoId) === d) this._locoLocks.delete(locoId);
  }

  _allDeviceIds() {
    const ids = new Set();
    for (const [, v] of this.oledContexts) ids.add(v.device);
    for (const [, v] of this.simpleContexts) ids.add(v.device);
    for (const dev of this.dialContextByDevice.keys()) ids.add(dev);
    for (const dev of this.scrollDialContextByDevice.keys()) ids.add(dev);
    for (const dev of this.backContextByDevice.keys()) ids.add(dev);
    for (const x of this.scrollUpContexts) ids.add(x.device);
    for (const x of this.scrollDownContexts) ids.add(x.device);
    for (const dev of this._deviceStates.keys()) ids.add(dev);
    return [...ids];
  }

  parseArgs() {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-port' && args[i + 1]) this.port = parseInt(args[i + 1], 10);
      if (args[i] === '-pluginUUID' && args[i + 1]) this.pluginUUID = args[i + 1];
      if (args[i] === '-registerEvent' && args[i + 1]) this.registerEvent = args[i + 1];
      if (args[i] === '-info' && args[i + 1]) {
        try {
          const info = JSON.parse(args[i + 1]);
          this.port = info?.application?.port ?? this.port;
        } catch (_) {}
      }
    }
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
      this.ws.on('open', () => {
        this.log(`connected to OpenAction WS port=${this.port}`);
        this.send({
          event: this.registerEvent,
          uuid: this.pluginUUID,
        });
        this.log(`registered plugin uuid=${this.pluginUUID} registerEvent=${this.registerEvent}`);
        resolve();
      });
      this.ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch (e) {
          this.log(`OpenAction WS JSON parse error: ${e?.message || String(e)}`);
          return;
        }
        void this.handleMessage(msg).catch((e) => {
          this.log(`handleMessage error: ${e?.message || String(e)}`);
        });
      });
      this.ws.on('error', (e) => {
        this.log(`OpenAction WS error: ${e?.message || String(e)}`);
        reject(e);
      });
      this.ws.on('close', () => this.log('OpenAction WS closed'));
    });
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  setTitle(context, title, target = 0) {
    this.send({ event: 'setTitle', context, payload: { title, target } });
  }

  setImage(context, image, target = 0) {
    if (image == null) {
      if (PLUGIN_DEBUG) this.log(`setImage reset context=${context}`);
      this.send({ event: 'setImage', context, payload: { target } });
      return;
    }
    const payloadImage = image.startsWith('data:') ? image : join(__dirname, image);
    const bytes = image.startsWith('data:') ? Math.round((image.length * 3) / 4) : undefined;
    if (PLUGIN_DEBUG) {
      this.log(
        `setImage context=${context} kind=${image.startsWith('data:') ? 'dataUri' : 'path'}${bytes ? ` approxBytes=${bytes}` : ''}`
      );
    }
    this.send({ event: 'setImage', context, payload: { image: payloadImage, target } });
  }

  setState(context, state, target = 0) {
    this.send({ event: 'setState', context, payload: { state, target } });
  }

  async handleMessage(rawMsg) {
    const msg = coerceInboundPluginMessage(rawMsg);
    const { event, action, context, device, payload } = msg;
    const coordinates = payload?.coordinates ?? {};
    const deviceId = this._deviceId(device ?? payload?.device);
    const evNorm = normalizeOaEventName(event);

    if (isHardwarePressLikeEvent(evNorm)) {
      this.log(
        `oa hardware event=${String(event ?? '')} action=${String(action ?? '')} ctrl=${payload?.controller ?? '-'} device=${deviceId} r=${coordinates.row} c=${coordinates.column} topKeys=${msg._topKeys?.join(',') ?? ''}`
      );
    }

    if (
      action === OLED_ACTION &&
      evNorm !== 'dialrotate' &&
      evNorm !== 'dialup' &&
      evNorm !== 'willappear' &&
      evNorm !== 'willdisappear' &&
      evNorm !== 'didreceivesettings'
    ) {
      this.log(
        `oa oled rx event=${String(event || '')} norm=${evNorm} device=${deviceId} row=${coordinates.row} col=${coordinates.column} controller=${payload?.controller ?? '-'}`
      );
    }

    if (PLUGIN_DEBUG) {
      this.log(`oa event=${event} action=${action || '-'} context=${context || '-'} device=${deviceId}`, {
        coordinates,
        payloadKeys: payload ? Object.keys(payload) : [],
      });
    }

    if (evNorm === 'didreceiveglobalsettings') {
      this.globalSettings = payload?.settings ?? {};
      if (PLUGIN_DEBUG) this.log('global settings updated', this.globalSettings);
      else this.log('global settings updated');
      this._locoImageCache.clear();
      this._fnIconSourceByUrl.clear();
      this._fnIconCache.clear();
      await this.initRocrail();
      return;
    }

    if (evNorm === 'didreceivesettings') {
      if (action === OLED_ACTION && context != null && payload != null && typeof payload === 'object') {
        const rawInst =
          payload.settings != null && typeof payload.settings === 'object' ? payload.settings : payload;
        if (rawInst && typeof rawInst === 'object') {
          this._mergeOledActionSettings(context, rawInst);
          await this.refreshDevice(deviceId);
        }
      }
      return;
    }

    if (evNorm === 'setglobalsettings') return;

    if (!this._requestedGlobal) {
      this._requestedGlobal = true;
      this.send({ event: 'getGlobalSettings', context: this.pluginUUID });
      this.log('requested global settings');
    }

    if (evNorm === 'willappear') {
      if (action === OLED_ACTION) {
        this.oledContexts.set(context, { row: coordinates.row, column: coordinates.column, device: deviceId });
        if (payload?.settings != null && typeof payload.settings === 'object') {
          this._mergeOledActionSettings(context, payload.settings);
        }
      } else if (action === `${PLUGIN_UUID}.dirfwd`) {
        this.simpleContexts.set(context, { type: 'dirfwd', device: deviceId });
      } else if (action === `${PLUGIN_UUID}.dirrev`) {
        this.simpleContexts.set(context, { type: 'dirrev', device: deviceId });
      } else if (action === `${PLUGIN_UUID}.speed`) {
        this.dialContextByDevice.set(deviceId, context);
      } else if (action === `${PLUGIN_UUID}.stoploco`) {
        this.simpleContexts.set(context, { type: 'stoploco', device: deviceId });
      } else if (action === `${PLUGIN_UUID}.speedplus`) {
        this.simpleContexts.set(context, { type: 'speedplus', device: deviceId });
      } else if (action === `${PLUGIN_UUID}.speedminus`) {
        this.simpleContexts.set(context, { type: 'speedminus', device: deviceId });
      } else if (action === `${PLUGIN_UUID}.scroll`) {
        this.scrollDialContextByDevice.set(deviceId, context);
      } else if (action === `${PLUGIN_UUID}.back`) {
        this.backContextByDevice.set(deviceId, context);
      } else if (action === `${PLUGIN_UUID}.scrollup`) {
        this.scrollUpContexts.push({ context, device: deviceId });
      } else if (action === `${PLUGIN_UUID}.scrolldown`) {
        this.scrollDownContexts.push({ context, device: deviceId });
      }
      await this.initRocrail(false);
      await this.refreshDevice(deviceId);
      return;
    }

    if (evNorm === 'willdisappear') {
      if (action === OLED_ACTION) {
        this.oledContexts.delete(context);
        this.oledSettingsByContext.delete(context);
      } else if (action === `${PLUGIN_UUID}.dirfwd` || action === `${PLUGIN_UUID}.dirrev`) {
        this.simpleContexts.delete(context);
      } else if (action === `${PLUGIN_UUID}.stoploco` || action === `${PLUGIN_UUID}.speedplus` || action === `${PLUGIN_UUID}.speedminus`) {
        this.simpleContexts.delete(context);
      } else if (action === `${PLUGIN_UUID}.speed`) {
        if (this.dialContextByDevice.get(deviceId) === context) this.dialContextByDevice.delete(deviceId);
      } else if (action === `${PLUGIN_UUID}.scroll`) {
        if (this.scrollDialContextByDevice.get(deviceId) === context) this.scrollDialContextByDevice.delete(deviceId);
      } else if (action === `${PLUGIN_UUID}.back`) {
        if (this.backContextByDevice.get(deviceId) === context) this.backContextByDevice.delete(deviceId);
      } else if (action === `${PLUGIN_UUID}.scrollup`) {
        this.scrollUpContexts = this.scrollUpContexts.filter((x) => x.context !== context);
      } else if (action === `${PLUGIN_UUID}.scrolldown`) {
        this.scrollDownContexts = this.scrollDownContexts.filter((x) => x.context !== context);
      }
      await this._maybeCleanupDeviceAfterContextRemoved(deviceId);
      return;
    }

    if (evNorm === 'keydown') {
      if (PLUGIN_DEBUG) this.log(`button press action=${action} context=${context}`);
      if (this.isOledInstance(context, action)) {
        await this.onOledPress(context, coordinates, deviceId);
      } else if (action === `${PLUGIN_UUID}.dirfwd`) {
        await this.onDirection(true, deviceId);
      } else if (action === `${PLUGIN_UUID}.dirrev`) {
        await this.onDirection(false, deviceId);
      } else if (action === `${PLUGIN_UUID}.back`) {
        await this.onBack(deviceId);
      } else if (action === `${PLUGIN_UUID}.stoploco`) {
        await this.onSpeedStop(deviceId);
      } else if (action === `${PLUGIN_UUID}.speedplus`) {
        await this.onSpeedBumpPercent(5, deviceId);
      } else if (action === `${PLUGIN_UUID}.speedminus`) {
        await this.onSpeedBumpPercent(-5, deviceId);
      } else if (action === `${PLUGIN_UUID}.scrollup`) {
        await this.onScroll(1, deviceId);
      } else if (action === `${PLUGIN_UUID}.scrolldown`) {
        await this.onScroll(-1, deviceId);
      } else if (action === `${PLUGIN_UUID}.speed`) {
        const st = this.getDeviceState(deviceId);
        if (st.view === View.THROTTLE) await this.onSpeedStop(deviceId);
      }
      return;
    }

    if (evNorm === 'dialrotate' || evNorm === 'encoder') {
      const ticks = payload?.ticks ?? payload?.encoder ?? 0;
      if (PLUGIN_DEBUG) {
        this.log(`dial rotate ticks=${ticks} action=${action} context=${context} device=${deviceId}`);
      }
      if (action === `${PLUGIN_UUID}.scroll`) {
        await this.onScrollDialRotate(ticks, deviceId);
      } else if (action === OLED_ACTION || action === `${PLUGIN_UUID}.speed`) {
        const st = this.getDeviceState(deviceId);
        if (st.view === View.LOCO_LIST) {
          const oledCount = Math.max(1, this.getOledEntriesForDevice(deviceId).length);
          if (this._isLocoListDialPageMode()) {
            st.locoScroll = advanceListScrollByPageTicks(st.locoScroll, ticks, this.locos.length, oledCount);
          } else {
            st.locoScroll = applyWrappedListScroll(st.locoScroll, ticks, this.locos.length, oledCount);
          }
          await this.refreshOledsForDevice(deviceId);
          await this.refreshScrollForDevice(deviceId);
        } else if (st.view === View.THROTTLE) {
          if (action === `${PLUGIN_UUID}.speed`) {
            await this.onSpeedChange(ticks, deviceId);
          } else if (st.selectedLoco) {
            const fnSlotsCount = this._countThrottleFunctionOledSlots(deviceId);
            if (fnSlotsCount < 1) return;
            const defs = functionDefsForDisplay(st.locoProps, st.selectedLoco);
            if (this._isLocoListDialPageMode()) {
              st.fnScroll = advanceListScrollByPageTicks(st.fnScroll, ticks, defs.length, fnSlotsCount);
            } else {
              st.fnScroll = applyWrappedListScroll(st.fnScroll, ticks, defs.length, fnSlotsCount);
            }
            await this.refreshOledsForDevice(deviceId);
            await this.refreshScrollForDevice(deviceId);
          }
        }
      }
      return;
    }

    if (
      evNorm === 'dialdown' ||
      evNorm === 'dialpress' ||
      evNorm === 'touchtap' ||
      evNorm === 'touchpress'
    ) {
      if (PLUGIN_DEBUG) this.log(`dial/touch press action=${action} context=${context} device=${deviceId}`);
      if (action === `${PLUGIN_UUID}.speed`) {
        const st = this.getDeviceState(deviceId);
        if (st.view === View.THROTTLE) await this.onSpeedStop(deviceId);
        else await this.onScroll(-1, deviceId);
      } else if (this.isOledInstance(context, action)) {
        await this.onOledPress(context, coordinates, deviceId);
      }
      return;
    }

    if (
      action === OLED_ACTION &&
      evNorm !== 'dialrotate' &&
      evNorm !== 'willappear' &&
      evNorm !== 'willdisappear' &&
      evNorm !== 'didreceivesettings' &&
      evNorm !== 'titleparametersdidchange'
    ) {
      const handledPress =
        evNorm === 'keydown' ||
        evNorm === 'dialdown' ||
        evNorm === 'dialpress' ||
        evNorm === 'touchtap' ||
        evNorm === 'touchpress';
      if (!handledPress) {
        this.log(`oa oled unhandled event=${String(event || '')} norm=${evNorm} device=${deviceId}`);
      }
    }
  }

  /** True if this instance is one of our OLED keys (by action UUID or by willAppear context). */
  isOledInstance(context, action) {
    if (action === OLED_ACTION) return true;
    if (context != null && this.oledContexts.has(context)) return true;
    return false;
  }

  getOledEntriesForDevice(deviceId) {
    const d = this._deviceId(deviceId);
    const entries = [...this.oledContexts.entries()].filter(([, v]) => v.device === d);
    const maxCol = Math.max(0, ...entries.map(([, v]) => v.column ?? 0));
    const cols = maxCol + 1;
    entries.sort((a, b) => (a[1].row ?? 0) * cols + (a[1].column ?? 0) - ((b[1].row ?? 0) * cols + (b[1].column ?? 0)));
    return entries;
  }

  getOledIndex(context, deviceId, coordinates = {}) {
    const sorted = this.getOledEntriesForDevice(deviceId);
    let idx = sorted.findIndex(([ctx]) => ctx === context);
    if (idx >= 0) return idx;
    const row = coordinates.row;
    const col = coordinates.column;
    if (typeof row !== 'number' && typeof col !== 'number') return -1;
    idx = sorted.findIndex(([, v]) => {
      const vr = v.row;
      const vc = v.column;
      if (typeof row === 'number' && typeof col === 'number') return vr === row && vc === col;
      if (typeof row === 'number') return vr === row;
      return vc === col;
    });
    return idx >= 0 ? idx : -1;
  }

  async onOledPress(context, coordinates, deviceId) {
    await this.initRocrail(false);
    const st = this.getDeviceState(deviceId);
    const idx = this.getOledIndex(context, deviceId, coordinates);
    if (idx < 0) {
      this.log(
        `oled press ignored: no OLED slot for context device=${deviceId} ctxLen=${(context || '').length} row=${coordinates?.row} col=${coordinates?.column} mappedSlots=${this.getOledEntriesForDevice(deviceId).length}`
      );
      return;
    }

    if (st.view === View.LOCO_LIST) {
      const loco = this.locos[st.locoScroll + idx];
      if (loco) {
        if (this._isLocoLockedByOther(loco.id, deviceId)) {
          this.log(`select denied: loco=${loco.id} is controlled by another device`);
          return;
        }

        this.log(`select loco id=${loco.id} name=${loco.name || ''} device=${deviceId}`);

        if (st.selectedLoco && st.selectedLoco.id !== loco.id && this.rocrail) {
          const prevId = st.selectedLoco.id;
          this.log(`switching loco on device=${deviceId}, stopping previous loco=${prevId}`);
          try {
            await this.rocrail.stopLoco(prevId);
          } catch (e) {
            this.log(`stop previous loco failed loco=${prevId}: ${e?.message || String(e)}`);
          }
          try {
            await this.rocrail.releaseLoco(prevId);
          } catch (e) {
            this.log(`release previous loco failed loco=${prevId}: ${e?.message || String(e)}`);
          }
          this._clearLocoLockIfOwner(prevId, deviceId);
        }

        st.selectedLoco = loco;
        try {
          await this.rocrail.dispatchLoco(loco.id);
          this._setLocoLock(loco.id, deviceId);
          this.log(`dispatched loco=${loco.id} device=${deviceId}`);
        } catch (e) {
          this.log(`dispatch failed loco=${loco.id}: ${e?.message || String(e)}`);
          st.selectedLoco = null;
          await this.refreshDevice(deviceId);
          return;
        }
        try {
          st.locoProps = await this.rocrail.getLocoProps(loco.id);
          const nf = Array.isArray(st.locoProps?.fundefs) ? st.locoProps.fundefs.length : 0;
          this.log(`lcprops loco=${loco.id} fundefs=${nf} device=${deviceId}`);
          if (st.locoProps?.id) await this.rocrail.syncLocoFnFromLclist(st.locoProps, this.perLocoFnCacheById);
          overlayCachedLcFnOntoLocoProps(st.locoProps, lookupLocoFnCacheSlice(this.perLocoFnCacheById, loco.id));
          syncLcThrottleIntoRawAttrs(st.locoProps);
          syncLocoFnCacheFromLocoProps(this.perLocoFnCacheById, st.locoProps);
        } catch (e) {
          this.log(`lcprops failed loco=${loco.id}: ${e?.message || String(e)}`);
          st.locoProps = { ...loco, rawAttrs: { id: loco.id } };
          for (let i = 0; i <= 32; i++) st.locoProps[`f${i}`] = false;
          overlayCachedLcFnOntoLocoProps(st.locoProps, lookupLocoFnCacheSlice(this.perLocoFnCacheById, loco.id));
          syncLcThrottleIntoRawAttrs(st.locoProps);
          syncLocoFnCacheFromLocoProps(this.perLocoFnCacheById, st.locoProps);
        }
        st.fnScroll = 0;
        st.view = View.THROTTLE;
        await this.refreshDevice(deviceId);
        await this.refreshAllDevicesLocoListVisuals();
      }
    } else if (st.view === View.THROTTLE && st.selectedLoco && this.rocrail) {
      const tv = context != null ? this._throttleViewForOledContext(context) : OLED_THROTTLE_VIEW_FN;

      if (isSpeedFamilyThrottleView(tv)) {
        st.locoProps = st.locoProps || {};
        const vPct = Math.max(0, parseInt(String(st.locoProps.V ?? 0), 10) || 0);
        const rk = Math.max(0, parseInt(String(st.locoProps.V_realkmh ?? 0), 10) || 0);
        const moving = vPct > 0 || rk > 0;
        if (tv === OLED_THROTTLE_VIEW_DIR_ONLY) {
          await this.onDirection(!(st.locoProps.dir === true), deviceId);
        } else if (tv === OLED_THROTTLE_VIEW_SPEED_ONLY) {
          if (moving) await this.onSpeedStop(deviceId);
        } else if (moving) {
          await this.onSpeedStop(deviceId);
        } else {
          await this.onDirection(!(st.locoProps.dir === true), deviceId);
        }
        return;
      }

      if (tv === OLED_THROTTLE_VIEW_LOCO) {
        await this.onBack(deviceId);
        return;
      }

      if (tv !== OLED_THROTTLE_VIEW_FN) return;

      const entriesGrid = this.getOledEntriesForDevice(deviceId);
      const fnSlotIdxs = [];
      for (let gi = 0; gi < entriesGrid.length; gi++) {
        const [c] = entriesGrid[gi];
        if (this._throttleViewForOledContext(c) === OLED_THROTTLE_VIEW_FN) fnSlotIdxs.push(gi);
      }
      const fi = fnSlotIdxs.indexOf(idx);
      if (fi < 0) return;

      const defs = functionDefsForDisplay(st.locoProps, st.selectedLoco);
      const def = defs[st.fnScroll + fi];
      if (!def) {
        this.log(`fn noop: no function at fnScroll=${st.fnScroll} slot=${fi} device=${deviceId}`);
        return;
      }
      const key = `f${def.fn}`;
      st.locoProps = st.locoProps || {};
      const cur = rocrailFnIsActive(st.locoProps, def.fn);
      const next = !cur;
      setLocoFnLocal(st.locoProps, key, next);
      await this.refreshOledsForDevice(deviceId);

      try {
        this.log(`fn send loco=${st.selectedLoco.id} F${def.fn}=${next} device=${deviceId}`);
        await this.rocrail.setFunction(st.selectedLoco.id, def.fn, next, st.locoProps);
        try {
          const merged = await this.rocrail.getLocoProps(st.selectedLoco.id);
          if (merged) st.locoProps = merged;
        } catch (e) {
          this.log(`getLocoProps after fn failed loco=${st.selectedLoco.id}: ${e?.message || String(e)}`);
        }
        st.locoProps = st.locoProps || {};
        syncLcThrottleIntoRawAttrs(st.locoProps);
        setLocoFnLocal(st.locoProps, key, next);
        syncLocoFnCacheFromLocoProps(this.perLocoFnCacheById, st.locoProps);
        this.log(`fn ok loco=${st.selectedLoco.id} F${def.fn}=${next} device=${deviceId}`);
      } catch (e) {
        this.log(`setFunction failed loco=${st.selectedLoco.id} fn=${def.fn}: ${e?.message || String(e)}`);
        setLocoFnLocal(st.locoProps, key, cur);
        syncLocoFnCacheFromLocoProps(this.perLocoFnCacheById, st.locoProps);
        await this.refreshOledsForDevice(deviceId);
        return;
      }
      await this.refreshOledsForDevice(deviceId);
    }
  }

  async onDirection(forward, deviceId) {
    await this.initRocrail(false);
    const st = this.getDeviceState(deviceId);
    if (!st.selectedLoco || !this.rocrail) return;
    this.log(`set direction loco=${st.selectedLoco.id} forward=${forward} device=${deviceId}`);
    await this.rocrail.setDirection(st.selectedLoco.id, forward);
    st.locoProps = st.locoProps || {};
    st.locoProps.dir = forward;
    syncLcThrottleIntoRawAttrs(st.locoProps);
    await this.refreshDevice(deviceId);
  }

  async onSpeedChange(delta, deviceId) {
    await this.initRocrail(false);
    const st = this.getDeviceState(deviceId);
    if (!st.selectedLoco || !this.rocrail) return;
    const v = (parseInt(st.locoProps?.V ?? 0, 10) || 0) + delta * 5;
    const vPct = Math.max(0, Math.min(100, v));
    st.locoProps = st.locoProps || {};
    st.locoProps.V = vPct;
    syncLcThrottleIntoRawAttrs(st.locoProps);
    this.log(`set speed loco=${st.selectedLoco.id} V=${vPct} device=${deviceId}`);
    await this.rocrail.setVelocity(st.selectedLoco.id, vPct);
    await this.refreshOledsForDevice(deviceId);
  }

  async onSpeedBumpPercent(deltaPct, deviceId) {
    await this.initRocrail(false);
    const st = this.getDeviceState(deviceId);
    if (!st.selectedLoco || !this.rocrail) return;
    const v = (parseInt(st.locoProps?.V ?? 0, 10) || 0) + deltaPct;
    const vPct = Math.max(0, Math.min(100, v));
    st.locoProps = st.locoProps || {};
    st.locoProps.V = vPct;
    syncLcThrottleIntoRawAttrs(st.locoProps);
    this.log(`adjust speed ±% loco=${st.selectedLoco.id} delta=${deltaPct} V=${vPct} device=${deviceId}`);
    await this.rocrail.setVelocity(st.selectedLoco.id, vPct);
    await this.refreshOledsForDevice(deviceId);
  }

  async onSpeedStop(deviceId) {
    await this.initRocrail(false);
    const st = this.getDeviceState(deviceId);
    if (!st.selectedLoco || !this.rocrail) return;
    st.locoProps = st.locoProps || {};
    st.locoProps.V = 0;
    syncLcThrottleIntoRawAttrs(st.locoProps);
    this.log(`stop loco=${st.selectedLoco.id} (V=0) device=${deviceId}`);
    await this.rocrail.stopLoco(st.selectedLoco.id);
    await this.refreshOledsForDevice(deviceId);
  }

  async onBack(deviceId) {
    await this.initRocrail(false);
    const st = this.getDeviceState(deviceId);
    if (st.selectedLoco && this.rocrail) {
      this.log(`leaving loco view, stopping loco=${st.selectedLoco.id} device=${deviceId}`);
      await this.rocrail.stopLoco(st.selectedLoco.id);
      try {
        await this.rocrail.releaseLoco(st.selectedLoco.id);
        this.log(`released loco=${st.selectedLoco.id}`);
      } catch (e) {
        this.log(`release failed loco=${st.selectedLoco.id}: ${e?.message || String(e)}`);
      }
      this._clearLocoLockIfOwner(st.selectedLoco.id, deviceId);
    }
    st.selectedLoco = null;
    st.locoProps = null;
    st.view = View.LOCO_LIST;
    st.locoScroll = 0;
    st.fnScroll = 0;
    await this.refreshDevice(deviceId);
    await this.refreshAllDevicesLocoListVisuals();
  }

  /** Global property: OLED / scroll encoder rotates one visible page at a time (short final page included). */
  _isLocoListDialPageMode() {
    return (this.globalSettings.locoListDialScroll || 'single') === 'page';
  }

  /**
   * Apply the global "Displayed locos" filter: hide locos running in automatic
   * (`mode_auto="auto"`) and optionally half‑automatic (`mode_halfauto="halfauto"`) mode.
   */
  _filterDisplayedLocos(locos) {
    if (!Array.isArray(locos)) return [];
    const mode = this.globalSettings.displayedLocos || 'all';
    if (mode === 'all') return locos;
    return locos.filter((l) => {
      const isAuto = String(l?.mode_auto ?? '').trim().toLowerCase() === 'auto';
      if (isAuto) return false;
      if (mode === 'noautohalf') {
        const isHalfAuto = String(l?.mode_halfauto ?? '').trim().toLowerCase() === 'halfauto';
        if (isHalfAuto) return false;
      }
      return true;
    });
  }

  async onScroll(delta, deviceId) {
    const st = this.getDeviceState(deviceId);
    const oledCount = Math.max(1, this.getOledEntriesForDevice(deviceId).length);
    if (st.view === View.LOCO_LIST) {
      st.locoScroll = applyWrappedListScroll(st.locoScroll, delta, this.locos.length, oledCount);
    } else if (st.view === View.THROTTLE && st.selectedLoco) {
      const fnSlotsCount = this._countThrottleFunctionOledSlots(deviceId);
      if (fnSlotsCount >= 1) {
        const defs = functionDefsForDisplay(st.locoProps, st.selectedLoco);
        st.fnScroll = applyWrappedListScroll(st.fnScroll, delta, defs.length, fnSlotsCount);
      }
    }
    await this.refreshOledsForDevice(deviceId);
    await this.refreshScrollForDevice(deviceId);
  }

  /** Dedicated encoder: loco list = scroll locos; throttle = scroll functions (same step rules as OLED dial). */
  async onScrollDialRotate(ticks, deviceId) {
    await this.initRocrail(false);
    const st = this.getDeviceState(deviceId);
    const oledCount = Math.max(1, this.getOledEntriesForDevice(deviceId).length);
    if (st.view === View.LOCO_LIST) {
      if (this._isLocoListDialPageMode()) {
        st.locoScroll = advanceListScrollByPageTicks(st.locoScroll, ticks, this.locos.length, oledCount);
      } else {
        st.locoScroll = applyWrappedListScroll(st.locoScroll, ticks, this.locos.length, oledCount);
      }
    } else if (st.view === View.THROTTLE && st.selectedLoco) {
      const fnSlotsCount = this._countThrottleFunctionOledSlots(deviceId);
      if (fnSlotsCount >= 1) {
        const defs = functionDefsForDisplay(st.locoProps, st.selectedLoco);
        if (this._isLocoListDialPageMode()) {
          st.fnScroll = advanceListScrollByPageTicks(st.fnScroll, ticks, defs.length, fnSlotsCount);
        } else {
          st.fnScroll = applyWrappedListScroll(st.fnScroll, ticks, defs.length, fnSlotsCount);
        }
      }
    }
    await this.refreshOledsForDevice(deviceId);
    await this.refreshScrollForDevice(deviceId);
  }

  /**
   * When loco locks change (e.g. back on one deck), other decks' list rows may need refresh
   * (busy vs selectable). Cheap: refresh LOCO_LIST on all devices.
   */
  async refreshAllDevicesLocoListVisuals() {
    for (const dev of this._allDeviceIds()) {
      const st = this.getDeviceState(dev);
      if (st.view === View.LOCO_LIST) {
        await this.refreshOledsForDevice(dev);
      }
    }
  }

  /** Rocrail TCP push (`<lc/>`, `<fn/>`, …): keep per‑loco function cache updated; throttle OLED refresh when driven loco changes. */
  _onRocrailPush(body, _name) {
    ingestLcFnXmlIntoCaches(this.perLocoFnCacheById, body);
    let touchedThrottle = false;
    for (const deviceId of this._allDeviceIds()) {
      const st = this.getDeviceState(deviceId);
      if (st.view !== View.THROTTLE || !st.selectedLoco?.id || !st.locoProps) continue;
      if (mergeLcOrFnAttrsIntoLocoProps(st.locoProps, body, st.selectedLoco.id)) {
        touchedThrottle = true;
        syncLocoFnCacheFromLocoProps(this.perLocoFnCacheById, st.locoProps);
      }
    }
    if (!touchedThrottle) return;
    if (this._lcPushRefreshTimer) clearTimeout(this._lcPushRefreshTimer);
    this._lcPushRefreshTimer = setTimeout(() => {
      this._lcPushRefreshTimer = null;
      for (const deviceId of this._allDeviceIds()) {
        const st = this.getDeviceState(deviceId);
        if (st.view === View.THROTTLE && st.selectedLoco) {
          void this.refreshOledsForDevice(deviceId).catch((e) =>
            this.log(`refreshOleds after Rocrail push: ${e?.message || String(e)}`)
          );
        }
      }
    }, 50);
  }

  async initRocrail(refreshAll = true) {
    this._initRocrailChain = this._initRocrailChain.catch(() => {}).then(() => this._initRocrailImpl(refreshAll));
    return this._initRocrailChain;
  }

  async _initRocrailImpl(refreshAll = true) {
    const host = this.globalSettings.host || '127.0.0.1';
    const port = parseInt(this.globalSettings.port || '8051', 10);
    this.log(`rocrail desired endpoint ${host}:${port}`);
    if (this.rocrail && (this.rocrail.host !== host || this.rocrail.port !== port)) {
      this.log(`rocrail endpoint changed, reconnecting ${this.rocrail.host}:${this.rocrail.port} -> ${host}:${port}`);
      this.rocrail.disconnect();
      this.rocrail = null;
    }
    if (!this.rocrail) {
      this.rocrail = new RocrailClient(host, port, {
        log: (m) => this.log(`[rocrail] ${m}`),
      });
      try {
        await this.rocrail.connect();
      } catch (e) {
        this.log(`Rocrail connection failed: ${e?.message || String(e)}`);
      }
    }
    if (this.rocrail) {
      this.rocrail.onPush = (body, name) => {
        void this._onRocrailPush(body, name);
      };
    }
    try {
      if (this.rocrail?.socket?.writable) {
        const allLocos = await this.rocrail.getLocoList(this.perLocoFnCacheById);
        this.locos = this._filterDisplayedLocos(allLocos);
        this.log(`loaded locos count=${this.locos.length} (of ${allLocos.length}) filter=${this.globalSettings.displayedLocos || 'all'}`);
      } else {
        this.log('getLocoList skipped: Rocrail socket not connected yet');
      }
    } catch (e) {
      this.log(`getLocoList failed: ${e?.message || String(e)}`);
      this.locos = [];
    }
    if (refreshAll) await this.refreshAllDevices();
  }

  /**
   * Build an HTTP URL for a Rocrail file served by the image / web service.
   * @param {string} fileName
   * @param {string} basePathSetting Configured base path (`httpBasePath` for images, icon base path for icons).
   */
  _buildHttpFileUrl(fileName, basePathSetting) {
    const name = (fileName || '').trim();
    if (!name) return null;
    const host = this.globalSettings.host || '127.0.0.1';
    const httpPort = parseInt(this.globalSettings.httpPort || '8080', 10);
    let basePath = (basePathSetting ?? '/').trim() || '/';
    if (!basePath.startsWith('/')) basePath = `/${basePath}`;
    if (basePath !== '/' && !basePath.endsWith('/')) basePath += '/';
    const pathPrefix = basePath === '/' ? '' : basePath.replace(/\/$/, '');
    const urlPath = pathPrefix
      ? `${pathPrefix}/${encodeURIComponent(name)}`
      : `/${encodeURIComponent(name)}`;
    return `http://${host}:${httpPort}${urlPath}`;
  }

  /** Function-icon base path: dedicated `httpIconBasePath` when set, otherwise the shared image base path. */
  _iconBasePathSetting() {
    const v = (this.globalSettings.httpIconBasePath ?? '').trim();
    return v !== '' ? v : (this.globalSettings.httpBasePath ?? '/');
  }

  /** Fetch + render a Rocrail function icon onto an OLED tile; cached in memory and on disk like loco images. */
  async _loadFunctionIconDataUri(iconName, on) {
    const name = (iconName || '').trim();
    if (!name) return null;
    const url = this._buildHttpFileUrl(name, this._iconBasePathSetting());
    if (!url) return null;

    let sourceBuffer = this._fnIconSourceByUrl.get(url);
    if (sourceBuffer === undefined) {
      sourceBuffer = null;
      try {
        if (PLUGIN_DEBUG) this.log(`loading function icon via http icon=${name} url=${url}`);
        const res = await fetch(url, { redirect: 'follow' });
        if (res.ok) {
          sourceBuffer = Buffer.from(await res.arrayBuffer());
          if (PLUGIN_DEBUG) this.log(`http icon fetched icon=${name} bytes=${sourceBuffer.length}`);
        } else {
          this.log(`http icon fetch failed status=${res.status} icon=${name}`);
        }
      } catch (e) {
        this.log(`http icon fetch error icon=${name}: ${e?.message || String(e)}`);
      }
      this._fnIconSourceByUrl.set(url, sourceBuffer);
    }
    if (!sourceBuffer) return null;

    const srcHash = sourceContentHash(sourceBuffer);
    const memKey = `${name}|${on ? 1 : 0}|${srcHash}`;
    if (this._fnIconCache.has(memKey)) return this._fnIconCache.get(memKey);

    try {
      const png = await getCachedFunctionIconPng(COMPOSITE_CACHE_DIR, name, on, sourceBuffer);
      const dataUri = `data:image/png;base64,${png.toString('base64')}`;
      this._fnIconCache.set(memKey, dataUri);
      return dataUri;
    } catch (e) {
      this.log(`function icon render failed icon=${name}: ${e?.message || String(e)}`);
      this._fnIconCache.set(memKey, null);
      return null;
    }
  }

  async _loadLocoImageDataUri(loco, fontPx = null) {
    if (!loco?.id) return null;

    const displayText = formatLocoDisplayName(loco);
    let sourceBuffer = null;

    const imageName = (loco.image || '').trim();
    if (imageName) {
      const url = this._buildHttpFileUrl(imageName, this.globalSettings.httpBasePath ?? '/');
      try {
        if (PLUGIN_DEBUG) this.log(`loading loco image via http loco=${loco.id} url=${url}`);
        const res = await fetch(url, { redirect: 'follow' });
        if (res.ok) {
          sourceBuffer = Buffer.from(await res.arrayBuffer());
          if (PLUGIN_DEBUG) this.log(`http image fetched loco=${loco.id} bytes=${sourceBuffer.length}`);
        } else {
          this.log(`http image fetch failed status=${res.status} loco=${loco.id}`);
        }
      } catch (e) {
        this.log(`http image fetch error loco=${loco.id}: ${e?.message || String(e)}`);
      }
    } else {
      if (PLUGIN_DEBUG) this.log(`no loco image file loco=${loco.id}, composite text-only`);
    }

    const srcHash = sourceContentHash(sourceBuffer);
    const fsKey = fontPx != null && Number.isFinite(fontPx) ? String(Math.round(fontPx)) : 'auto';
    const memKey = `${loco.id}|${displayText}|${srcHash}|${fsKey}`;
    if (this._locoImageCache.has(memKey)) {
      if (PLUGIN_DEBUG) this.log(`loco composite memory cache hit loco=${loco.id}`);
      return this._locoImageCache.get(memKey);
    }

    try {
      const fp = fontPx != null && Number.isFinite(fontPx) ? Math.round(fontPx) : null;
      const png = await getCachedCompositePng(COMPOSITE_CACHE_DIR, loco.id, displayText, sourceBuffer, fp);
      const dataUri = `data:image/png;base64,${png.toString('base64')}`;
      this._locoImageCache.set(memKey, dataUri);
      if (PLUGIN_DEBUG) this.log(`loco composite ready loco=${loco.id} cacheDir=${COMPOSITE_CACHE_DIR}`);
      return dataUri;
    } catch (e) {
      this.log(`loco composite failed loco=${loco.id}: ${e?.message || String(e)}`);
      this._locoImageCache.set(memKey, null);
      return null;
    }
  }

  async refreshAllDevices() {
    for (const dev of this._allDeviceIds()) {
      await this.refreshDevice(dev);
    }
  }

  async refreshDevice(deviceId) {
    await this.refreshOledsForDevice(deviceId);
    await this.refreshSimpleButtonsForDevice(deviceId);
    await this.refreshDialForDevice(deviceId);
    await this.refreshBackForDevice(deviceId);
    await this.refreshScrollForDevice(deviceId);
  }

  async refreshOledsForDevice(deviceId) {
    this._normalizeScrollPositionsForDevice(deviceId);
    const st = this.getDeviceState(deviceId);
    const entries = this.getOledEntriesForDevice(deviceId);
    const compositeFontPx = this._effectiveOledTextFontPx();

    if (st.view === View.LOCO_LIST) {
      for (let i = 0; i < entries.length; i++) {
        const [ctx] = entries[i];
        const loco = this.locos[st.locoScroll + i];
        if (!loco) {
          this.setImage(ctx, null);
          this.setTitle(ctx, '');
          this.setState(ctx, 0);
          continue;
        }

        if (this._isLocoLockedByOther(loco.id, deviceId)) {
          this.setImage(ctx, null);
          this.setTitle(ctx, `[busy] ${formatLocoDisplayName(loco)}`);
          this._setTitleParametersMaybe(ctx);
          this.setState(ctx, 0);
          continue;
        }

        const dataUri = await this._loadLocoImageDataUri(loco, compositeFontPx);
        if (dataUri) {
          this.setImage(ctx, dataUri);
          this.setTitle(ctx, '');
          this.setState(ctx, 0);
        } else {
          this.setImage(ctx, null);
          this.setTitle(ctx, formatLocoDisplayName(loco));
          this._setTitleParametersMaybe(ctx);
          this.setState(ctx, 0);
        }
      }
    } else if (st.view === View.THROTTLE && st.selectedLoco && st.locoProps) {
      const defs = functionDefsForDisplay(st.locoProps, st.selectedLoco);
      const fnSlotIdxs = [];
      for (let gi = 0; gi < entries.length; gi++) {
        const [c] = entries[gi];
        if (this._throttleViewForOledContext(c) === OLED_THROTTLE_VIEW_FN) fnSlotIdxs.push(gi);
      }

      const locMerged = {
        ...(st.selectedLoco || {}),
        id: st.locoProps.id || st.selectedLoco?.id,
        name: st.locoProps.name || st.selectedLoco?.name,
        image:
          (st.locoProps.rawAttrs && st.locoProps.rawAttrs.image) ||
          st.locoProps.image ||
          st.selectedLoco?.image ||
          '',
      };

      const speedLbl = this.rocrail ? this.rocrail.formatSpeed(st.locoProps) : '---';

      for (let i = 0; i < entries.length; i++) {
        const [ctx] = entries[i];
        const tv = this._throttleViewForOledContext(ctx);

        if (tv === OLED_THROTTLE_VIEW_LOCO) {
          if (this._isLocoLockedByOther(locMerged.id, deviceId)) {
            this.setImage(ctx, null);
            this.setTitle(ctx, `[busy] ${formatLocoDisplayName(locMerged)}`);
            this._setTitleParametersMaybe(ctx);
            this.setState(ctx, 0);
            continue;
          }
          const dataUri = await this._loadLocoImageDataUri(locMerged, compositeFontPx);
          if (dataUri) {
            this.setImage(ctx, dataUri);
            this.setTitle(ctx, '');
            this.setState(ctx, 0);
          } else {
            this.setImage(ctx, null);
            this.setTitle(ctx, formatLocoDisplayName(locMerged));
            this._setTitleParametersMaybe(ctx);
            this.setState(ctx, 0);
          }
          continue;
        }

        if (isSpeedFamilyThrottleView(tv)) {
          try {
            const png = await renderThrottleSpeedDirPng(
              speedLbl,
              st.locoProps.dir === true,
              undefined,
              compositeFontPx,
              speedTileRenderMode(tv)
            );
            const uri = `data:image/png;base64,${png.toString('base64')}`;
            this.setImage(ctx, uri);
          } catch (e) {
            this.log(`throttle speed key render failed: ${e?.message || String(e)}`);
            this.setImage(ctx, null);
          }
          this.setTitle(ctx, '');
          this.setState(ctx, 0);
          continue;
        }

        const fi = fnSlotIdxs.indexOf(i);
        if (fi < 0) {
          this.setImage(ctx, null);
          this.setTitle(ctx, '');
          this.setState(ctx, 0);
          continue;
        }
        const def = defs[st.fnScroll + fi];
        if (!def) {
          this.setImage(ctx, null);
          this.setTitle(ctx, '');
          this.setState(ctx, 0);
          continue;
        }
        const on = rocrailFnIsActive(st.locoProps, def.fn);
        const iconUri = def.icon ? await this._loadFunctionIconDataUri(def.icon, on) : null;
        if (iconUri) {
          this.setImage(ctx, iconUri);
          this.setTitle(ctx, '');
          this.setState(ctx, on ? 1 : 0);
          continue;
        }
        // Label baked into the image: OpenDeck ignores setTitleParameters, so the configured
        // font size only takes effect for image-rendered text.
        try {
          const png = await renderFunctionLabelPng(def.text || `F${def.fn}`, on, undefined, compositeFontPx);
          this.setImage(ctx, `data:image/png;base64,${png.toString('base64')}`);
          this.setTitle(ctx, '');
        } catch (e) {
          this.log(`fn label tile render failed: ${e?.message || String(e)}`);
          const uri = on ? await getFnKeyOnBackgroundDataUri() : await getFnKeyOffBackgroundDataUri();
          this.setImage(ctx, uri);
          this.setTitle(ctx, wrapFnLabel(def.text || `F${def.fn}`, 9, 4));
          this._setTitleParametersMaybe(ctx);
        }
        this.setState(ctx, on ? 1 : 0);
      }
    }
  }

  async refreshSimpleButtonsForDevice(deviceId) {
    const d = this._deviceId(deviceId);
    const st = this.getDeviceState(d);
    const show = !!st.selectedLoco;
    for (const [ctx, info] of this.simpleContexts) {
      if (info.device !== d) continue;
      if (info.type === 'dirfwd') this.setTitle(ctx, show ? 'Fwd →' : '');
      if (info.type === 'dirrev') this.setTitle(ctx, show ? '← Rev' : '');
      if (info.type === 'stoploco') this.setTitle(ctx, show ? 'Stop 0%' : '');
      if (info.type === 'speedplus') this.setTitle(ctx, show ? '+5 %' : '');
      if (info.type === 'speedminus') this.setTitle(ctx, show ? '-5 %' : '');
    }
  }

  async refreshDialForDevice(deviceId) {
    const d = this._deviceId(deviceId);
    const st = this.getDeviceState(d);
    const speedCtx = this.dialContextByDevice.get(d);
    if (speedCtx) {
      this.setTitle(speedCtx, st.selectedLoco ? 'Speed' : 'Scroll');
    }
    const scrollCtx = this.scrollDialContextByDevice.get(d);
    if (scrollCtx) {
      this.setTitle(scrollCtx, st.selectedLoco ? 'Functions' : 'Locos');
    }
  }

  async refreshBackForDevice(deviceId) {
    const d = this._deviceId(deviceId);
    const ctx = this.backContextByDevice.get(d);
    if (!ctx) return;
    this.setTitle(ctx, '← Back');
  }

  _normalizeScrollPositionsForDevice(deviceId) {
    const st = this.getDeviceState(deviceId);
    const oledCount = Math.max(1, this.getOledEntriesForDevice(deviceId).length);
    if (st.view === View.LOCO_LIST) {
      const len = this.locos.length;
      if (!listCanScroll(len, oledCount)) st.locoScroll = 0;
      else st.locoScroll = Math.min(st.locoScroll, listMaxScrollStart(len, oledCount));
    } else if (st.view === View.THROTTLE && st.selectedLoco) {
      const fnSlotsCount = this._countThrottleFunctionOledSlots(deviceId);
      if (fnSlotsCount < 1) st.fnScroll = 0;
      else {
        const defs = functionDefsForDisplay(st.locoProps, st.selectedLoco);
        const len = defs.length;
        if (!listCanScroll(len, fnSlotsCount)) st.fnScroll = 0;
        else st.fnScroll = Math.min(st.fnScroll, listMaxScrollStart(len, fnSlotsCount));
      }
    }
  }

  async refreshScrollForDevice(deviceId) {
    const d = this._deviceId(deviceId);
    const st = this.getDeviceState(d);
    const oledCount = Math.max(1, this.getOledEntriesForDevice(d).length);
    let hasUp = false;
    let hasDown = false;
    if (st.view === View.LOCO_LIST) {
      const can = listCanScroll(this.locos.length, oledCount);
      hasUp = can;
      hasDown = can;
    } else if (st.view === View.THROTTLE && st.selectedLoco) {
      const fnSlotsCount = this._countThrottleFunctionOledSlots(d);
      const defs = functionDefsForDisplay(st.locoProps, st.selectedLoco);
      const can = fnSlotsCount >= 1 && listCanScroll(defs.length, fnSlotsCount);
      hasUp = can;
      hasDown = can;
    }

    for (const x of this.scrollUpContexts) {
      if (x.device === d) this.setTitle(x.context, hasUp ? '▲' : '');
    }
    for (const x of this.scrollDownContexts) {
      if (x.device === d) this.setTitle(x.context, hasDown ? '▼' : '');
    }
  }
}

async function main() {
  const plugin = new RocrailPlugin();
  plugin.parseArgs();

  if (!plugin.port || !plugin.pluginUUID || !plugin.registerEvent) {
    console.error('Usage: -port PORT -pluginUUID UUID -registerEvent EVENT');
    process.exit(1);
  }

  await plugin.connect();
  plugin.send({ event: 'getGlobalSettings', context: plugin.pluginUUID });

  process.stdin.resume();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
