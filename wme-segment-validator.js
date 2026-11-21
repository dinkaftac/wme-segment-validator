// ==UserScript==
// @name         WME Segment Validator
// @namespace    local.wme.segment.validator
// @author       dinkaftac
// @homepageURL  https://github.com/dinkaftac/wme-segment-validator
// @supportURL   https://github.com/dinkaftac/wme-segment-validator/issues
// @updateURL    https://raw.githubusercontent.com/dinkaftac/wme-segment-validator/main/wme-segment-validator.user.js
// @downloadURL  https://raw.githubusercontent.com/dinkaftac/wme-segment-validator/main/wme-segment-validator.user.js
// @version      0.17.0
// @description  Segment validator: viewport / managed area / driven area / custom polygon (draw or shapefile), save-triggered re-checks, soft highlights under the roads, clickable error list. Official WME SDK only.
// @match        https://www.waze.com/*/editor*
// @match        https://beta.waze.com/*/editor*
// @exclude      https://www.waze.com/user/editor*
// @exclude      https://www.waze.com/editor/sdk/*
// @require      https://unpkg.com/shpjs@latest/dist/shp.min.js
// @run-at       document-end
// @grant        none
// ==/UserScript==

/* global getWmeSdk */
(() => {
  'use strict';

  const ID = 'wme-segment-validator';
  const NAME = 'Segment Validator';
  const VERSION = '0.17.0';
  const LAYER = 'segment-validator-highlights';
  const HALO_LAYER = 'segment-validator-current';   // halo behind the highlight for the focused segment
  const SCOPE_LAYER = 'segment-validator-scope';
  const BORDER_LAYER = 'segment-validator-borders';   // all imported / drawn sections, always visible, labelled
  const MAX_DRAWN = 3000;
  const PAGE = 200;

  // Soft, eye-friendly palette. FeatureStyle takes hex colours plus a separate strokeOpacity.
  // Three severity tiers, like the reference validators: red errors, amber warnings, blue notes.
  // Rules keep their finer 'sev' label; TIER folds it into one of the three tiers used for colour, order, list and filters.
  const PALETTE = { error: '#e53935', warning: '#f5a300', note: '#1e88e5' };
  const RANK = { error: 3, warning: 2, note: 1 };
  const SEV_NAME = { error: 'Errors', warning: 'Warnings', note: 'Notes' };
  const TIER = { error: 'error', warning: 'warning', topology: 'warning', info: 'note', note: 'note' };

  // Well-known WME road type ids (verify with the "Copy diagnostics" output).
  const NAMED_TYPES = new Set([1, 2, 6, 7]);          // Street, Primary, Major Hwy, Minor Hwy
  const SPEED_TYPES = new Set([1, 2, 3, 4, 6, 7]);
  const CLASS = { 1: 1, 2: 2, 7: 3, 6: 4, 3: 5 };     // continuity class (higher = bigger road); ramps handled separately
  const WIDTH_FACTOR = { 1: 1, 2: 1.1, 3: 1.5, 4: 0.9, 6: 1.3, 7: 1.2 };

  let sdk;
  const ui = {};
  const offs = [];                                    // unregister functions returned by Events.on (if any)
  const state = {
    enabled: true,
    autoMove: true,           // debounced re-scan on map move / zoom / data load
    highlightOnly: false,
    collapsed: {},
    autoSave: true,           // validate edited segments after a successful save
    accumulate: true,
    scope: 'viewport',        // 'viewport' | 'area'
    loadMP: true, mpSig: '',
    areaKey: 'viewport',      // 'viewport' | 'managed:<i|all>' | 'drive:<i|all>' | 'custom:<i|all>'
    sweeping: false, sweepCancel: false, sweepPaused: false,
    sweepZoom: 14, bgEnabled: false, open: {}, areasReady: false,
    limitToViewport: true,
    showSections: true,       // draw the borders + names of every imported / drawn section
    skipDone: false,          // sweep only sections not yet swept this session
    managedAreaId: 'all',
    managedAreas: [],         // [{ id, name, geometry }]
    driveAreas: null,         // null = not loaded yet, otherwise [{ geometry, name, bbox }]
    driveSource: '',
    polygons: [],             // [{ geometry, name, bbox }] drawn or imported
    rules: {},
    abbrevPattern: '\\b(St|Rd|Ave|Blvd|Dr|Ln|Hwy|Jln)\\.(?=\\s|$)',
    extraWidth: 4,
    nearMissM: 5,             // loose-end distance in metres (panel setting)
    layerOpacity: 1,
    store: new Map(),         // segmentId -> { id, geometry, mid, rt, hits: [ruleId] }
    visited: new Set(),
    view: [],
    filterSev: 'all',
    filterRule: 'all',
    sortBy: 'severity',
    hideVisited: false,
    listLimit: PAGE,
    zoomTo: 17,
    selectOnJump: false,
    currentId: null,
    center: null,
    underRoads: null,         // result of placing the layer below the native segments layer
  };

  // ------------------------------------------------------------------ log
  const LOG_MAX = 1500;
  const NOISE = /gRPC-TS|Street to [Rr]iver|Last river width|%cBootstrap/;   // other scripts' chatter: keep it out of our log
  const logBuf = [];
  const origConsole = {};
  const fmt = a => {
    if (a instanceof Error) return a.stack || String(a);
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch (e) { return String(a); }
  };
  function pushLog(level, src, args) {
    if (src === '[console]' && NOISE.test(args.map(fmt).join(' ').slice(0, 200))) return;
    logBuf.push(`[${new Date().toISOString().slice(11, 23)}] ${level.toUpperCase()} ${src} ${args.map(fmt).join(' ')}`);
    if (logBuf.length > LOG_MAX) logBuf.shift();
    if (ui.log) { ui.log.value = logBuf.join('\n'); ui.log.scrollTop = ui.log.scrollHeight; }
  }
  const log = {};
  for (const lvl of ['info', 'warn', 'error']) {
    log[lvl] = (...a) => { pushLog(lvl, '[validator]', a); (origConsole[lvl] || console[lvl]).call(console, NAME, ...a); };
  }
  const cap = { on: false, verbose: false };
  function applyCapture() {
    const want = cap.on ? (cap.verbose ? ['log', 'info', 'warn', 'error', 'debug'] : ['warn', 'error']) : [];
    for (const lvl of ['log', 'info', 'warn', 'error', 'debug']) {
      if (origConsole[lvl] && !want.includes(lvl)) { console[lvl] = origConsole[lvl]; delete origConsole[lvl]; }
      else if (!origConsole[lvl] && want.includes(lvl)) {
        origConsole[lvl] = console[lvl];
        console[lvl] = (...a) => { pushLog(lvl, '[console]', a); origConsole[lvl].apply(console, a); };
      }
    }
  }
  const srcOf = txt => { const m = /userscript\.html\?name=([^&:\s]+)/.exec(txt || ''); return m ? decodeURIComponent(m[1]) : null; };
  window.addEventListener('error', e => {
    const who = srcOf(e.filename) || srcOf(e.error && e.error.stack);
    pushLog('error', who ? `[page:${who}]` : '[page]', [`${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`]);
  });
  window.addEventListener('unhandledrejection', e => {
    const who = srcOf(e.reason && e.reason.stack);
    pushLog('error', who ? `[page:${who}]` : '[page]', ['Unhandled rejection:', e.reason]);
  });
  const warned = new Set();
  const warnOnce = (key, err) => { if (!warned.has(key)) { warned.add(key); log.warn(`rule/step "${key}" failed`, err); } };

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall through */ }
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  // ----------------------------------------------------- SDK introspection
  function listMethods(obj) {
    const names = new Set();
    for (let o = obj; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const n of Object.getOwnPropertyNames(o)) {
        if (n === 'constructor') continue;
        try { if (typeof obj[n] === 'function') names.add(n); } catch (e) { /* ignore */ }
      }
    }
    return [...names].sort();
  }
  function apiCheck() {
    const dm = sdk.DataModel || {};
    const used = [
      ['Map', sdk.Map, ['getMapExtent', 'getMapCenter', 'setMapCenter', 'getZoomLevel', 'addLayer', 'removeLayer', 'addFeatureToLayer',
        'addFeaturesToLayer', 'removeAllFeaturesFromLayer', 'redrawLayer', 'setLayerOpacity', 'setLayerVisibility',
        'getLayerZIndex', 'setLayerZIndex', 'drawPolygon']],
      ['State', sdk.State, ['getUserInfo', 'isMapLoading']],
      ['DataModel.Segments', dm.Segments, ['getAll', 'getById', 'hasPermissions']],
      ['DataModel.Streets', dm.Streets, ['getAll', 'getById']],
      ['DataModel.Cities', dm.Cities, ['getAll', 'getById']],
      ['DataModel.ManagedAreas', dm.ManagedAreas, ['getById', 'getAll']],
      ['DataModel.Turns', dm.Turns, ['getTurnsFromSegment']],
      ['Editing', sdk.Editing, ['setSelection']],
      ['Sidebar', sdk.Sidebar, ['registerScriptTab']],
      ['Events', sdk.Events, ['on', 'once']],
    ];
    const lines = used.flatMap(([label, obj, names]) =>
      names.map(n => `${obj && typeof obj[n] === 'function' ? 'OK     ' : 'MISSING'} ${label}.${n}`));
    lines.push(`${typeof window.shp === 'function' || (window.shp && typeof window.shp.default === 'function') ? 'OK     ' : 'MISSING'} shpjs (@require)`);
    return lines.join('\n');
  }
  function inventory() {
    const dm = sdk.DataModel || {};
    const mods = { Map: sdk.Map, State: sdk.State, Editing: sdk.Editing, Events: sdk.Events, Settings: sdk.Settings,
      'DataModel.Segments': dm.Segments, 'DataModel.Turns': dm.Turns, 'DataModel.ManagedAreas': dm.ManagedAreas,
      'DataModel.Nodes': dm.Nodes, 'DataModel.Streets': dm.Streets };
    const lines = Object.entries(mods).map(([k, v]) => `${k}: ${v ? listMethods(v).join(', ') : '(missing)'}`);
    try { lines.unshift(`DataModel submodules: ${Object.getOwnPropertyNames(dm).filter(n => dm[n] && typeof dm[n] === 'object').join(', ')}`); } catch (e) { /* ignore */ }
    return lines.join('\n');
  }
  async function diagnostics() {
    let zoom, userLine;
    try { zoom = await sdk.Map.getZoomLevel(); } catch (e) { zoom = `error: ${e.message}`; }
    try {
      const u = await sdk.State.getUserInfo();
      userLine = u ? `rank=${u.rank} areaManager=${u.isAreaManager} countryManager=${u.isCountryManager} managedAreas=${JSON.stringify((u.managedAreas || []).map(m => m.name))}` : 'not logged in';
    } catch (e) { userLine = `error: ${e.message}`; }
    return [
      `${NAME} ${VERSION}`,
      `Time: ${new Date().toISOString()}`,
      `UA: ${navigator.userAgent}`,
      `Zoom: ${zoom}`,
      `User: ${userLine}`,
      `Highlight layer placed under native segments layer: ${state.underRoads}`,
      `Drive areas: source="${state.driveSource}" count=${state.driveAreas ? state.driveAreas.length : 'not loaded'}`,
      `State: ${JSON.stringify({ enabled: state.enabled, autoMove: state.autoMove, autoSave: state.autoSave, scope: state.scope,
        limitToViewport: state.limitToViewport, managedAreasLoaded: state.managedAreas.length, polygons: state.polygons.length,
        stored: state.store.size, shown: state.view.length, enabledRules: Object.keys(state.rules).filter(k => state.rules[k]) })}`,
      '--- SDK API check ---', apiCheck(),
      '--- SDK method inventory ---', inventory(),
      '--- Log ---', logBuf.join('\n'),
    ].join('\n');
  }

  // ------------------------------------------------------------- geometry
  function ringContains([x, y], ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function polygonContains(pt, poly) {
    const rings = poly.coordinates;
    if (!ringContains(pt, rings[0])) return false;
    for (let i = 1; i < rings.length; i++) if (ringContains(pt, rings[i])) return false;
    return true;
  }
  function bboxOfCoords(coords) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const [x, y] of coords) { if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; }
    return [a, b, c, d];
  }
  const bboxHit = (p, q) => p[0] <= q[2] && p[2] >= q[0] && p[1] <= q[3] && p[3] >= q[1];
  const segBBox = s => bboxOfCoords(s.geometry.coordinates);
  const mkArea = (geometry, name) => ({ geometry, name, bbox: bboxOfCoords(geometry.coordinates[0]) });
  const segInArea = (s, area) => {
    if (!bboxHit(segBBox(s), area.bbox)) return false;
    // Check if any vertex is inside
    if (s.geometry.coordinates.some(pt => polygonContains(pt, area.geometry))) return true;
    // Check midpoint for crossing segments
    const mid = lineMidpoint(s.geometry.coordinates);
    return polygonContains(mid, area.geometry);
  };

  function lineMidpoint(coords) {
    if (coords.length < 2) return coords[0];
    const lens = [];
    let total = 0;
    for (let i = 1; i < coords.length; i++) {
      const d = Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]);
      lens.push(d); total += d;
    }
    let half = total / 2;
    for (let i = 0; i < lens.length; i++) {
      if (half <= lens[i] || i === lens.length - 1) {
        const t = lens[i] ? half / lens[i] : 0;
        return [coords[i][0] + (coords[i + 1][0] - coords[i][0]) * t, coords[i][1] + (coords[i + 1][1] - coords[i][1]) * t];
      }
      half -= lens[i];
    }
    return coords[0];
  }
  const distM = (c, [lon, lat]) => {
    const k = Math.cos(((c.lat + lat) / 2) * Math.PI / 180);
    return Math.hypot((lon - c.lon) * 111320 * k, (lat - c.lat) * 110540);
  };
  const fmtDist = m => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
  function distPointToLineM(p, coords) {            // metres, local planar approximation around p
    const k = Math.cos(p[1] * Math.PI / 180) * 111320, kk = 110540;
    let best = Infinity;
    for (let i = 1; i < coords.length; i++) {
      const ax = (coords[i - 1][0] - p[0]) * k, ay = (coords[i - 1][1] - p[1]) * kk;
      const bx = (coords[i][0] - p[0]) * k, by = (coords[i][1] - p[1]) * kk;
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
    return best;
  }
  function bearingAway(s, nodeId) {                 // direction of the segment leaving the node, degrees
    const c = s.geometry.coordinates;
    const [p, q] = s.fromNodeId === nodeId ? [c[0], c[1]] : [c[c.length - 1], c[c.length - 2]];
    const k = Math.cos(p[1] * Math.PI / 180);
    return Math.atan2((q[0] - p[0]) * k, q[1] - p[1]) * 180 / Math.PI;
  }
  const angleDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

  // ------------------------------------------------- topology helpers/ctx
  const ends = s => [s.fromNodeId, s.toNodeId];
  const at = (c, n) => (n == null ? [] : c.nodes.get(n) || []);
  const others = (c, s, n) => at(c, n).filter(t => t.id !== s.id);
  const leaves = (t, n) => t.isTwoWay || (t.isAtoB && t.fromNodeId === n) || (t.isBtoA && t.toNodeId === n);
  const arrives = (t, n) => t.isTwoWay || (t.isAtoB && t.toNodeId === n) || (t.isBtoA && t.fromNodeId === n);
  const fwdOpen = s => s.isTwoWay || s.isAtoB;
  const revOpen = s => s.isTwoWay || s.isBtoA;
  const pairKey = s => (s.fromNodeId < s.toNodeId ? `${s.fromNodeId}|${s.toNodeId}` : `${s.toNodeId}|${s.fromNodeId}`);
  const streetOf = (s, c) => (s.primaryStreetId == null ? null : c.streets.get(s.primaryStreetId) || null);
  const nameOf = (s, c) => { const st = streetOf(s, c); return st && st.name ? st.name.trim() : ''; };
  const cityOk = (st, c) => {
    if (!st || st.cityId == null) return false;
    const ct = c.cities.get(st.cityId);
    return !!(ct && !ct.isEmpty && ct.name);
  };
  const clsOf = s => CLASS[s.roadType] || 0;

  const GRID = 0.0003;                              // ~33 m cells
  function buildGrid(segs) {
    const g = new Map();
    for (const s of segs) {
      const [a, b, c, d] = segBBox(s);
      for (let ix = Math.floor(a / GRID); ix <= Math.floor(c / GRID); ix++)
        for (let iy = Math.floor(b / GRID); iy <= Math.floor(d / GRID); iy++) {
          const k = `${ix},${iy}`;
          if (!g.has(k)) g.set(k, []);
          g.get(k).push(s);
        }
    }
    return g;
  }
  function near(c, p) {
    const g = c.grid(), ix = Math.floor(p[0] / GRID), iy = Math.floor(p[1] / GRID), out = new Set();
    for (let x = ix - 1; x <= ix + 1; x++) for (let y = iy - 1; y <= iy + 1; y++) (g.get(`${x},${y}`) || []).forEach(s => out.add(s));
    return out;
  }
  const nmLogged = new Set();
  function nearMiss(s, c) {
    if (!s.isDrivable) return false;
    const co = s.geometry.coordinates;
    for (const [nid, p] of [[s.fromNodeId, co[0]], [s.toNodeId, co[co.length - 1]]]) {
      if (nid == null || at(c, nid).length !== 1) continue;
      for (const t of near(c, p)) {
        if (t.id === s.id || (t.elevationLevel ?? 0) !== (s.elevationLevel ?? 0)) continue;
        const dist = distPointToLineM(p, t.geometry.coordinates);
        if (dist < state.nearMissM) {
          if (!nmLogged.has(s.id)) { nmLogged.add(s.id); log.info(`NEAR_MISS: segment ${s.id} endpoint is ${Math.round(dist)}m from segment ${t.id}`); }
          return true;
        }
      }
    }
    return false;
  }
  function overlap(s, c) {                          // two roads leave a node in (almost) the same direction
    if (!s.isDrivable) return false;
    for (const n of ends(s)) {
      for (const t of others(c, s, n)) {
        if (t.isDrivable && (t.elevationLevel ?? 0) === (s.elevationLevel ?? 0) &&
            s.geometry.coordinates.length > 1 && t.geometry.coordinates.length > 1 &&
            angleDiff(bearingAway(s, n), bearingAway(t, n)) < 3) return true;
      }
    }
    return false;
  }
  function straightNode(s, c) {                     // node with exactly two identical segments: node adds nothing
    if (!s.isDrivable || s.junctionId != null) return false;
    return ends(s).some(n => {
      const here = at(c, n);
      if (n == null || here.length !== 2) return false;
      const t = here.find(x => x.id !== s.id);
      if (!t || !t.isDrivable || t.junctionId != null) return false;
      const sortSp = x => [x.fwdSpeedLimit, x.revSpeedLimit].join('/').split('/').sort().join('/');
      const sameFlow = (s.isTwoWay && t.isTwoWay) ||
        (!s.isTwoWay && !t.isTwoWay && ((arrives(s, n) && leaves(t, n)) || (leaves(s, n) && arrives(t, n))));
      return sameFlow && s.roadType === t.roadType && s.primaryStreetId === t.primaryStreetId &&
        s.lockRank === t.lockRank && (s.elevationLevel ?? 0) === (t.elevationLevel ?? 0) &&
        !s.hasRestrictions && !t.hasRestrictions && !s.hasClosures && !t.hasClosures &&
        sortSp(s) === sortSp(t) && [...s.alternateStreetIds].sort().join() === [...t.alternateStreetIds].sort().join();
    });
  }

  async function loadById(mod, argName, ids) {
    const map = new Map();
    if (mod && typeof mod.getAll === 'function') {
      try {
        (await mod.getAll()).forEach(x => map.set(x.id, x));
        ids = [...ids].filter(i => !map.has(i));        // getAll only returns what WME has cached: fetch the rest one by one
        if (!ids.length) return map;
      } catch (e) { warnOnce('getAll', e); }
    }
    const list = [...ids];
    for (let i = 0; i < list.length; i += 100) {
      await Promise.all(list.slice(i, i + 100).map(id => Promise.resolve().then(() => mod.getById({ [argName]: id }))
        .then(x => { if (x) map.set(id, x); }).catch(() => {})));
    }
    return map;
  }
  async function buildContext(all) {
    const c = { seg: new Map(), nodes: new Map(), pairs: new Map(), streets: new Map(), cities: new Map(), _grid: null };
    const streetIds = new Set();
    for (const s of all) {
      c.seg.set(s.id, s);
      for (const n of new Set(ends(s))) if (n != null) { if (!c.nodes.has(n)) c.nodes.set(n, []); c.nodes.get(n).push(s); }
      if (s.isDrivable && s.fromNodeId != null && s.toNodeId != null && s.fromNodeId !== s.toNodeId) {
        const k = pairKey(s); c.pairs.set(k, (c.pairs.get(k) || 0) + 1);
      }
      if (s.primaryStreetId != null) streetIds.add(s.primaryStreetId);
      (s.alternateStreetIds || []).forEach(i => streetIds.add(i));
    }
    const needNames = [...NAME_RULES].some(id => state.rules[id]);
    const needNodes = RULES.some(r => state.rules[r.id] && NEIGHBOUR_RULE(r));
    if (needNames) {                                 // only fetch what the ticked rules read
      c.streets = await loadById(sdk.DataModel.Streets, 'streetId', streetIds);
      const cityIds = new Set([...c.streets.values()].map(st => st.cityId).filter(i => i != null));
      c.cities = await loadById(sdk.DataModel.Cities, 'cityId', cityIds);
    }
    c.nodeRec = new Map(); c.nodeApi = false;       // WME's own node records list every segment on the node, loaded or not
    if (needNodes) try {
      const nodes = await sdk.DataModel.Nodes.getAll();
      nodes.forEach(n => c.nodeRec.set(n.id, n));
      c.nodeApi = nodes.length > 0 && nodes.some(n => Array.isArray(n.connectedSegmentIds));
      if (!c.nodeApi) warnOnce('nodes-shape', 'Nodes.getAll gave no connectedSegmentIds: neighbour checks run on loaded segments only');
    } catch (e) { warnOnce('nodes-getAll', e); }
    c.grid = () => { if (!c._grid) c._grid = buildGrid(all.filter(s => s.isDrivable)); return c._grid; };
    c.mp = new Map();                                // segmentId -> open Waze map problems located on / next to it
    if (state.loadMP && state.rules.MP_OPEN) {
      try {
        const mps = (await sdk.DataModel.MapProblems.getAll()).filter(m => m && m.isOpen !== false && m.geometry && m.geometry.coordinates);
        const types = {};
        for (const m of mps) {
          types[String(m.problemType)] = (types[String(m.problemType)] || 0) + 1;
          const p = m.geometry.coordinates;
          const hits = [...near(c, p)].map(t => [distPointToLineM(p, t.geometry.coordinates), t]).filter(x => x[0] < 25).sort((a, b) => a[0] - b[0]).slice(0, 3);
          for (const [, t] of hits) { if (!c.mp.has(t.id)) c.mp.set(t.id, []); c.mp.get(t.id).push(m); }
        }
        const sig = JSON.stringify(types);
        if (sig !== state.mpSig) { state.mpSig = sig; log.info(`map problems loaded: open=${mps.length} byType=${sig} segmentsFlagged=${c.mp.size}`); }
      } catch (e) { warnOnce('map-problems', e); }
    }
    return c;
  }

  // ---------------------------------------------------------------- rules
  // { id, cat, sev, on, label, test(segment, ctx), slow?, async? }
  // Non-slow rules are always evaluated and cached, so toggling them re-renders instantly.
  // Slow rules (spatial / turn queries) are evaluated only while enabled.
  const CATS = [['info', 'Missing Info & Naming'], ['geometry', 'Geometry & Direction'], ['topology', 'Topology & Connectivity'],
    ['continuity', 'Type Continuity'], ['restrictions', 'Restrictions & Closures'], ['server', 'Waze Map Problems (reported by drivers)']];
  const RULES = [
    // --- Waze map problems (server side, point located; matched to segments within 25 m)
    { id: 'MP_OPEN', cat: 'server', sev: 'warning', on: true, label: 'Open Waze map problem at this segment',
      test: (s, c) => (c.mp.get(s.id) || []).length > 0 },
    // --- Missing info & naming
    { id: 'NO_NAME', cat: 'info', sev: 'warning', on: true, label: 'No street name',
      test: (s, c) => NAMED_TYPES.has(s.roadType) && s.junctionId == null && !nameOf(s, c) },
    { id: 'NO_CITY', cat: 'info', sev: 'warning', on: true, label: 'No city',
      test: (s, c) => NAMED_TYPES.has(s.roadType) && !!nameOf(s, c) && !cityOk(streetOf(s, c), c) },
    { id: 'LOWERCASE', cat: 'info', sev: 'note', on: true, label: 'Street name starts lowercase',
      test: (s, c) => /^\p{Ll}/u.test(nameOf(s, c)) },
    { id: 'ABBREV', cat: 'info', sev: 'note', on: false, label: 'Abbreviated name (pattern below)',
      test: (s, c) => { const re = abbrevRe(); return !!re && re.test(nameOf(s, c)); } },
    { id: 'EMPTY_ALT', cat: 'info', sev: 'warning', on: true, label: 'Empty alternate street',
      test: (s, c) => (s.alternateStreetIds || []).some(i => { const st = c.streets.get(i); return !st || st.isEmpty || !(st.name || '').trim(); }) },
    { id: 'NO_SPEED', cat: 'info', sev: 'info', on: true, label: 'No speed limit',
      test: s => s.isDrivable && SPEED_TYPES.has(s.roadType) && ((fwdOpen(s) && s.fwdSpeedLimit == null) || (revOpen(s) && s.revSpeedLimit == null)) },
    { id: 'NO_HN', cat: 'info', sev: 'note', on: false, label: 'No house numbers',
      test: s => (s.roadType === 1 || s.roadType === 2) && !s.hasHouseNumbers },
    // --- Geometry & direction
    { id: 'UNKNOWN_DIR', cat: 'geometry', sev: 'error', on: true, label: 'Direction unknown (not routable)',
      test: s => s.isDrivable && !s.allowNoDirection && !s.isTwoWay && !s.isAtoB && !s.isBtoA },
    { id: 'SHORT', cat: 'geometry', sev: 'warning', on: true, label: 'Shorter than 5 m (not a dead end)',
      test: (s, c) => s.isDrivable && s.junctionId == null && s.length < 5 && at(c, s.fromNodeId).length > 1 && at(c, s.toNodeId).length > 1 },
    { id: 'TWOWAY_FWY', cat: 'geometry', sev: 'error', on: true, label: 'Two-way Freeway / Ramp',
      test: s => s.isTwoWay && (s.roadType === 3 || s.roadType === 4) },
    { id: 'ELEV_FWY', cat: 'geometry', sev: 'note', on: true, label: 'Freeway not at ground level',
      test: s => s.roadType === 3 && s.elevationLevel != null && s.elevationLevel !== 0 },
    { id: 'CITY_RAIL_FWY', cat: 'geometry', sev: 'warning', on: true, label: 'City set on Railroad / Freeway',
      test: (s, c) => (s.roadType === 18 || s.roadType === 3) && cityOk(streetOf(s, c), c) },
    { id: 'NAME_ROUNDABOUT', cat: 'geometry', sev: 'warning', on: true, label: 'Street name on roundabout',
      test: (s, c) => s.junctionId != null && !!nameOf(s, c) },
    // --- Topology & connectivity
    { id: 'LOCKED_ABOVE_RANK', cat: 'info', sev: 'note', on: false, label: 'Segment locked above your rank (read-only)',
      test: () => false, // Placeholder, real check is done in evaluate
      async: true },
    { id: 'LOOP', cat: 'topology', sev: 'error', on: true, label: 'Loop: segment closes on itself, or 2 segments share both nodes',
      test: (s, c) => s.fromNodeId != null && s.toNodeId != null &&
        (s.fromNodeId === s.toNodeId || (s.isDrivable && (c.pairs.get(pairKey(s)) || 0) > 1)) },
    { id: 'UNCONNECTED', cat: 'topology', sev: 'error', on: true, label: 'Not connected to any other segment',
      test: (s, c) => s.isDrivable && at(c, s.fromNodeId).length <= 1 && at(c, s.toNodeId).length <= 1 },
    { id: 'SOFT_TURNS', cat: 'topology', sev: 'topology', on: true, label: 'Unverified (soft) turns',
      test: (s, c) => s.isDrivable &&                // only where a turn exists: the far node must have another drivable segment to leave by
        ((fwdOpen(s) && !s.areFwdTurnsVerified && others(c, s, s.toNodeId).some(t => t.isDrivable && leaves(t, s.toNodeId))) ||
         (revOpen(s) && !s.areRevTurnsVerified && others(c, s, s.fromNodeId).some(t => t.isDrivable && leaves(t, s.fromNodeId)))) },
    { id: 'ONEWAY_TRAP', cat: 'topology', sev: 'warning', on: true, label: 'One-way leads nowhere (no exit)',
      test: (s, c) => s.isDrivable && !s.isTwoWay && ((s.isAtoB && !others(c, s, s.toNodeId).some(t => t.isDrivable && leaves(t, s.toNodeId))) ||
        (s.isBtoA && !others(c, s, s.fromNodeId).some(t => t.isDrivable && leaves(t, s.fromNodeId)))) },
    { id: 'ONEWAY_NOENTRY', cat: 'topology', sev: 'warning', on: true, label: 'One-way cannot be entered',
      test: (s, c) => s.isDrivable && !s.isTwoWay && ((s.isAtoB && !others(c, s, s.fromNodeId).some(t => t.isDrivable && arrives(t, s.fromNodeId))) ||
        (s.isBtoA && !others(c, s, s.toNodeId).some(t => t.isDrivable && arrives(t, s.toNodeId)))) },
    { id: 'UNNEEDED_NODE', cat: 'topology', sev: 'topology', on: true, label: 'Unneeded node: 2 identical segments, remove 1 node',
      test: straightNode },
    { id: 'NEAR_MISS', cat: 'topology', sev: 'error', on: false, slow: true, label: 'Loose end close to another road (distance in panel)',
      test: nearMiss },
    { id: 'OVERLAP', cat: 'topology', sev: 'warning', on: false, slow: true, label: 'Overlapping segments (same elevation)',
      test: overlap },
    { id: 'UNVERIFIED_SPEED', cat: 'info', sev: 'warning', on: true, label: 'Unverified speed limit',
      test: s => s.isDrivable && SPEED_TYPES.has(s.roadType) &&
        ((fwdOpen(s) && s.fwdSpeedLimit != null && !s.isFwdSpeedLimitVerified) ||
         (revOpen(s) && s.revSpeedLimit != null && !s.isRevSpeedLimitVerified)) },
    { id: 'UTURN_DEAD_END', cat: 'topology', sev: 'topology', on: false, slow: true, async: true, label: 'U-turn enabled at dead end',
      test: () => false },
    // --- Type continuity (heuristics on road class)
    { id: 'JUMP', cat: 'continuity', sev: 'topology', on: true, label: 'Abrupt jump: Street > Highway > Street',
      test: (s, c) => {
        if (clsOf(s) < 3 || s.roadType === 3) return false;
        const sides = ends(s).map(n => others(c, s, n).filter(t => t.isDrivable && t.roadType !== 4));
        return sides.every(side => side.length > 0 && side.every(t => clsOf(t) > 0 && clsOf(t) <= 2));
      } },
    { id: 'FWY_TO_STREET', cat: 'continuity', sev: 'topology', on: true, label: 'Freeway meets Street without ramp',
      test: (s, c) => s.roadType === 3 && ends(s).some(n => others(c, s, n).some(t => t.roadType === 1 || t.roadType === 2)) },
    { id: 'RBT_TYPE', cat: 'continuity', sev: 'topology', on: true, label: 'Roundabout type lower than connected roads',
      test: (s, c) => {
        if (s.junctionId == null || !clsOf(s) || s.roadType === 3) return false;
        const ent = ends(s).flatMap(n => others(c, s, n)).filter(t => t.isDrivable && t.junctionId !== s.junctionId && clsOf(t) > 0 && t.roadType !== 3);
        return ent.length > 0 && clsOf(s) < Math.max(...ent.map(clsOf));
      } },
    { id: 'RAMP_SAME', cat: 'continuity', sev: 'topology', on: true, label: 'Ramp joins two roads of the same type',
      test: (s, c) => {
        if (s.roadType !== 4 || s.hasSeparator) return false;
        const types = n => new Set(others(c, s, n).filter(t => t.isDrivable && t.roadType !== 4).map(t => t.roadType));
        const [a, b] = ends(s).map(types);
        return a.size === 1 && b.size === 1 && [...a][0] === [...b][0];
      } },
    // --- Restrictions & closures
    { id: 'EXPIRED_RESTR', cat: 'restrictions', sev: 'warning', on: true, label: 'Expired restriction',
      test: s => s.hasRestrictions && (s.restrictions || []).some(r => {
        const e = r && (r.endDate ?? r.endDateTime ?? r.toDate);
        const t = e ? Date.parse(e) : NaN;
        return Number.isFinite(t) && t < Date.now();
      }) },
    { id: 'HAS_RESTR', cat: 'restrictions', sev: 'info', on: false, label: 'Has restrictions',
      test: s => s.hasRestrictions },
    { id: 'HAS_CLOSURE', cat: 'restrictions', sev: 'info', on: false, label: 'Has closures',
      test: s => s.hasClosures },
    { id: 'ACTIVE_CLOSURE', cat: 'restrictions', sev: 'error', on: true, label: 'Segment has an active closure',
      test: s => s.hasClosures && s.isDrivable },
    { id: 'CLOSED_NAME', cat: 'restrictions', sev: 'warning', on: true, label: 'Name contains "(closed)"',
      test: (s, c) => /\(closed\)/i.test(nameOf(s, c)) },
  ];
  const RULE_BY_ID = Object.fromEntries(RULES.map(r => [r.id, r]));
  RULES.forEach(r => { state.rules[r.id] = r.on; });

  // ------------------------------------------------ remembered settings (per browser, localStorage)
  const SETTINGS_KEY = 'wme-segment-validator:settings:v1';
  const POLY_KEY = 'wme-segment-validator:polygons:v1';
  const RESULTS_KEY = 'wme-segment-validator:results:v1';   // swept sections + issues found, kept across reloads
  const PERSIST = ['enabled', 'autoMove', 'highlightOnly', 'autoSave', 'accumulate', 'loadMP', 'limitToViewport', 'abbrevPattern',
    'extraWidth', 'nearMissM', 'layerOpacity', 'filterSev', 'filterRule', 'sortBy', 'hideVisited', 'zoomTo', 'selectOnJump', 'sweepZoom', 'bgEnabled', 'showSections', 'skipDone'];
  let savedAreaKey = 'viewport';
  const kv = {
    get(k) { try { const t = localStorage.getItem(k); return t ? JSON.parse(t) : null; } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { warnOnce('settings-save', e); return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  function loadSettings() {
    const sv = kv.get(SETTINGS_KEY);
    if (sv && typeof sv === 'object') {
      for (const k of PERSIST) if (k in sv && typeof sv[k] === typeof state[k]) state[k] = sv[k];
      if (sv.rules && typeof sv.rules === 'object') for (const id of Object.keys(state.rules)) if (typeof sv.rules[id] === 'boolean') state.rules[id] = sv.rules[id];
      if (sv.collapsed && typeof sv.collapsed === 'object') state.collapsed = sv.collapsed;
      if (sv.open && typeof sv.open === 'object') state.open = sv.open;
      if (typeof sv.areaKey === 'string') savedAreaKey = sv.areaKey;
      if (sv.cap && typeof sv.cap === 'object') { cap.on = !!sv.cap.on; cap.verbose = !!sv.cap.verbose; }
    }
    if (!['all', 'error', 'warning', 'note'].includes(state.filterSev)) state.filterSev = 'all';
    if (state.filterRule !== 'all' && !RULE_BY_ID[state.filterRule]) state.filterRule = 'all';
    if (!['severity', 'distance', 'id'].includes(state.sortBy)) state.sortBy = 'severity';
    state.zoomTo = Math.min(30, Math.max(1, Number(state.zoomTo) || 17));
    state.sweepZoom = Math.min(17, Math.max(12, Number(state.sweepZoom) || 14));
    state.layerOpacity = Math.min(1, Math.max(0.2, Number(state.layerOpacity) || 1));
    state.nearMissM = Math.min(30, Math.max(1, Number(state.nearMissM) || 5));
    state.extraWidth = Math.min(20, Math.max(0, Number(state.extraWidth) || 0));
    const polys = kv.get(POLY_KEY);
    const savedRes = kv.get(RESULTS_KEY);
    if (Array.isArray(polys)) polys.forEach(pl => { try { if (pl && pl.geometry && pl.geometry.coordinates) state.polygons.push(mkArea(pl.geometry, String(pl.name || 'Polygon'))); } catch (e) { /* skip bad entry */ } });
    if (savedRes && typeof savedRes === 'object') {                  // swept marks and issue list from the last session
      const done = new Set(Array.isArray(savedRes.done) ? savedRes.done : []);
      state.polygons.forEach(a => { a.done = done.has(a.name); });
      if (Array.isArray(savedRes.store)) savedRes.store.forEach(e => { if (e && e.id != null && e.geometry && Array.isArray(e.hits) && e.mid) state.store.set(e.id, e); });
      state.restored = { done: done.size, issues: state.store.size, partial: !!savedRes.marksOnly };
    }
  }
  function persistNow() {
    const key = String(state.areaKey);
    const out = { v: 1, rules: state.rules, collapsed: state.collapsed, open: state.open, cap: { on: cap.on, verbose: cap.verbose },
      areaKey: state.areasReady ? (key.startsWith('custom') && !state.polygons.length ? 'viewport' : key) : savedAreaKey };
    for (const k of PERSIST) out[k] = state[k];
    kv.set(SETTINGS_KEY, out);
  }
  let persistTimer = 0;
  const persistSoon = () => { clearTimeout(persistTimer); persistTimer = setTimeout(persistNow, 300); };
  function persistPolygons() {
    const data = state.polygons.map(a => ({ name: a.name, geometry: a.geometry }));
    if (JSON.stringify(data).length > 3e6) return log.warn('imported polygons are too big to remember; import them again next time');
    if (data.length) kv.set(POLY_KEY, data); else kv.del(POLY_KEY);
  }
  function saveResults() {                          // swept sections (imported ones) + the issues found so far
    const done = state.polygons.filter(a => a.done).map(a => a.name);
    let data = { v: 1, done, store: [...state.store.values()].map(e => ({ id: e.id, geometry: e.geometry, mid: e.mid, rt: e.rt, hits: e.hits })) };
    let txt = JSON.stringify(data);
    if (txt.length > 3.5e6) {                       // would not fit in browser storage: keep the marks, drop the issues, and say so
      data = { v: 1, done, store: [], marksOnly: true };
      txt = JSON.stringify(data);
      setStatus('Too many issues to remember after a reload: the swept marks are saved, the issue list is not. Export CSV now.');
      log.warn('results too big for browser storage: saved swept marks only');
    }
    if (!kv.set(RESULTS_KEY, data)) setStatus('Browser storage is full: results are not remembered. Export CSV now.');
  }
  const rememberOpen = (d, key, dflt) => {
    d.open = key in state.open ? !!state.open[key] : dflt;
    d.addEventListener('toggle', () => { state.open[key] = d.open; persistSoon(); });
    return d;
  };
  loadSettings();
  function abbrevRe() { try { return state.abbrevPattern ? new RegExp(state.abbrevPattern) : null; } catch (e) { warnOnce('abbrev-regex', e); return null; } }
  const worst = ids => ids.reduce((a, id) => (RANK[TIER[RULE_BY_ID[id].sev]] > RANK[a] ? TIER[RULE_BY_ID[id].sev] : a), 'note');

  const NAME_RULES = new Set(['NO_NAME', 'NO_CITY', 'LOWERCASE', 'ABBREV', 'EMPTY_ALT', 'NAME_ROUNDABOUT', 'CLOSED_NAME', 'CITY_RAIL_FWY']);
  const NEIGHBOUR_RULE = r => (r.cat === 'topology' && r.id !== 'LOOP') || r.cat === 'continuity';
  function neighboursLoaded(s, c) {                 // every segment on both end nodes is in the data model
    if (!c.nodeApi) return true;
    for (const n of new Set(ends(s))) {
      if (n == null) continue;
      const rec = c.nodeRec.get(n);
      if (!rec) return false;
      if (Array.isArray(rec.connectedSegmentIds) && rec.connectedSegmentIds.some(id => !c.seg.has(id))) return false;
    }
    return true;
  }
  function namesKnown(s, c) {                       // street, alternate streets and cities are all resolved
    const ids = [s.primaryStreetId, ...(s.alternateStreetIds || [])].filter(i => i != null);
    return ids.every(i => { const st = c.streets.get(i); return st && (st.cityId == null || c.cities.has(st.cityId)); });
  }
  async function evaluate(cands, ctx) {
    const rules = RULES.filter(r => !r.async && state.rules[r.id]);      // unticked rules are not evaluated at all
    const out = new Map();
    let skipNb = 0, skipNm = 0;
    for (const s of cands) {
      const hits = [];
      const full = neighboursLoaded(s, ctx), named = namesKnown(s, ctx);
      if (!full) skipNb++;
      if (!named) skipNm++;
      for (const r of rules) {
        if (!full && NEIGHBOUR_RULE(r)) continue;       // would report phantom dead ends / extra nodes while neighbours are still loading
        if (!named && NAME_RULES.has(r.id)) continue;   // street or city record not loaded yet: unknown, not "missing"
        try { if (r.test(s, ctx)) hits.push(r.id); } catch (e) { warnOnce(r.id, e); }
      }
      out.set(s.id, hits);
    }
    state.skip = { nb: skipNb, nm: skipNm };
    if (state.rules.NO_NAME || state.rules.NO_CITY) await addressPass(cands, out);
    if (state.rules.UTURN_DEAD_END) await uturnPass(cands, ctx, out);
    if (state.rules.LOCKED_ABOVE_RANK) await permissionPass(cands, out);
    return out;
  }

  let addrLogged = false;
  async function addressPass(cands, out) {          // WME's own resolved address is the final word on missing name / city
    const todo = cands.filter(s => { const h = out.get(s.id); return h && (h.includes('NO_NAME') || h.includes('NO_CITY')); });
    for (let i = 0; i < todo.length; i += 40) {
      await Promise.all(todo.slice(i, i + 40).map(async s => {
        try {
          const a = await sdk.DataModel.Segments.getAddress({ segmentId: s.id });
          if (!addrLogged) { addrLogged = true; log.info(`getAddress sample: ${fmt(a).slice(0, 600)}`); }
          const nm = a && ((a.street && a.street.name) || a.streetName);
          const ct = a && ((a.city && a.city.name) || a.cityName);
          let hits = out.get(s.id);
          if (nm) hits = hits.filter(x => x !== 'NO_NAME');
          if (ct) hits = hits.filter(x => x !== 'NO_CITY');
          out.set(s.id, hits);
        } catch (e) { warnOnce('getAddress', e); }
      }));
    }
  }
  async function permissionPass(cands, out) {
    for (let i = 0; i < cands.length; i += 50) {
      await Promise.all(cands.slice(i, i + 50).map(async s => {
        try {
          const ok = await sdk.DataModel.Segments.hasPermissions({ segmentId: s.id });
          if (!ok) out.get(s.id).push('LOCKED_ABOVE_RANK');
        } catch (e) { /* ignore */ }
      }));
    }
  }
  async function uturnPass(cands, ctx, out) {       // needs Turns.getTurnsFromSegment (checked in diagnostics)
    const T = sdk.DataModel.Turns;
    if (!T || typeof T.getTurnsFromSegment !== 'function') return warnOnce('uturn', 'Turns.getTurnsFromSegment missing');
    const loose = cands.filter(s => s.isDrivable && neighboursLoaded(s, ctx) && (at(ctx, s.fromNodeId).length === 1 || at(ctx, s.toNodeId).length === 1));
    for (let i = 0; i < loose.length; i += 50) {
      await Promise.all(loose.slice(i, i + 50).map(async s => {
        try {
          const turns = await T.getTurnsFromSegment({ segmentId: s.id });
          const deadFwd = at(ctx, s.toNodeId).length === 1, deadRev = at(ctx, s.fromNodeId).length === 1;
          if (turns.some(t => t.isUTurn && t.isAllowed && t.toSegmentId === s.id && ((t.fromSegmentFwd && deadFwd) || (!t.fromSegmentFwd && deadRev)))) out.get(s.id).push('UTURN_DEAD_END');
        } catch (e) { warnOnce('uturn-call', e); }
      }));
    }
  }
  function commit(cands, out) {
    for (const s of cands) {
      const hits = out.get(s.id) || [];
      if (hits.length) state.store.set(s.id, { id: s.id, geometry: s.geometry, mid: lineMidpoint(s.geometry.coordinates), rt: s.roadType, hits });
      else state.store.delete(s.id);
    }
  }

  // --------------------------------------------------------------- scopes
  const areaCenter = a => ({ lon: (a.bbox[0] + a.bbox[2]) / 2, lat: (a.bbox[1] + a.bbox[3]) / 2 });
  const sameBox = (a, b) => a.bbox.every((v, i) => Math.abs(v - b.bbox[i]) < 1e-5);
  async function loadAreas() {
    state.managedAreas = []; state.driveAreas = [];
    const info = await sdk.State.getUserInfo();
    const shortList = (info && info.managedAreas) || [];
    const editable = (info && info.editableAreas) || [];
    log.info(`user: rank=${info && info.rank} areaManager=${info && info.isAreaManager} countryManager=${info && info.isCountryManager} managedAreas=${shortList.length} editableAreas=${editable.length}`);
    log.info(`editableAreas types: ${[...new Set(editable.map(a => String(a && a.type)))].join(',') || 'none'}`);
    // 1) UserSession.editableAreas: polygons for both managed and drive areas
    for (const a of editable) {
      if (!a || !a.geometry) continue;
      const pool = /drive/i.test(String(a.type)) ? state.driveAreas : state.managedAreas;
      extractPolygons(a.geometry).forEach(g => pool.push(mkArea(g, '')));
    }
    // 2) ManagedAreas model: gives the real names (UserSession only has id + name, no geometry)
    const MA = sdk.DataModel.ManagedAreas;
    const named = [];
    try { const arr = await MA.getAll(); log.info(`ManagedAreas.getAll -> ${arr.length}`); named.push(...arr.map(a => ({ name: a.userName, geometry: a.geometry }))); } catch (e) { warnOnce('managed-getAll', e); }
    for (const m of shortList) {
      try {
        const area = await MA.getById({ managedAreaId: String(m.id) });      // UserSession id is a number, getById wants a string
        if (area && area.geometry) named.push({ name: m.name, geometry: area.geometry });
        else log.warn('managed area not in data model (name only)', m);
      } catch (e) { log.warn('managed area', m, e); }
    }
    for (const n of named) {
      extractPolygons(n.geometry).forEach(g => {
        const a = mkArea(g, n.name || '');
        const hit = state.managedAreas.find(x => sameBox(x, a));
        if (hit) hit.name = hit.name || a.name; else state.managedAreas.push(a);
      });
    }
    const label = (pool, word) => pool.forEach((a, i) => {
      const c = areaCenter(a);
      a.name = a.name ? a.name : `${word} ${i + 1} (${c.lat.toFixed(2)}, ${c.lon.toFixed(2)})`;
    });
    label(state.managedAreas, 'Managed area'); label(state.driveAreas, 'Drive area');
    state.driveSource = 'UserSession.editableAreas';
    log.info(`areas loaded: managed=${state.managedAreas.length} drive=${state.driveAreas.length} (your managed names: ${shortList.map(m => m.name).join(' | ') || 'none'})`);
    buildAreaSelect();
    if (savedAreaKey !== 'viewport' && ui.area && [...ui.area.options].some(o => o.value === savedAreaKey)) {
      log.info(`restoring saved area: ${savedAreaKey}`);
      await chooseArea(savedAreaKey, false);
    }
  }
  function areasForKey(key = state.areaKey) {
    const [g, i] = String(key).split(':');
    const pool = (g === 'managed' ? state.managedAreas : g === 'drive' ? state.driveAreas : g === 'custom' ? state.polygons : []) || [];
    return i === 'all' ? pool : [pool[Number(i)]].filter(Boolean);
  }
  const scopeAreas = async () => areasForKey();
  function buildAreaSelect() {
    const sel = ui.area;
    if (!sel) return;
    sel.textContent = '';
    sel.append(new Option('Viewport (screen only)', 'viewport'));
    const grp = (label, pool, g) => {
      if (!pool || !pool.length) return;
      const og = document.createElement('optgroup');
      og.label = label;
      if (pool.length > 1) og.append(new Option(`All (${pool.length})`, `${g}:all`));
      pool.forEach((a, i) => og.append(new Option(a.name, `${g}:${i}`)));
      sel.append(og);
    };
    grp('Managed areas', state.managedAreas, 'managed');
    grp('Drive areas', state.driveAreas, 'drive');
    grp('Imported / drawn', state.polygons, 'custom');
    if ([...sel.options].some(o => o.value === state.areaKey)) sel.value = state.areaKey;
    else { state.areaKey = 'viewport'; state.scope = 'viewport'; sel.value = 'viewport'; }
  }
  async function chooseArea(key, pan) {
    state.areaKey = key;
    persistSoon();
    state.scope = key === 'viewport' ? 'viewport' : 'area';
    ui.scopeNote.textContent = '';
    if (ui.area.value !== key) ui.area.value = key;
    await drawScopeOutline();
    await refreshView();
    if (pan && state.scope === 'area') {
      await fitAreas(areasForKey(), false);
    }
    run();
  }

  // ---------------------------------------------- area sweep (whole polygon)
  // WME only keeps segments near the screen in memory, so a large area has to be visited tile by tile.
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function settle(maxMs = 10000) {
    await sleep(500);
    const t0 = Date.now();
    for (let k = 0; k < 2; k++) {
      while (Date.now() - t0 < maxMs && await sdk.State.isMapLoading()) await sleep(150);
      await sleep(350);
    }
  }
  function tileTouches(t, a) {
    const cx = (t[0] + t[2]) / 2, cy = (t[1] + t[3]) / 2;
    const pts = [[t[0], t[1]], [t[2], t[1]], [t[0], t[3]], [t[2], t[3]], [cx, cy], [cx, t[1]], [cx, t[3]], [t[0], cy], [t[2], cy]];
    return pts.some(p => polygonContains(p, a.geometry)) ||
      a.geometry.coordinates[0].some(([x, y]) => x >= t[0] && x <= t[2] && y >= t[1] && y <= t[3]);
  }
  function tilesFor(areas, tw, th) {
    const bb = areas.reduce((b, a) => [Math.min(b[0], a.bbox[0]), Math.min(b[1], a.bbox[1]), Math.max(b[2], a.bbox[2]), Math.max(b[3], a.bbox[3])], [180, 90, -180, -90]);
    const tiles = [];
    for (let y = bb[1]; y < bb[3]; y += th * 0.9) {
      for (let x = bb[0]; x < bb[2]; x += tw * 0.9) {
        const t = [x, y, x + tw, y + th];
        if (areas.some(a => bboxHit(t, a.bbox) && tileTouches(t, a))) tiles.push(t);
      }
    }
    return tiles;
  }
  let sweepPrev = null;
  function endSweep() {
    if (sweepPrev) { state.limitToViewport = sweepPrev.lim; state.accumulate = sweepPrev.acc; sweepPrev = null; }
    state.sweeping = false; state.sweepCancel = false; state.sweepPaused = false;
    if (ui.sweepBtn) ui.sweepBtn.textContent = 'Sweep area';
    if (ui.pauseBtn) { ui.pauseBtn.textContent = 'Pause'; ui.pauseBtn.disabled = true; }
  }
  async function toggleSweep() {
    if (state.sweeping) { state.sweepCancel = true; state.sweepPaused = false; return setStatus('Stopping sweep...'); }
    const areas = areasForKey();
    if (state.scope !== 'area' || !areas.length) return setStatus('Pick a managed, drive or imported area first.');
    let groups = areas.length > 1 ? areas.map(a => [a]) : [areas];      // several areas: one section after another, each marked done when finished
    if (state.skipDone) groups = groups.filter(g => !g.every(a => a.done));
    if (!groups.length) return setStatus('Every section here is already swept. Untick "Skip swept sections" to sweep again.');
    const z = Math.min(17, Math.max(12, Number(ui.zoomSweep.value) || 14));
    state.sweeping = true; state.sweepCancel = false;
    sweepPrev = { lim: state.limitToViewport, acc: state.accumulate };
    state.limitToViewport = true; state.accumulate = true;
    ui.sweepBtn.textContent = 'Stop sweep';
    ui.pauseBtn.disabled = false;
    let home = null;                                  // where the map was before the sweep, restored when it ends
    try { home = { c: await sdk.Map.getMapCenter(), z: await sdk.Map.getZoomLevel() }; } catch (e) { /* no restore */ }
    try {
      await sdk.Map.setMapCenter({ lonLat: areaCenter(groups[0][0]), zoomLevel: z });
      await settle();
      const ext = await sdk.Map.getMapExtent();
      const tiles = groups.flatMap((g, gi) => tilesFor(g, ext[2] - ext[0], ext[3] - ext[1]).map(t => Object.assign(t, { g: gi })));
      log.info(`sweep: zoom ${z}, ${tiles.length} tiles`);
      if (tiles.length > 300 && !window.confirm(`This area needs ${tiles.length} screens at zoom ${z} (about ${Math.round(tiles.length * 4 / 60)} min). Continue?`)) return;
      if (!state.skipDone) state.store.clear();
      groups.forEach(g => g.forEach(a => { a.done = false; }));
      const tStart = Date.now();
      let pausedMs = 0;
      const mmss = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
      for (let i = 0; i < tiles.length && !state.sweepCancel; i++) {
        if (state.sweepPaused) {                    // wait here, between screens; resume continues from this same screen
          const p0 = Date.now();
          setStatus(`Sweep paused at ${i + 1}/${tiles.length} \u00B7 ${state.store.size} segments with issues. Press Resume to continue.`);
          while (state.sweepPaused && !state.sweepCancel) await sleep(200);
          pausedMs += Date.now() - p0;
          if (state.sweepCancel) break;
        }
        const t = tiles[i];
        const el = Date.now() - tStart - pausedMs, eta = i ? el / i * (tiles.length - i) : 0;
        if (ui.sweepBar) ui.sweepBar.firstChild.style.width = `${Math.round(i / tiles.length * 100)}%`;
        const secName = groups[t.g].length === 1 ? ` \u00B7 ${groups[t.g][0].name}` : '';
        setStatus(`Sweep ${i + 1}/${tiles.length}${secName} · elapsed ${mmss(el)}${i ? ` · about ${mmss(eta)} left` : ''} · ${state.store.size} segments with issues`);
        await sdk.Map.setMapCenter({ lonLat: { lon: (t[0] + t[2]) / 2, lat: (t[1] + t[3]) / 2 }, zoomLevel: z });
        await settle();
        const segs = await sdk.DataModel.Segments.getAll();
        if (segs.length === 0) log.warn(`Sweep: tile ${i + 1} returned 0 segments. Skipping.`);
        else await scan({ force: true });
        if ((i === tiles.length - 1 || tiles[i + 1].g !== t.g) && !state.sweepCancel) {   // last screen of this section
          groups[t.g].forEach(a => { a.done = true; });
          await drawScopeOutline();
          saveResults();
        }
      }
      const stopped = state.sweepCancel;
      log.info(`sweep ${stopped ? 'stopped' : 'finished'}: ${tiles.length} tiles, stored=${state.store.size}`);
      if (ui.sweepBar && !stopped) ui.sweepBar.firstChild.style.width = '100%';
      await refreshView();
      saveResults();
      setStatus(`Sweep ${stopped ? 'stopped' : 'done'} in ${mmss(Date.now() - tStart - pausedMs)} · ${state.view.length} issues`);
    } finally {
      endSweep();
      if (home) { try { await sdk.Map.setMapCenter({ lonLat: home.c, zoomLevel: home.z }); } catch (e) { log.warn('restore view after sweep', e); } }
    }
  }
  async function withPermission(cands) {
    const keep = [];
    for (let i = 0; i < cands.length; i += 200) {
      const batch = cands.slice(i, i + 200);
      const ok = await Promise.all(batch.map(s =>
        Promise.resolve().then(() => sdk.DataModel.Segments.hasPermissions({ segmentId: s.id })).catch(() => false)));
      batch.forEach((s, k) => { if (ok[k]) keep.push(s); });
    }
    return keep;
  }
  async function selectCandidates(all, extent) {
    const inView = s => bboxHit(segBBox(s), extent);
    if (state.scope === 'viewport') return { cands: all.filter(inView) };
    const areas = areasForKey();
    if (!areas.length) return { cands: [], empty: 'area' };
    const cands = state.limitToViewport ? all.filter(inView) : all;
    return { cands: cands.filter(s => areas.some(a => segInArea(s, a))) };
  }
  async function drawScopeOutline() {              // the selected area(s): thick, on top
    await sdk.Map.removeAllFeaturesFromLayer({ layerName: SCOPE_LAYER });
    const areas = (await scopeAreas()).slice(0, 200);
    if (areas.length) await sdk.Map.addFeaturesToLayer({
      layerName: SCOPE_LAYER,
      features: areas.map((a, i) => ({ type: 'Feature', id: `scope-${i}`, geometry: a.geometry, properties: { color: a.done ? '#2e7d32' : '#3949ab' } })),
    });
    await drawBoundaries();
    await updateHere();
  }
  async function drawBoundaries() {                // every imported / drawn section, with its name, whether selected or not
    try {
      await sdk.Map.removeAllFeaturesFromLayer({ layerName: BORDER_LAYER });
      if (!state.showSections || !state.polygons.length) return;
      await sdk.Map.addFeaturesToLayer({
        layerName: BORDER_LAYER,
        features: state.polygons.slice(0, 500).map((a, i) => ({ type: 'Feature', id: `sec-${i}`, geometry: a.geometry,
          properties: { label: (a.done ? '\u2713 ' : '') + a.name, color: a.done ? '#2e7d32' : '#e65100' } })),
      });
    } catch (e) { warnOnce('borders', e); }
  }
  async function updateHere() {                    // "you are in section X" for the map centre (like Mapraid's top bar)
    if (!ui.here) return;
    if (!state.polygons.length) { ui.here.textContent = ''; return; }
    try {
      const c = await sdk.Map.getMapCenter(), p = [c.lon, c.lat];
      const hit = state.polygons.filter(a => p[0] >= a.bbox[0] && p[0] <= a.bbox[2] && p[1] >= a.bbox[1] && p[1] <= a.bbox[3] && polygonContains(p, a.geometry));
      ui.here.textContent = hit.length ? `Map centre is in: ${hit.map(a => a.name + (a.done ? ' \u2713 swept' : '')).join(', ')}` : 'Map centre is outside the imported sections';
    } catch (e) { /* ignore */ }
  }
  const bboxOfAreas = areas => areas.reduce((b, a) => [Math.min(b[0], a.bbox[0]), Math.min(b[1], a.bbox[1]), Math.max(b[2], a.bbox[2]), Math.max(b[3], a.bbox[3])], [180, 90, -180, -90]);
  async function fitAreas(areas, corner) {         // zoom out so the whole border is on screen (or go to the NW corner so two borders cross the screen)
    if (!areas.length) return setStatus('Pick an area first.');
    const bb = bboxOfAreas(areas);
    try {
      const z0 = await sdk.Map.getZoomLevel();
      if (corner) {
        await sdk.Map.setMapCenter({ lonLat: { lon: bb[0], lat: bb[3] }, zoomLevel: clampZoom(Math.min(z0, 15)) });
        return setStatus('At the top-left corner of the area: its borders cross the screen here.');
      }
      await sdk.Map.setMapCenter({ lonLat: { lon: (bb[0] + bb[2]) / 2, lat: (bb[1] + bb[3]) / 2 }, zoomLevel: z0 });
      await sleep(400);
      const ext = await sdk.Map.getMapExtent();
      const ratio = Math.max((bb[2] - bb[0]) / (ext[2] - ext[0]), (bb[3] - bb[1]) / (ext[3] - ext[1])) * 1.1;
      const nz = clampZoom(z0 - Math.ceil(Math.log2(ratio)));
      await sdk.Map.setMapCenter({ lonLat: { lon: (bb[0] + bb[2]) / 2, lat: (bb[1] + bb[3]) / 2 }, zoomLevel: nz });
      setStatus(`Zoom ${nz}: ${nz <= 12 ? 'this is WME\'s widest view, so a large area may still run past the screen edges. Use "Go to corner".' : 'the whole area border should be on screen.'}`);
    } catch (e) { log.warn('fit area', e); }
  }
  function extractPolygons(g, out = []) {
    if (!g) return out;
    if (Array.isArray(g)) { g.forEach(x => extractPolygons(x, out)); return out; }
    if (g.type === 'FeatureCollection') return extractPolygons(g.features, out);
    if (g.type === 'Feature') return extractPolygons(g.geometry, out);
    if (g.type === 'GeometryCollection') return extractPolygons(g.geometries, out);
    if (g.type === 'Polygon') out.push({ type: 'Polygon', coordinates: g.coordinates });
    if (g.type === 'MultiPolygon') g.coordinates.forEach(c => out.push({ type: 'Polygon', coordinates: c }));
    return out;
  }
  function extractNamed(g, out = []) {          // like extractPolygons, but keeps each feature's name / id property
    if (!g) return out;
    if (Array.isArray(g)) { g.forEach(x => extractNamed(x, out)); return out; }
    if (g.type === 'FeatureCollection') return extractNamed(g.features, out);
    if (g.type === 'Feature') {
      const p = g.properties || {};
      const nm = ['name', 'Name', 'NAME', 'id', 'ID', 'Id', 'label', 'title'].map(k => p[k]).find(v => v != null && String(v).trim() !== '');
      const parts = extractPolygons(g.geometry);
      parts.forEach((geo, i) => out.push({ geometry: geo, name: nm != null ? String(nm) + (parts.length > 1 ? ` #${i + 1}` : '') : '' }));
      return out;
    }
    extractPolygons(g).forEach(geo => out.push({ geometry: geo, name: '' }));
    return out;
  }
  function parseWkt(txt) {                 // POLYGON / MULTIPOLYGON anywhere in the text (plain .wkt, or a CSV column)
    const polys = [];
    const re = /(MULTIPOLYGON|POLYGON)\s*(?:ZM|Z|M)?\s*(?=\()/gi;
    let m;
    while ((m = re.exec(txt))) {
      let i = re.lastIndex;
      const parse = () => {
        i++;
        const items = []; let buf = '';
        const flush = () => { const t = buf.trim(); if (t) { const n = t.split(/\s+/).map(Number); if (n.length >= 2 && n.every(Number.isFinite)) items.push([n[0], n[1]]); } buf = ''; };
        while (i < txt.length) {
          const c = txt[i];
          if (c === '(') items.push(parse());
          else if (c === ')') { flush(); i++; return items; }
          else if (c === ',') { flush(); i++; }
          else { buf += c; i++; }
        }
        return items;
      };
      const tree = parse();
      re.lastIndex = i;
      if (/^MULTI/i.test(m[1])) tree.forEach(rings => { if (rings.length) polys.push({ type: 'Polygon', coordinates: rings }); });
      else if (tree.length) polys.push({ type: 'Polygon', coordinates: tree });
    }
    return polys;
  }
  async function importFile(file) {
    let polys;
    if (/\.(wkt|txt|csv)$/i.test(file.name)) polys = parseWkt(await file.text()).map(geometry => ({ geometry, name: '' }));
    else {
      const buf = await file.arrayBuffer();
      let gj;
      if (/\.zip$/i.test(file.name)) {
        const shp = typeof window.shp === 'function' ? window.shp : window.shp && window.shp.default;
        if (!shp) throw new Error('shpjs is not loaded (check the @require line / network)');
        gj = await shp(buf);
      } else gj = JSON.parse(new TextDecoder().decode(buf));
      polys = extractNamed(gj);
    }
    if (!polys.length) throw new Error('no Polygon / MultiPolygon geometry found');
    const [x, y] = polys[0].geometry.coordinates[0][0];
    if (Math.abs(x) > 180 || Math.abs(y) > 90) throw new Error('coordinates are not WGS84 lon/lat (shapefile without a .prj?)');
    const base = file.name.replace(/\.[^.]+$/, '');
    if (polys.every(it => it.name)) polys.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    polys.forEach((it, i) => state.polygons.push(mkArea(it.geometry, it.name || (polys.length > 1 ? `${base} #${i + 1}` : base))));
    log.info(`imported ${polys.length} polygon(s) from ${file.name}`);
  }

  // ----------------------------------------------------------------- scan
  let token = 0, retries = 0, retryTimer;
  const MAX_RETRIES = 12;
  async function scan({ force = false } = {}) {
    const mine = ++token;
    const t0 = performance.now();
    if (!state.enabled) { await sdk.Map.removeAllFeaturesFromLayer({ layerName: LAYER }); return setStatus('Validator off'); }
    if (!force && await sdk.State.isMapLoading()) {
      log.info(`scan deferred: map still loading (retry ${retries + 1}/${MAX_RETRIES})`);
      setStatus('Waiting for map data...');
      clearTimeout(retryTimer);
      if (retries++ < MAX_RETRIES) retryTimer = setTimeout(() => { if (state.autoMove) scan().catch(onScanError); }, 700);
      return;
    }
    retries = 0;
    ui.scanBtn.disabled = true;
    setStatus('Scanning...');
    try {
      const [all, extent, center] = await Promise.all([sdk.DataModel.Segments.getAll(), sdk.Map.getMapExtent(), sdk.Map.getMapCenter()]);
      if (mine !== token) return;
      state.center = center;
      if (!all.length) { log.info('scan: no segments loaded'); return setStatus('No segments loaded at this zoom. Zoom in or pan.'); }
      const ctx = await buildContext(all);
      if (mine !== token) return;
      const sel = await selectCandidates(all, extent);
      if (mine !== token) return;
      ui.scopeNote.textContent = sel.note || '';
      if (sel.empty) return setStatus('That area is not available. Pick another, or import a polygon.');
      if (!state.accumulate) state.store.clear();
      if (!RULES.some(r => state.rules[r.id])) { state.store.clear(); await refreshView(); return setStatus('No rules ticked.'); }
      const out = await evaluate(sel.cands, ctx);
      if (mine !== token) return;
      commit(sel.cands, out);
      await refreshView();
      setStatus(`Scanned ${sel.cands.length} \u00B7 ${state.view.length} issues`);
      log.info(`scan scope=${state.scope} limitViewport=${state.limitToViewport} loaded=${all.length} scanned=${sel.cands.length} shown=${state.view.length} rules=${RULES.filter(r => state.rules[r.id]).length}/${RULES.length} ${Math.round(performance.now() - t0)}ms skipped(neighbours=${state.skip ? state.skip.nb : 0},names=${state.skip ? state.skip.nm : 0}) top=${topRules()}`);
    } finally {
      if (mine === token) ui.scanBtn.disabled = false;
    }
  }

  function topRules(n = 6) {
    const c = {};
    state.view.forEach(e => e.vis.forEach(id => { c[id] = (c[id] || 0) + 1; }));
    return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}:${v}`).join(',') || 'none';
  }
  // ---------------------------------------------------- save-triggered scan
  const pending = new Set();
  let editShapeLogged = false;
  function collectEdited(payload) {
    if (!editShapeLogged) { editShapeLogged = true; log.info(`wme-after-edit payload sample: ${fmt(payload).slice(0, 400)}`); }
    const list = (payload && (payload.affectedObjects || (payload.detail && payload.detail.affectedObjects))) || [];
    for (const o of list) {
      const type = String((o && (o.objectType ?? o.type)) ?? '').toLowerCase();
      if (type && !type.includes('segment')) continue;
      [].concat(o.objectIds ?? o.ids ?? o.objectId ?? o.id ?? []).forEach(i => { if (Number.isFinite(Number(i))) pending.add(Number(i)); });
    }
  }
  async function onSaveFinished(payload) {
    if (!state.autoSave || !state.enabled) return;
    if (payload && payload.success === false) return log.info('save failed: keeping pending ids');
    const ids = [...pending];
    pending.clear();
    if (!ids.length) return log.info('save finished: no edited segments recorded');
    setStatus(`Validating ${ids.length} saved segment(s)...`);
    try {
      const all = await sdk.DataModel.Segments.getAll();
      const ctx = await buildContext(all);
      const targets = new Map();
      let missing = 0;
      for (const id of ids) {
        const s = ctx.seg.get(id);
        if (!s) { state.store.delete(id); missing++; continue; }
        targets.set(id, s);
        ends(s).forEach(n => at(ctx, n).forEach(t => targets.set(t.id, t)));   // neighbours: connectivity may have changed
      }
      const cands = [...targets.values()];
      commit(cands, await evaluate(cands, ctx));
      await refreshView();
      setStatus(`Save check: ${cands.length} segments re-validated \u00B7 ${state.view.length} issues`);
      log.info(`save check ids=${ids.length} revalidated=${cands.length} missing=${missing}`);
      if (missing && state.autoMove) run();         // new segments get new ids after a save: fall back to a normal scan
    } catch (e) { log.error('save check failed', e); }
  }

  // ------------------------------------------------------------ list view
  function visibleEntries() {
    let a = [];
    for (const e of state.store.values()) {
      const vis = e.hits.filter(id => state.rules[id]);
      if (vis.length) a.push({ ...e, vis, sev: worst(vis) });
    }
    if (state.scope === 'area') {                    // the list and map show only the selected area (managed, drive or imported)
      const areas = areasForKey();
      const inside = (m, ar) => m[0] >= ar.bbox[0] && m[0] <= ar.bbox[2] && m[1] >= ar.bbox[1] && m[1] <= ar.bbox[3] && polygonContains(m, ar.geometry);
      a = a.filter(e => areas.some(ar => inside(e.mid, ar)));
    }
    if (state.filterSev !== 'all') a = a.filter(e => e.sev === state.filterSev);
    if (state.filterRule !== 'all') a = a.filter(e => e.vis.includes(state.filterRule));
    if (state.hideVisited) a = a.filter(e => !state.visited.has(e.id));
    if (state.sortBy === 'distance' && state.center) {
      a.forEach(e => { e.dist = distM(state.center, e.mid); });
      a.sort((x, y) => x.dist - y.dist);
    } else if (state.sortBy === 'id') a.sort((x, y) => x.id - y.id);
    else a.sort((x, y) => RANK[y.sev] - RANK[x.sev] || x.id - y.id);
    return a;
  }
  async function refreshView() {
    state.view = visibleEntries();
    await sdk.Map.removeAllFeaturesFromLayer({ layerName: LAYER });
    const features = state.view.slice(0, MAX_DRAWN).sort((a, b) => RANK[a.sev] - RANK[b.sev]).map(e => ({   // worst last = drawn on top
      type: 'Feature', id: e.id, geometry: e.geometry,
      properties: { sev: e.sev, rt: e.rt, tip: `${SEV_NAME[e.sev]} #${e.id}: ${e.vis.map(id => RULE_BY_ID[id].label).join('; ')}` } }));
    if (features.length) await sdk.Map.addFeaturesToLayer({ layerName: LAYER, features });
    renderList();
    paintListWindowSoon();
  }
  function renderList() {
    const keepScroll = ui.list.scrollTop;            // rebuilding the list must not move it
    const v = state.view;
    const idx = v.findIndex(e => e.id === state.currentId);
    const n = sev => v.filter(e => e.sev === sev).length;
    ui.pos.textContent = `${idx >= 0 ? idx + 1 : '-'} / ${v.length}  · ${n('error')} errors · ${n('warning')} warnings · ${n('note')} notes (stored ${state.store.size})`;
    ui.list.textContent = '';
    let shown = 0;
    for (const sev of ['error', 'warning', 'note']) {
      const grp = v.filter(e => e.sev === sev);
      if (!grp.length) continue;
      const collapsed = !!state.collapsed[sev];
      const head = document.createElement('div');
      head.style.cssText = `position:sticky;top:0;z-index:1;background:${PALETTE[sev]};color:#fff;font-weight:bold;padding:3px 6px;cursor:pointer;`;
      head.textContent = `${collapsed ? '▶' : '▼'} ${SEV_NAME[sev]} (${grp.length})`;
      head.onclick = () => { state.collapsed[sev] = !collapsed; persistSoon(); renderList(); };
      ui.list.append(head);
      if (collapsed) continue;
      const counts = new Map();
      grp.forEach(e => e.vis.forEach(id => { if (TIER[RULE_BY_ID[id].sev] === sev) counts.set(id, (counts.get(id) || 0) + 1); }));
      const chips = h('div', { style: 'padding:3px 4px;background:#fafafa;border-bottom:1px solid #eee' });
      [...counts].sort((a, b) => b[1] - a[1]).forEach(([id, c]) => {
        const chip = h('span', { textContent: `${RULE_BY_ID[id].label} ×${c}`, title: 'Click to filter by this rule',
          style: `display:inline-block;margin:1px 3px 1px 0;padding:0 6px;border:1px solid ${PALETTE[sev]};border-radius:9px;cursor:pointer;font-size:11px;` + (state.filterRule === id ? `background:${PALETTE[sev]};color:#fff;` : '') });
        chip.onclick = () => { state.filterRule = state.filterRule === id ? 'all' : id; if (ui.ruleSel) ui.ruleSel.value = state.filterRule; state.listLimit = PAGE; persistSoon(); refreshView(); };
        chips.append(chip);
      });
      ui.list.append(chips);
      for (const e of grp) {
        if (shown >= state.listLimit) break;
        shown++;
        const row = document.createElement('div');
        row.dataset.id = e.id;
        const labels = e.vis.map(id => RULE_BY_ID[id].label);
        row.title = labels.join('\n');
        row.style.cssText = `padding:3px 4px;border-left:6px solid ${PALETTE[sev]};border-bottom:1px solid #eee;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;` +
          (state.visited.has(e.id) ? 'opacity:.55;' : '') + (e.id === state.currentId ? 'background:#e3f2fd;' : '');
        row.textContent = `#${e.id}  ${labels.join(' · ')}` + (state.sortBy === 'distance' && e.dist != null ? `  · ${fmtDist(e.dist)}` : '');
        row.onclick = () => goTo(e);
        ui.list.append(row);
      }
    }
    if (v.length > shown && !Object.values(state.collapsed).every(Boolean)) {
      const more = h('button', { textContent: `Show more (${v.length - shown} left)` });
      more.onclick = () => { state.listLimit += PAGE; renderList(); };
      ui.list.append(more);
    }
    ui.list.scrollTop = keepScroll;
    if (state.revealCurrent) {                       // only after Prev/Next, and only inside the list (never scroll the sidebar)
      state.revealCurrent = false;
      const cur = ui.list.querySelector(`[data-id="${state.currentId}"]`);
      if (cur) {
        const top = cur.offsetTop, bot = top + cur.offsetHeight;
        if (top < ui.list.scrollTop) ui.list.scrollTop = top;
        else if (bot > ui.list.scrollTop + ui.list.clientHeight) ui.list.scrollTop = bot - ui.list.clientHeight;
      }
    }
  }
  const clampZoom = z => {
    const lo = typeof sdk.Map.MIN_ZOOM_LEVEL === 'number' ? sdk.Map.MIN_ZOOM_LEVEL : z;
    const hi = typeof sdk.Map.MAX_ZOOM_LEVEL === 'number' ? sdk.Map.MAX_ZOOM_LEVEL : z;
    return Math.min(Math.max(z, lo), hi);
  };
  async function waitMapIdle(maxMs = 5000) {
    await new Promise(r => setTimeout(r, 250));
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs && await sdk.State.isMapLoading()) await new Promise(r => setTimeout(r, 150));
  }
  async function goTo(e) {
    state.currentId = e.id;
    state.visited.add(e.id);
    if (!state.highlightOnly) {
      try {
        const cur = await sdk.Map.getZoomLevel();
        await sdk.Map.setMapCenter({ lonLat: { lon: e.mid[0], lat: e.mid[1] }, zoomLevel: clampZoom(Math.max(cur, state.zoomTo)) });
      } catch (err) { log.warn('setMapCenter failed', err); }
    }
    try {
      await sdk.Map.removeAllFeaturesFromLayer({ layerName: HALO_LAYER });
      await sdk.Map.addFeatureToLayer({ layerName: HALO_LAYER, feature: { type: 'Feature', id: `cur-${e.id}`, geometry: e.geometry, properties: { rt: e.rt } } });
    } catch (err) { log.warn('halo failed', err); }
    if (state.selectOnJump) {
      await waitMapIdle();
      try { await sdk.Editing.setSelection({ selection: { ids: [e.id], objectType: 'segment' } }); }
      catch (err) { log.info('selection not applied', err && err.message); }
    }
    log.info(`go to #${e.id} ${e.vis.join(',')}`);
    await refreshView();
  }
  function step(dir) {
    const v = state.view;
    if (!v.length) return;
    let i = v.findIndex(e => e.id === state.currentId);
    i = i === -1 ? (dir > 0 ? 0 : v.length - 1) : (i + dir + v.length) % v.length;
    state.revealCurrent = true;
    return goTo(v[i]);
  }
  async function clearHighlights() {
    state.store.clear(); state.visited.clear(); state.currentId = null;
    await sdk.Map.removeAllFeaturesFromLayer({ layerName: HALO_LAYER });
    await refreshView();
    saveResults();
    setStatus('Highlights cleared');
  }

  // ------------------------------------- OPTIONAL, UNOFFICIAL: background map problems
  // The SDK only returns map problems that WME has already loaded for the screen. This optional scan instead asks the same
  // WME feature service WME itself uses (read-only GET, your own session) for each box of the chosen area, so the map never
  // has to move. It is undocumented and can break after any WME update; the SDK sweep above stays the supported route.
  const MP_LAYER = 'segment-validator-mp';
  const MP_TYPES = { 1: 'Crooked segment', 17: 'Segment without details', 50: 'Parking lot as point', 101: 'Driving direction mismatch',
    102: 'Missing junction', 103: 'Missing road', 104: 'Cross roads junction missing', 105: 'Road type mismatch',
    106: 'Restricted turn might be allowed', 200: 'Turn problem', 300: 'Road closure' };
  const bg = { path: null, running: false, cancel: false, points: new Map(), errors: 0, requests: 0 };
  const mpName = o => MP_TYPES[o.subType] || (o.type === 'turnProblem' ? 'Turn problem' : `Problem type ${o.subType ?? o.type ?? '?'}`);
  function featuresPathFromPerf() {                 // WME has already called its own service: reuse that exact path (it differs per region)
    try {
      for (const e of performance.getEntriesByType('resource').reverse()) {
        const m = /^https?:\/\/[^/]+(\/[^?#]*\/app\/Features)(?:[?#]|$)/i.exec(e.name);
        if (m) return m[1];
      }
    } catch (e) { /* ignore */ }
    return null;
  }
  async function bgFetch(path, bbox) {
    const url = `${location.origin}${path}?language=en&problemFilter=3%2C3&mapComments=false&bbox=${bbox.map(v => v.toFixed(6)).join('%2C')}`;
    bg.requests++;
    const r = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  async function resolveFeaturesPath() {
    if (bg.path) return bg.path;
    const cands = [...new Set([featuresPathFromPerf(), '/Descartes/app/Features', '/row-Descartes/app/Features', '/il-Descartes/app/Features'].filter(Boolean))];
    for (const c of cands) {
      try {
        const j = await bgFetch(c, [0, 0, 0.001, 0.001]);
        if (j && typeof j === 'object') { bg.path = c; log.info(`map problem service found: ${c}`); return c; }
      } catch (e) { log.info(`map problem service ${c} not usable: ${e.message}`); }
    }
    throw new Error('WME feature service not found');
  }
  async function renderMp() {
    const pts = [...bg.points.values()];
    try {
      await sdk.Map.removeAllFeaturesFromLayer({ layerName: MP_LAYER });
      if (pts.length) await sdk.Map.addFeaturesToLayer({ layerName: MP_LAYER, features: pts.slice(0, 3000).map(o => ({
        type: 'Feature', id: `mp-${o.id}`, geometry: { type: 'Point', coordinates: [o.lon, o.lat] }, properties: { tip: `${mpName(o)} (#${o.id})` } })) });
    } catch (e) { warnOnce('mp-draw', e); }
    if (!ui.mpList) return;
    ui.mpList.textContent = '';
    const counts = {};
    pts.forEach(o => { const n = mpName(o); counts[n] = (counts[n] || 0) + 1; });
    ui.mpList.append(h('div', { style: 'padding:3px 4px;background:#fafafa;border-bottom:1px solid #eee;font-size:11px', textContent:
      `${pts.length} open map problems` + (pts.length ? ': ' + Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ×${v}`).join(', ') : '') }));
    pts.sort((a, b) => String(mpName(a)).localeCompare(mpName(b)) || a.id - b.id).slice(0, 500).forEach(o => {
      const row = h('div', { textContent: `#${o.id}  ${mpName(o)}`, title: 'Click to go there',
        style: 'padding:3px 4px;border-left:6px solid #d81b60;border-bottom:1px solid #eee;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis' });
      row.onclick = async () => {
        if (state.highlightOnly) return;
        try {
          const cur = await sdk.Map.getZoomLevel();
          await sdk.Map.setMapCenter({ lonLat: { lon: o.lon, lat: o.lat }, zoomLevel: clampZoom(Math.max(cur, state.zoomTo)) });
        } catch (e) { log.warn('go to map problem', e); }
      };
      ui.mpList.append(row);
    });
  }
  async function bgScan() {
    if (bg.running) { bg.cancel = true; setBg('Stopping...'); return; }
    let areas = state.scope === 'area' ? areasForKey() : [];
    if (!areas.length) {                            // no area chosen: use what is on screen
      const e = await sdk.Map.getMapExtent();
      areas = [mkArea({ type: 'Polygon', coordinates: [[[e[0], e[1]], [e[2], e[1]], [e[2], e[3]], [e[0], e[3]], [e[0], e[1]]]] }, 'Screen')];
    }
    bg.running = true; bg.cancel = false; bg.errors = 0; bg.requests = 0; bg.points.clear();
    ui.bgBtn.textContent = 'Stop';
    const t0 = Date.now();
    const mmss = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
    try {
      const path = await resolveFeaturesPath();
      const CELL = 0.05, queue = [];
      const bb = areas.reduce((b, a) => [Math.min(b[0], a.bbox[0]), Math.min(b[1], a.bbox[1]), Math.max(b[2], a.bbox[2]), Math.max(b[3], a.bbox[3])], [180, 90, -180, -90]);
      for (let y = bb[1]; y < bb[3]; y += CELL) for (let x = bb[0]; x < bb[2]; x += CELL) {
        const t = [x, y, x + CELL, y + CELL];
        if (areas.some(a => bboxHit(t, a.bbox) && tileTouches(t, a))) queue.push({ t, d: 0 });
      }
      let total = queue.length, done = 0;
      log.info(`background map problem scan: ${total} boxes`);
      if (total > 400 && !window.confirm(`This area needs about ${total} requests. Continue?`)) return;
      const worker = async () => {
        while (queue.length && !bg.cancel) {
          const { t, d } = queue.shift();
          try {
            const j = await bgFetch(path, t);
            const objs = (j && j.problems && j.problems.objects) || [];
            if (objs.length >= 500 && d < 4) {      // the service caps a reply at 500: split the box and ask again
              const mx = (t[0] + t[2]) / 2, my = (t[1] + t[3]) / 2;
              queue.unshift({ t: [t[0], t[1], mx, my], d: d + 1 }, { t: [mx, t[1], t[2], my], d: d + 1 },
                { t: [t[0], my, mx, t[3]], d: d + 1 }, { t: [mx, my, t[2], t[3]], d: d + 1 });
              total += 4;
            } else {
              if (objs.length >= 500) log.warn('map problem box still full at the smallest size: some may be missing');
              for (const o of objs) {
                const c = o && o.geometry && o.geometry.coordinates;
                if (!c || o.open === false) continue;
                if (areas.some(a => polygonContains(c, a.geometry))) bg.points.set(o.id, { id: o.id, lon: c[0], lat: c[1], subType: o.subType, type: o.type });
              }
            }
          } catch (e) {
            if (++bg.errors >= 5) { bg.cancel = true; bg.failed = e.message; }
            log.warn(`map problem request failed (${e.message})`);
          }
          done++;
          const el = Date.now() - t0;
          ui.bgBar.firstChild.style.width = `${Math.min(100, Math.round(done / total * 100))}%`;
          setBg(`${done}/${total} boxes · elapsed ${mmss(el)} · about ${mmss(el / done * Math.max(0, total - done))} left · ${bg.points.size} open problems`);
          await sleep(150);
        }
      };
      await Promise.all([worker(), worker()]);
      await renderMp();
      const msg = bg.failed ? `Stopped: the service failed (${bg.failed}). Use "Sweep area" instead.` : `${bg.cancel ? 'Stopped' : 'Done'} in ${mmss(Date.now() - t0)} · ${bg.points.size} open problems · ${bg.requests} requests`;
      setBg(msg);
      log.info(`background map problem scan: ${msg}`);
      if (!bg.cancel) ui.bgBar.firstChild.style.width = '100%';
    } catch (e) {
      log.error('background map problem scan failed', e);
      setBg(`Failed: ${e.message}. Use "Sweep area" (official SDK) instead.`);
    } finally { bg.running = false; bg.cancel = false; bg.failed = null; ui.bgBtn.textContent = 'Scan map problems'; }
  }
  const setBg = t => { if (ui.bgStatus) ui.bgStatus.textContent = t; };

  // -------------------------------------------- export CSV and separate list window
  const roadTypeName = id => (state.roadTypeNames && state.roadTypeNames.get(id)) || String(id);
  function permalinkFor(lon, lat, segId) {
    const u = new URL(location.href), q = u.searchParams;
    q.set('lon', Number(lon).toFixed(6)); q.set('lat', Number(lat).toFixed(6)); q.set('zoomLevel', '19');
    if (segId != null) q.set('segments', String(segId)); else q.delete('segments');
    return `${u.origin}${u.pathname}?${q.toString()}`;
  }
  const exportRows = () => [
    ...state.view.map(e => ({ e, segment_id: e.id, severity: SEV_NAME[e.sev].replace(/s$/, ''), rule_ids: e.vis.join(' '),
      issues: e.vis.map(id => RULE_BY_ID[id].label).join('; '), road_type: roadTypeName(e.rt),
      lon: e.mid[0].toFixed(6), lat: e.mid[1].toFixed(6), link: permalinkFor(e.mid[0], e.mid[1], e.id) })),
    ...[...bg.points.values()].map(o => ({ e: null, segment_id: '', severity: 'Map problem', rule_ids: 'MAP_PROBLEM', issues: `${mpName(o)} (#${o.id})`,
      road_type: '', lon: o.lon.toFixed(6), lat: o.lat.toFixed(6), link: permalinkFor(o.lon, o.lat, null) })),
  ];
  const CSV_COLS = ['segment_id', 'severity', 'rule_ids', 'issues', 'road_type', 'lon', 'lat', 'link'];
  function toCsv(rows) {
    const esc = v => { const t = String(v ?? ''); return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    return '﻿' + [CSV_COLS.join(','), ...rows.map(r => CSV_COLS.map(c => esc(r[c])).join(','))].join('\r\n');   // BOM so Excel reads UTF-8
  }
  function exportCsv() {
    const rows = exportRows();
    if (!rows.length) return setStatus('Nothing to export.');
    const d = new Date(), p2 = n => String(n).padStart(2, '0');
    const name = `segment-validator-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.csv`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }));
    a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    setStatus(`Exported ${rows.length} rows to ${name}`);
    log.info(`exported ${rows.length} rows to CSV (current filters applied)`);
  }
  let listWin = null, lwTimer = 0, lwFilter = '', lwSort = { key: 'severity', dir: 1 };
  const paintListWindowSoon = () => { if (!listWin || listWin.closed) return; clearTimeout(lwTimer); lwTimer = setTimeout(() => paintListWindow(), 800); };
  function openListWindow() {
    if (listWin && !listWin.closed) { listWin.focus(); return paintListWindow(true); }
    listWin = window.open('', 'wmesv-list', 'width=1100,height=760');
    if (!listWin) return setStatus('The browser blocked the pop-up. Allow pop-ups for this site, then press the button again.');
    paintListWindow(true);
  }
  function paintListWindow(rebuild) {
    const w = listWin;
    if (!w || w.closed) return;
    const d = w.document;
    const mk = (tag, props = {}, ...kids) => { const el = d.createElement(tag); Object.assign(el, props); el.append(...kids); return el; };
    if (rebuild || !d.getElementById('wmesv-root')) {
      d.title = 'Segment Validator list';
      d.head.textContent = ''; d.body.textContent = '';
      d.head.append(mk('style', { textContent: 'body{font:13px system-ui,sans-serif;margin:0}#bar{position:sticky;top:0;z-index:2;background:#fff;padding:8px;border-bottom:1px solid #ddd;display:flex;gap:8px;align-items:center;flex-wrap:wrap}table{border-collapse:collapse;width:100%}th{position:sticky;top:46px;background:#f3f3f3;cursor:pointer;text-align:left;padding:4px 8px;border-bottom:1px solid #ccc;user-select:none}td{padding:3px 8px;border-bottom:1px solid #eee}tr.r{cursor:pointer}tr.r:hover{background:#eef6ff}.sev{display:inline-block;font-weight:bold;color:#fff;border-radius:3px;padding:1px 6px}' }));
      const inp = mk('input', { placeholder: 'Filter text...', value: lwFilter });
      inp.style.width = '220px';
      inp.oninput = () => { lwFilter = inp.value.toLowerCase(); paintListWindow(); };
      const heads = [['severity', 'Severity'], ['segment_id', 'Segment'], ['issues', 'Issues'], ['road_type', 'Road type'], ['lon', 'Lon, lat']];
      const tr = mk('tr');
      heads.forEach(([k, t]) => { const th = mk('th', { textContent: t }); th.onclick = () => { lwSort = { key: k, dir: lwSort.key === k ? -lwSort.dir : 1 }; paintListWindow(); }; tr.append(th); });
      d.body.append(mk('div', { id: 'wmesv-root' },
        mk('div', { id: 'bar' }, mk('b', { id: 'wmesv-count' }), inp,
          mk('button', { textContent: 'Refresh', onclick: () => paintListWindow() }),
          mk('button', { textContent: 'Export CSV', onclick: exportCsv }),
          mk('span', { textContent: 'Click a row to jump to it in the editor. Updates after each scan.', style: 'color:#777' })),
        mk('table', {}, mk('thead', {}, tr), mk('tbody', { id: 'wmesv-body' }))));
    }
    const sevRank = r => (r.severity === 'Map problem' ? 0 : RANK[Object.keys(SEV_NAME).find(k => SEV_NAME[k].startsWith(r.severity))] || 0);
    let rows = exportRows().filter(r => !lwFilter || `${r.segment_id} ${r.severity} ${r.issues} ${r.road_type}`.toLowerCase().includes(lwFilter));
    const { key, dir } = lwSort;
    rows.sort((a, b) => dir * (key === 'severity' ? sevRank(b) - sevRank(a) || (a.segment_id || 0) - (b.segment_id || 0)
      : key === 'segment_id' || key === 'lon' ? Number(a[key] || 0) - Number(b[key] || 0) : String(a[key]).localeCompare(String(b[key]))));
    const total = rows.length;
    rows = rows.slice(0, 4000);
    d.getElementById('wmesv-count').textContent = `${total} items${total > rows.length ? ` (showing ${rows.length})` : ''}`;
    const body = d.getElementById('wmesv-body');
    body.textContent = '';
    const frag = d.createDocumentFragment();
    for (const r of rows) {
      const sevKey = Object.keys(SEV_NAME).find(k => SEV_NAME[k].startsWith(r.severity));
      const tr = mk('tr', { className: r.e ? 'r' : '' },
        mk('td', {}, mk('span', { className: 'sev', textContent: r.severity, style: `background:${sevKey ? PALETTE[sevKey] : '#d81b60'}` })),
        mk('td', { textContent: r.segment_id }), mk('td', { textContent: r.issues }), mk('td', { textContent: r.road_type }),
        mk('td', { textContent: `${r.lon}, ${r.lat}` }));
      if (r.e) tr.onclick = () => goTo(r.e);
      frag.append(tr);
    }
    body.append(frag);
  }

  // ------------------------------------------------------------------- UI
  const setStatus = t => { if (ui.status) ui.status.textContent = t; };
  function h(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    Object.assign(e, props);
    e.append(...kids);
    return e;
  }
  const mkSelect = (opts, value, onchange) => {
    const sel = h('select');
    opts.forEach(([v, t]) => sel.append(new Option(t, v)));
    sel.value = value;
    sel.onchange = () => onchange(sel.value);
    return sel;
  };
  const mkRuleSelect = (value, onchange) => {       // grouped by category, readable labels, worst tier first
    const sel = h('select', { style: 'max-width:100%' });
    sel.append(new Option('All rules', 'all'));
    for (const [cat, title] of CATS) {
      const rules = RULES.filter(r => r.cat === cat);
      if (!rules.length) continue;
      const og = document.createElement('optgroup');
      og.label = title;
      rules.slice().sort((a, b) => RANK[TIER[b.sev]] - RANK[TIER[a.sev]])
        .forEach(r => og.append(new Option(`${{ error: '\u25CF', warning: '\u25D0', note: '\u25CB' }[TIER[r.sev]]} ${r.label}`, r.id)));
      sel.append(og);
    }
    sel.value = [...sel.options].some(o => o.value === value) ? value : 'all';
    sel.onchange = () => onchange(sel.value);
    return sel;
  };
  const mkCheck = (label, checked, onchange) => {
    const cb = h('input', { type: 'checkbox', checked });
    cb.onchange = () => onchange(cb.checked);
    return h('label', { style: 'display:block;font-size:12px' }, cb, ' ', label);
  };
  const mkBtn = (label, onclick, props = {}) => h('button', { textContent: label, onclick, ...props });
  const mkCopyBtn = (label, getText) => {
    const b = h('button', { textContent: label });
    b.onclick = async () => {
      const ok = await copyText(await getText());
      b.textContent = ok ? 'Copied!' : 'Copy failed';
      setTimeout(() => { b.textContent = label; }, 1500);
    };
    return b;
  };
  const section = (title, open, ...kids) => rememberOpen(h('details', { style: 'margin-top:8px' }, h('summary', { textContent: title, style: 'cursor:pointer;font-weight:bold' }), ...kids), `sec:${title}`, open);

  function onRuleChange(changed) {                  // instant re-render from cache; slow rules need a fresh scan
    if (changed.some(id => state.rules[id])) {       // a newly ticked rule has no stored results yet: check what is loaded again
      setStatus('Rule switched on: scanning...');
      scan().catch(onScanError);
    } else refreshView();
  }
  function buildCategories() {
    const wrap = h('div');
    for (const [cat, title] of CATS) {
      const rules = RULES.filter(r => r.cat === cat);
      const boxes = [];
      const all = h('input', { type: 'checkbox' });
      const sync = () => {
        const n = rules.filter(r => state.rules[r.id]).length;
        all.checked = n === rules.length; all.indeterminate = n > 0 && n < rules.length;
      };
      all.onclick = e => e.stopPropagation();
      all.onchange = () => {
        rules.forEach((r, i) => { state.rules[r.id] = all.checked; boxes[i].checked = all.checked; });
        onRuleChange(rules.map(r => r.id));
      };
      const body = h('div', { style: 'margin-left:4px' });
      rules.forEach((r, i) => {
        const cb = h('input', { type: 'checkbox', checked: state.rules[r.id] });
        cb.onchange = () => { state.rules[r.id] = cb.checked; sync(); onRuleChange([r.id]); };
        boxes.push(cb);
        body.append(h('label', { style: 'display:block;font-size:12px' }, cb, ' ',
          h('span', { textContent: '\u25CF ', style: `color:${PALETTE[TIER[r.sev]]}` }), r.label + (r.slow ? ' (slow)' : '')));
        if (r.id === 'NEAR_MISS') {
          const nm = h('input', { type: 'number', min: 1, max: 30, step: 1, value: state.nearMissM, style: 'width:48px' });
          nm.onchange = () => { state.nearMissM = Math.min(30, Math.max(1, Number(nm.value) || 5)); nm.value = state.nearMissM; nmLogged.clear(); if (state.rules.NEAR_MISS) run(); };
          body.append(h('div', { style: 'margin:2px 0 4px 18px;font-size:11px' }, 'Distance (m): ', nm, ' (1-30)'));
        }
        if (r.id === 'ABBREV') {
          const inp = h('input', { type: 'text', value: state.abbrevPattern, style: 'width:95%;font:11px monospace;margin:2px 0 4px 18px' });
          inp.onchange = () => { state.abbrevPattern = inp.value; run(); };
          body.append(inp);
        }
      });
      sync();
      wrap.append(rememberOpen(h('details', { style: 'margin-top:4px' },
        h('summary', { style: 'cursor:pointer' }, all, ' ', h('b', { textContent: title })), body), `cat:${cat}`, cat === 'info'));
    }
    return wrap;
  }

  async function ensureMpLayer() {
    try {
      if (!(await sdk.Map.isLayerVisible({ layerName: 'mapProblems' }))) {
        await sdk.Map.setLayerVisibility({ layerName: 'mapProblems', visibility: true });
        log.info('Map Problems layer switched on (WME only loads them while it is visible)');
      }
    } catch (e) { warnOnce('mp-layer', e); }
  }
  function buildUi(root) {
    ui.area = h('select', { style: 'max-width:100%' });
    ui.area.onchange = () => chooseArea(ui.area.value, true).catch(e => log.warn('area select', e));
    ui.scopeNote = h('div', { style: 'font-size:11px;color:#b26a00' });
    ui.here = h('div', { style: 'font-size:12px;font-weight:bold;margin-top:4px' });
    const drawBtn = mkBtn('Draw', async () => {
      setStatus('Draw the polygon on the map...');
      try {
        const poly = await sdk.Map.drawPolygon();
        if (!poly) return setStatus('Invalid polygon, try again.');
        state.polygons.push(mkArea(poly, `Drawn polygon ${state.polygons.length + 1}`));
        persistPolygons();
        buildAreaSelect();
        await chooseArea(`custom:${state.polygons.length - 1}`, false);
      } catch (e) { log.info('drawPolygon ended', e); setStatus('Drawing cancelled.'); }
    });
    ui.file = h('input', { type: 'file', accept: '.zip,.json,.geojson,.wkt,.txt,.csv', multiple: true, style: 'display:none' });
    ui.file.onchange = async () => {
      const files = [...(ui.file.files || [])];
      ui.file.value = '';
      if (!files.length) return;
      const before = state.polygons.length;
      for (const f of files) {
        try { setStatus(`Importing ${f.name}...`); await importFile(f); }
        catch (e) { log.error('import failed', f.name, e); setStatus(`Import failed: ${e.message}`); }
      }
      const added = state.polygons.length - before;
      if (added > 0) { persistPolygons(); buildAreaSelect(); await chooseArea(added === 1 ? `custom:${before}` : 'custom:all', true); }
    };
    const importBtn = mkBtn('Import', () => ui.file.click());
    const clearPolyBtn = mkBtn('Clear', async () => {
      state.polygons = [];
      persistPolygons();
      buildAreaSelect();
      if (String(state.areaKey).startsWith('custom')) await chooseArea('viewport', false); else await drawScopeOutline();
    });
    ui.zoomSweep = h('input', { type: 'number', min: 12, max: 17, value: state.sweepZoom, style: 'width:44px' });
    ui.zoomSweep.onchange = () => { state.sweepZoom = Number(ui.zoomSweep.value) || 14; };
    ui.sweepBtn = mkBtn('Sweep area', () => toggleSweep().catch(e => { log.error('sweep failed', e); endSweep(); }));

    ui.pauseBtn = mkBtn('Pause', () => {
      if (!state.sweeping) return;
      state.sweepPaused = !state.sweepPaused;
      ui.pauseBtn.textContent = state.sweepPaused ? 'Resume' : 'Pause';
      if (state.sweepPaused) setStatus('Pausing after the current screen...');
    }, { disabled: true });
    ui.nudgeBtn = mkBtn('Refresh map', () => nudgeMap('button'));
    ui.sweepBar = h('div', { style: 'height:6px;background:#e0e0e0;border-radius:3px;margin:4px 0;overflow:hidden' }, h('div', { style: 'height:6px;width:0;background:#1e88e5' }));
    ui.scanBtn = mkBtn('Scan Now', () => scan({ force: true }).catch(onScanError), { style: 'font-weight:bold;padding:3px 10px' });
    ui.status = h('div', { style: 'margin:6px 0;color:#555;font-size:12px;min-height:30px' });

    ui.pos = h('span', { style: 'font-size:12px;margin:0 6px' });
    ui.list = h('div', { style: 'position:relative;height:360px;overflow:auto;font-size:12px;border:1px solid #ddd;margin-top:4px' });   // fixed height: the panel below never shifts
    const zoomInput = h('input', { type: 'number', min: 1, max: 30, value: state.zoomTo, style: 'width:48px' });
    zoomInput.onchange = () => { state.zoomTo = Number(zoomInput.value) || 17; };
    const filters = h('div', { style: 'margin-top:4px' },
      mkSelect([['all', 'All severities'], ...Object.keys(RANK).sort((a, b) => RANK[b] - RANK[a]).map(k => [k, SEV_NAME[k]])], state.filterSev,
        v => { state.filterSev = v; state.listLimit = PAGE; refreshView(); }), ' ',
      (ui.ruleSel = mkRuleSelect(state.filterRule,
        v => { state.filterRule = v; state.listLimit = PAGE; refreshView(); })), ' ',
      mkSelect([['severity', 'Sort: severity'], ['distance', 'Sort: distance'], ['id', 'Sort: segment id']], state.sortBy,
        v => { state.sortBy = v; refreshView(); }));
    const results = section('Error list', true,
      filters,
      mkCheck('Hide visited', state.hideVisited, v => { state.hideVisited = v; refreshView(); }),
      h('div', { style: 'font-size:11px;margin-top:4px' },
        ...['error', 'warning', 'note'].map(k => h('span', { style: 'margin-right:10px' }, h('span', { textContent: '\u25CF ', style: `color:${PALETTE[k]}` }), SEV_NAME[k]))),
      h('div', { style: 'margin-top:4px' }, mkBtn('\u25C0 Prev', () => step(-1)), ui.pos, mkBtn('Next \u25B6', () => step(1))),
      ui.list,
      h('div', { style: 'margin-top:4px;font-size:12px' }, 'Zoom to level ', zoomInput, ' (never zooms out)'),
      mkCheck('Select segment when jumping (hides this tab while selected)', state.selectOnJump, v => { state.selectOnJump = v; }),
      h('div', { style: 'margin-top:4px' },
        mkCopyBtn('Copy list', () => 'id\tseverity\trules\tlon\tlat\n' + state.view.map(e =>
          [e.id, e.sev, e.vis.join('|'), e.mid[0].toFixed(6), e.mid[1].toFixed(6)].join('\t')).join('\n')),
        ' ', mkBtn('Export CSV', exportCsv), ' ', mkBtn('Open in new tab', openListWindow)));

    const widthInput = h('input', { type: 'number', min: 0, max: 20, value: state.extraWidth, style: 'width:48px' });
    widthInput.onchange = async () => { state.extraWidth = Number(widthInput.value) || 0; await sdk.Map.redrawLayer({ layerName: LAYER }); };
    const opacity = h('input', { type: 'range', min: 0.2, max: 1, step: 0.05, value: state.layerOpacity });
    opacity.oninput = () => { state.layerOpacity = Number(opacity.value); sdk.Map.setLayerOpacity({ layerName: LAYER, opacity: state.layerOpacity }); };
    const appearance = section('Appearance', false,
      h('div', { style: 'font-size:12px' }, 'Extra width (px) ', widthInput), h('div', { style: 'font-size:12px' }, 'Opacity ', opacity));

    ui.log = h('textarea', { readOnly: true, rows: 8, style: 'width:100%;box-sizing:border-box;font:11px monospace;white-space:pre' });
    ui.log.value = logBuf.join('\n');
    const debugBox = section('Debug log (copy instead of F12)', false,
      mkCheck('Capture console warnings and errors', cap.on, v => { cap.on = v; applyCapture(); log.info(`capture warnings/errors: ${v}`); }),
      mkCheck('...also log/info/debug (very noisy)', cap.verbose, v => { cap.verbose = v; applyCapture(); log.info(`capture verbose: ${v}`); }),
      ui.log,
      mkCopyBtn('Copy log', () => logBuf.join('\n')), ' ',
      mkCopyBtn('Copy diagnostics', diagnostics), ' ',
      mkBtn('Clear', () => { logBuf.length = 0; ui.log.value = ''; }), ' ',
      mkBtn('Reset saved settings', () => { kv.del(SETTINGS_KEY); kv.del(POLY_KEY); kv.del(RESULTS_KEY); clearTimeout(persistTimer); persistTimer = 0; state.areasReady = false; setStatus('Saved settings cleared. Reload the page to start from defaults.'); }));

    ui.bgBtn = mkBtn('Scan map problems', () => bgScan().catch(e => { log.error('bgScan', e); bg.running = false; }), { disabled: !state.bgEnabled });
    ui.bgBar = h('div', { style: 'height:6px;background:#e0e0e0;border-radius:3px;margin:4px 0;overflow:hidden' }, h('div', { style: 'height:6px;width:0;background:#d81b60' }));
    ui.bgStatus = h('div', { style: 'font-size:12px;color:#555' });
    ui.mpList = h('div', { style: 'position:relative;max-height:260px;overflow:auto;font-size:12px;border:1px solid #ddd;margin-top:4px' });
    const mpSection = section('Map problems, background (unofficial)', false,
      h('div', { style: 'font-size:11px;color:#b26a00' }, 'Uses WME\'s own feature service, not the SDK. It can stop working after any WME update. The map does not move.'),
      mkCheck('Enable this unofficial scan', state.bgEnabled, v => { state.bgEnabled = v; ui.bgBtn.disabled = !v; }),
      h('div', { style: 'margin-top:4px' }, ui.bgBtn, ' (uses the selected area, or the screen)'), ui.bgBar, ui.bgStatus, ui.mpList);
    root.addEventListener('change', persistSoon);
    root.addEventListener('input', persistSoon);
    root.append(
      h('b', { textContent: NAME }),
      mkCheck('Enabled', state.enabled, async v => {
        state.enabled = v;
        for (const layerName of [LAYER, HALO_LAYER, SCOPE_LAYER, BORDER_LAYER, MP_LAYER]) await sdk.Map.setLayerVisibility({ layerName, visibility: v });
        if (v) run();
      }),
      h('div', { style: 'margin-top:4px' }, 'Area: ', ui.area), h('div', { style: 'margin-top:4px' }, drawBtn, ' ', importBtn, ' ', clearPolyBtn, ' ', ui.sweepBtn, ' ', ui.pauseBtn, ' ', ui.nudgeBtn, ' zoom ', ui.zoomSweep), ui.sweepBar, ui.file, ui.scopeNote,
      h('div', { style: 'margin-top:4px' }, mkBtn('Fit area', () => fitAreas(areasForKey(), false)), ' ', mkBtn('Go to corner', () => fitAreas(areasForKey(), true)), ' ',
        mkBtn('Mark all unswept', async () => { [...state.polygons, ...state.managedAreas, ...(state.driveAreas || [])].forEach(a => { a.done = false; }); await drawScopeOutline(); saveResults(); })),
      ui.here,
      mkCheck('Show section borders and names on the map', state.showSections, async v => { state.showSections = v; await drawBoundaries(); }),
      mkCheck('Skip sections already swept (this session)', state.skipDone, v => { state.skipDone = v; }),
      mkCheck('Limit to screen viewport (area scopes)', state.limitToViewport, v => { state.limitToViewport = v; run(); }),
      mkCheck('Include Waze map problems (shows WME\'s Map Problems layer so they load)', state.loadMP, async v => {
        state.loadMP = v;
        if (v) await ensureMpLayer();
        run();
      }),
      h('div', { style: 'margin-top:6px;font-weight:bold;font-size:12px' }, 'Triggers'),
      mkCheck('Highlight only (no auto-pan)', state.highlightOnly, v => { state.highlightOnly = v; }),
      mkCheck('Auto-scan on map move / zoom', state.autoMove, v => { state.autoMove = v; if (v) run(); }),
      mkCheck('Auto-scan on save \u26A1', state.autoSave, v => { state.autoSave = v; }),
      mkCheck('Keep results from earlier scans', state.accumulate, v => { state.accumulate = v; }),
      h('div', { style: 'margin-top:6px;font-weight:bold;font-size:12px' }, 'Categories'),
      buildCategories(),
      h('div', { style: 'margin-top:8px' }, ui.scanBtn, ' ', mkBtn('Clear Highlights', () => clearHighlights())),
      ui.status, results, mpSection, appearance, debugBox,
    );
  }
  function floatingRoot() {
    const box = h('div', { style: 'position:fixed;bottom:40px;left:10px;z-index:9999;max-height:85vh;overflow:auto;background:#fff;border:1px solid #888;border-radius:6px;padding:8px;font:12px sans-serif;width:320px' });
    document.body.append(box);
    return box;
  }

  // ----------------------------------------------------------------- boot
  const debounce = (fn, ms) => { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; };
  const onScanError = e => { log.error('scan failed', e); setStatus('Scan error, copy the debug log'); };
  let run = () => {};
  const on = (eventName, eventHandler) => { const off = sdk.Events.on({ eventName, eventHandler }); if (typeof off === 'function') offs.push(off); };

  // After a laptop sleep / tab switch WME can leave the map blank until the view moves. A tiny pan-and-back makes it refetch tiles.
  async function nudgeMap(why) {
    try {
      const [c, z, ext] = await Promise.all([sdk.Map.getMapCenter(), sdk.Map.getZoomLevel(), sdk.Map.getMapExtent()]);
      const area = areasForKey()[0];
      // jump to the selected area (it has roads) so WME fetches fresh data; with no area, pan one screen away instead
      const away = area ? areaCenter(area) : { lon: c.lon + (Array.isArray(ext) ? Math.abs(ext[2] - ext[0]) : 0.01 || 0.01), lat: c.lat };
      await sdk.Map.setMapCenter({ lonLat: away, zoomLevel: Math.max(z, 13) });
      const t0 = Date.now();
      await sleep(500);
      while (Date.now() - t0 < 8000 && await sdk.State.isMapLoading()) await sleep(200);
      await sdk.Map.setMapCenter({ lonLat: { lon: c.lon, lat: c.lat }, zoomLevel: z });
      log.info(`map nudged (${why}) via ${area ? 'area centre' : 'one-screen pan'}, ${Date.now() - t0}ms`);
    } catch (e) { log.warn('map nudge failed', e); }
  }
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > 20000 && !state.sweeping || (hiddenAt && state.sweepPaused)) nudgeMap('page visible again');
  });

  async function placeBelowRoads() {
    const names = [];
    for (const holder of [window.WME_LAYER_NAMES, sdk.Map && sdk.Map.WME_LAYER_NAMES]) if (holder && holder.SEGMENTS) names.push(holder.SEGMENTS);
    names.push('segments', 'roads');
    for (const layerName of names) {
      try {
        const z = await sdk.Map.getLayerZIndex({ layerName });
        for (const own of [LAYER, HALO_LAYER]) await sdk.Map.setLayerZIndex({ layerName: own, zIndex: z - 1 });
        for (const own of [BORDER_LAYER, SCOPE_LAYER]) { try { await sdk.Map.setLayerZIndex({ layerName: own, zIndex: z + 2 }); } catch (e2) { warnOnce('border-z', e2); } }   // borders above the roads so they are never hidden
        state.underRoads = `yes (below "${layerName}", z=${z - 1})`;
        return log.info(`highlight layers placed below "${layerName}" (z=${z})`);
      } catch (e) { /* try next candidate */ }
    }
    state.underRoads = 'no (native segments layer name not found)';
    log.warn('could not place highlights below the native segments layer; they will draw at the default z-index');
  }
  const widthFor = (zoom, rt) => Math.max(5, (zoom - 8) * 1.1) * (WIDTH_FACTOR[rt] || 1) + state.extraWidth;
  async function cleanup() {
    offs.splice(0).forEach(off => { try { off(); } catch (e) { /* ignore */ } });
    for (const layerName of [LAYER, HALO_LAYER, SCOPE_LAYER, BORDER_LAYER, MP_LAYER]) { try { await sdk.Map.removeLayer({ layerName }); } catch (e) { /* ignore */ } }
  }

  async function init() {
    await sdk.Map.addLayer({
      layerName: BORDER_LAYER,
      styleContext: {
        getColor: ({ feature }) => (feature && feature.properties && feature.properties.color) || '#e65100',
        getLabel: ({ feature }) => (feature && feature.properties && feature.properties.label) || '',
      },
      styleRules: [{ style: { strokeColor: '${getColor}', strokeOpacity: 0.9, strokeWidth: 2, strokeDashstyle: 'dash', fillOpacity: 0,
        label: '${getLabel}', labelAlign: 'cm', fontSize: '18px', fontWeight: 'bold', fontColor: '${getColor}', labelOutlineColor: '#ffffff', labelOutlineWidth: 4 } }],
    });
    await sdk.Map.addLayer({
      layerName: SCOPE_LAYER,
      styleContext: {
        getColor: ({ feature }) => (feature && feature.properties && feature.properties.color) || '#3949ab',
      },
      styleRules: [{ style: { strokeColor: '${getColor}', strokeWidth: 3, fillOpacity: 0 } }],
    });
    await sdk.Map.addLayer({
      layerName: MP_LAYER,
      styleContext: { getTip: ({ feature }) => (feature && feature.properties && feature.properties.tip) || '' },
      styleRules: [{ style: { pointRadius: 9, fillColor: '#d81b60', fillOpacity: 0.85, strokeColor: '#ffffff', strokeWidth: 2, title: '${getTip}' } }],
    });
    await sdk.Map.addLayer({
      layerName: HALO_LAYER,
      styleContext: { getWidth: ({ feature, zoomLevel }) => widthFor(zoomLevel, feature && feature.properties && feature.properties.rt) + 6 },
      styleRules: [{ style: { strokeColor: '#00bcd4', strokeOpacity: 0.7, strokeWidth: '${getWidth}', strokeLinecap: 'round' } }],
    });
    await sdk.Map.addLayer({
      layerName: LAYER,
      styleContext: {
        getWidth: ({ feature, zoomLevel }) => widthFor(zoomLevel, feature && feature.properties && feature.properties.rt),
        getTip: ({ feature }) => (feature && feature.properties && feature.properties.tip) || '',
      },
      styleRules: [
        { style: { strokeColor: PALETTE.note, strokeOpacity: 0.6, strokeWidth: '${getWidth}', strokeLinecap: 'round', fill: false, title: '${getTip}', graphicZIndex: 10 } },
        { predicate: p => p.sev === 'warning', style: { strokeColor: PALETTE.warning, graphicZIndex: 20 } },
        { predicate: p => p.sev === 'error', style: { strokeColor: PALETTE.error, graphicZIndex: 30 } },
      ],
    });
    await placeBelowRoads();
    try {
      await sdk.Map.setLayerOpacity({ layerName: LAYER, opacity: state.layerOpacity });
      if (!state.enabled) for (const layerName of [LAYER, HALO_LAYER, SCOPE_LAYER, BORDER_LAYER, MP_LAYER]) await sdk.Map.setLayerVisibility({ layerName, visibility: false });
    } catch (e) { warnOnce('restore-layers', e); }
    applyCapture();
    try {
      const rts = await sdk.DataModel.Segments.getRoadTypes();
      state.roadTypeNames = new Map(rts.map(r => [r.id, r.localizedName || r.name]));
    } catch (e) { warnOnce('road-types', e); }

    let root;
    try {
      const tab = await sdk.Sidebar.registerScriptTab();
      tab.tabLabel.textContent = 'Validator';
      root = tab.tabPane;
    } catch (e) { log.warn('sidebar tab unavailable, using floating panel', e); root = floatingRoot(); }
    buildUi(root);

    run = debounce(() => { if (state.sweeping) return; if (state.autoMove) scan().catch(onScanError); else setStatus('Settings changed. Press Scan Now.'); }, 500);
    ['wme-map-data-loaded', 'wme-map-zoom-changed', 'wme-map-move-end'].forEach(n => on(n, run));
    on('wme-after-edit', collectEdited);
    on('wme-save-finished', p => onSaveFinished(p).catch(e => log.error('save handler failed', e)));
    on('wme-map-move-end', updateHere);
    on('wme-map-zoom-changed', updateHere);
    on('wme-map-move-end', async () => {
      if (state.sortBy !== 'distance') return;
      try { state.center = await sdk.Map.getMapCenter(); await refreshView(); } catch (e) { log.warn('distance refresh', e); }
    });
    window.addEventListener('beforeunload', () => { cleanup(); });

    if (state.restored) log.info(`restored from last session: ${state.restored.done} swept section(s), ${state.restored.issues} issue(s)${state.restored.partial ? ' (marks only: issue list was too big to save)' : ''}`);
    buildAreaSelect();
    drawBoundaries().then(updateHere);
    ensureMpLayer();
    loadAreas().catch(e => log.warn('loadAreas', e)).finally(() => { state.areasReady = true; persistSoon(); });
    run();
  }

  if (!window.SDK_INITIALIZED) { log.warn('SDK_INITIALIZED missing: not running in WME?'); return; }
  window.SDK_INITIALIZED.then(() => {
    sdk = getWmeSdk({ scriptId: ID, scriptName: NAME, mode: 'async' });     // async mode: every module method returns a Promise
    return sdk.Events.once({ eventName: 'wme-ready' });
  }).then(init).catch(e => log.error('init failed', e));
})();
