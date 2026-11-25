// ==UserScript==
// @name         WME Segment Validator
// @namespace    local.wme.segment.validator
// @author       dinkaftac
// @homepageURL  https://github.com/dinkaftac/wme-segment-validator
// @supportURL   https://github.com/dinkaftac/wme-segment-validator/issues
// @updateURL    https://raw.githubusercontent.com/dinkaftac/wme-segment-validator/main/wme-segment-validator.user.js
// @downloadURL  https://raw.githubusercontent.com/dinkaftac/wme-segment-validator/main/wme-segment-validator.user.js
// @version      0.25.3
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
  const VERSION = '0.25.3';
  const LAYER = 'segment-validator-highlights';
  const HALO_LAYER = 'segment-validator-current';   // halo behind the highlight for the focused segment
  const SCOPE_LAYER = 'segment-validator-scope';
  const BORDER_LAYER = 'segment-validator-borders';   // all imported / drawn sections, always visible, labelled
  const MAX_DRAWN = 3000;
  const PAGE = 200;

  // Soft, eye-friendly palette. FeatureStyle takes hex colours plus a separate strokeOpacity.
  // Three severity tiers, like the reference validators: red errors, amber warnings, blue notes.
  // Rules keep their finer 'sev' label; TIER folds it into one of the three tiers used for colour, order, list and filters.
  const PALETTE = { error: '#E00', warning: '#DA0', note: '#30E' };   // same colours as WME Validator (error red, warning yellow, note blue)
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
  const PLACE_MP = 'place problem (sits on a place)';   // 'Missing place details' and similar: the SDK says only DATA, so a problem sitting on a place is taken as one
  const offs = [];                                    // unregister functions returned by Events.on (if any)
  const state = {
    enabled: true,
    autoMove: true,           // debounced re-scan on map move / zoom / data load
    highlightOnly: false,
    collapsed: {},
    autoSave: true,           // validate edited segments after a successful save
    accumulate: true,
    scope: 'viewport',        // 'viewport' | 'area'
    loadMP: true, mpSig: '', mpHidden: [PLACE_MP], mpSeen: {},
    areaKey: 'viewport',      // 'viewport' | 'managed:<i|all>' | 'drive:<i|all>' | 'custom:<i|all>'
    sweeping: false, sweepCancel: false, sweepPaused: false,
    sweepZoom: 14, bgEnabled: false, open: {}, areasReady: false,
    limitToViewport: true,
    showSections: true,       // draw the borders + names of every imported / drawn section
    placesOn: false, uiTab: 'roads', pHideChecked: false, pSev: 'all', pRuleF: 'all', pMark: 'all', pSort: 'sev', pQ: '', pCustom: [], staleYears: 3, pRules: {}, pstore: new Map(), pview: [], pCur: null, placeTags: {},
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
      ['DataModel.Turns', dm.Turns, ['getTurnsFromSegment', 'isTurnAllowed']],
      ['DataModel.Venues', dm.Venues, ['getAll', 'getAddress']],
      ['DataModel.EditSuggestions', dm.EditSuggestions, ['getAll', 'getEditSuggestionChanges']],
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
  // ---- split an area into smaller cells that keep the real border (cells are the grid rectangle clipped to the polygon)
  function clipRing(ring, r) {                       // Sutherland-Hodgman against one rectangle [west, south, east, north]
    let pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring.slice();
    const planes = [
      [p => p[0] >= r[0], (a, b) => { const t = (r[0] - a[0]) / (b[0] - a[0]); return [r[0], a[1] + t * (b[1] - a[1])]; }],
      [p => p[0] <= r[2], (a, b) => { const t = (r[2] - a[0]) / (b[0] - a[0]); return [r[2], a[1] + t * (b[1] - a[1])]; }],
      [p => p[1] >= r[1], (a, b) => { const t = (r[1] - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), r[1]]; }],
      [p => p[1] <= r[3], (a, b) => { const t = (r[3] - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), r[3]]; }],
    ];
    for (const [inside, inter] of planes) {
      const input = pts; pts = [];
      for (let i = 0; i < input.length; i++) {
        const cur = input[i], prev = input[(i + input.length - 1) % input.length];
        if (inside(cur)) { if (!inside(prev)) pts.push(inter(prev, cur)); pts.push(cur); }
        else if (inside(prev)) pts.push(inter(prev, cur));
      }
      if (!pts.length) return [];
    }
    return pts.length >= 3 ? [...pts, pts[0]] : [];
  }
  const ringArea = ring => { let a = 0; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]); return Math.abs(a) / 2; };
  function splitArea(area, km) {
    const [x0, y0, x1, y1] = area.bbox;
    const dxKm = km / (111.32 * Math.cos(((y0 + y1) / 2) * Math.PI / 180)), dyKm = km / 110.574;
    const nx = Math.max(1, Math.ceil((x1 - x0) / dxKm)), ny = Math.max(1, Math.ceil((y1 - y0) / dyKm));
    const dx = (x1 - x0) / nx, dy = (y1 - y0) / ny, kids = [];
    for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) {
      const rect = [x0 + c * dx, y1 - (r + 1) * dy, x0 + (c + 1) * dx, y1 - r * dy];
      const outer = clipRing(area.geometry.coordinates[0], rect);
      if (!outer.length || ringArea(outer) < dx * dy * 0.001) continue;      // outside the border, or a crumb
      const holes = area.geometry.coordinates.slice(1).map(h => clipRing(h, rect)).filter(h => h.length);
      kids.push(mkArea({ type: 'Polygon', coordinates: [outer, ...holes] }, `${area.name} \u00B7 R${r + 1}C${c + 1}`));
    }
    return { kids, nx, ny };
  }
  const bboxHit = (p, q) => p[0] <= q[2] && p[2] >= q[0] && p[1] <= q[3] && p[3] >= q[1];
  const segBBox = s => bboxOfCoords(s.geometry.coordinates);
  const mkArea = (geometry, name) => ({ geometry, name, bbox: bboxOfCoords(geometry.coordinates[0]) });
  // A segment belongs to an area if any vertex is inside, any point sampled every ~50 m along it is inside,
  // or it crosses the area's outer border (catches long segments that cut a corner with no vertex inside).
  function segmentsCross(a, b, c, d) {
    const d1 = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const d2 = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]);
    const d3 = (d[0] - c[0]) * (a[1] - c[1]) - (d[1] - c[1]) * (a[0] - c[0]);
    const d4 = (d[0] - c[0]) * (b[1] - c[1]) - (d[1] - c[1]) * (b[0] - c[0]);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  }
  function lineCrossesPolygon(coords, poly) {
    if (coords.some(pt => polygonContains(pt, poly))) return true;
    for (let i = 1; i < coords.length; i++) {
      const [x1, y1] = coords[i - 1], [x2, y2] = coords[i];
      const k = Math.cos(((y1 + y2) / 2) * Math.PI / 180);
      const lenM = Math.hypot((x2 - x1) * 111320 * k, (y2 - y1) * 110540);
      const n = Math.max(1, Math.min(64, Math.ceil(lenM / 50)));
      for (let j = 1; j < n; j++) {
        const t = j / n;
        if (polygonContains([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t], poly)) return true;
      }
    }
    const ring = poly.coordinates[0];
    for (let i = 1; i < coords.length; i++)
      for (let j = 1; j < ring.length; j++) if (segmentsCross(coords[i - 1], coords[i], ring[j - 1], ring[j])) return true;
    return false;
  }
  const segInArea = (s, area) => bboxHit(segBBox(s), area.bbox) && lineCrossesPolygon(s.geometry.coordinates, area.geometry);

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
  const stateMissing = (st, c) => {                 // the street's city has no state (or an empty one)
    if (!st || st.cityId == null) return false;
    const ct = c.cities.get(st.cityId);
    if (!ct || !('stateId' in ct)) return false;     // the SDK did not expose stateId: unknown, do not guess
    if (ct.stateId == null) return true;
    const stt = c.states.get(ct.stateId);
    return !!stt && (stt.isEmpty === true || !String(stt.name || '').trim());
  };
  let cityShapeLogged = false;
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
  const norm180 = a => ((a % 360) + 540) % 360 - 180;
  // Waze median U-turn prevention: turn in (A), ONE short median segment (B), turn out (C), A and C about parallel (turns add up to ~180 degrees).
  // Waze then adds a huge penalty and the U-turn is effectively never routed. A median of 16 m or more always allows it.
  // Cutting the median into two segments (an extra node in the middle) switches the penalty off, so such medians are not flagged.
  function medianTriples(s, c) {                    // every in-segment / out-segment pair that makes a U-turn over this median segment
    const found = [];
    if (!s.isDrivable || s.junctionId != null || s.fromNodeId == null || s.toNodeId == null || s.fromNodeId === s.toNodeId) return found;
    if (!(s.length > 0 && s.length < 16) || s.geometry.coordinates.length < 2) return found;
    const dirs = [];
    if (fwdOpen(s)) dirs.push([s.fromNodeId, s.toNodeId]);
    if (revOpen(s)) dirs.push([s.toNodeId, s.fromNodeId]);
    const lvl = x => x.elevationLevel ?? 0;
    for (const [n1, n2] of dirs) {
      const hB = bearingAway(s, n1);
      for (const a of others(c, s, n1)) {
        if (!a.isDrivable || !arrives(a, n1) || lvl(a) !== lvl(s) || a.geometry.coordinates.length < 2) continue;
        const t1 = norm180(hB - (bearingAway(a, n1) + 180));
        for (const k of others(c, s, n2)) {
          if (!k.isDrivable || k.id === a.id || !leaves(k, n2) || lvl(k) !== lvl(s) || k.geometry.coordinates.length < 2) continue;
          const t2 = norm180(bearingAway(k, n2) - hB);
          const sum = Math.abs(t1 + t2);
          if (t1 * t2 > 0 && sum >= 175 && sum <= 185) found.push({ aId: a.id, n1, n2, kId: k.id });
        }
      }
    }
    return found;
  }
  function medianUturn(s, c) { return medianTriples(s, c).length > 0; }
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
  // ---- map problem types you can switch off (e.g. place-related ones that a rank 1 editor cannot act on)
  function mpKey(x) { return String(x == null ? 'unknown' : x).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase() || 'unknown'; }
  let mpShapeLogged = false;
  function mpKeyOf(m) {                              // the SDK only says problemType "DATA" for everything seen so far, so use any sub type it offers
    if (!mpShapeLogged) { mpShapeLogged = true; log.info(`map problem sample keys: ${Object.keys(m).join(',')} :: ${fmt(m).slice(0, 500)}`); }
    const st = m.subType ?? m.problemSubType ?? m.subtype ?? m.problemSubtype ?? m.reason ?? m.category;
    if (st == null) return mpKey(m.problemType);
    const named = typeof MP_TYPES !== 'undefined' && MP_TYPES[st];
    return named ? mpKey(named) : mpKey(`${m.problemType ?? ''} ${st}`);
  }
  const mpHide = k => state.mpHidden.includes(k);
  function mpSeenNote(k) { if (!(k in state.mpSeen)) { state.mpSeen[k] = 1; if (ui.mpTypes) renderMpTypes(); } }
  async function buildContext(all, cands = all) {      // cands: the segments that will be checked; names are looked up for those only
    const c = { seg: new Map(), nodes: new Map(), pairs: new Map(), streets: new Map(), cities: new Map(), states: new Map(), _grid: null };
    const streetIds = new Set();
    for (const s of all) {
      c.seg.set(s.id, s);
      for (const n of new Set(ends(s))) if (n != null) { if (!c.nodes.has(n)) c.nodes.set(n, []); c.nodes.get(n).push(s); }
      if (s.isDrivable && s.fromNodeId != null && s.toNodeId != null && s.fromNodeId !== s.toNodeId) {
        const k = pairKey(s); c.pairs.set(k, (c.pairs.get(k) || 0) + 1);
      }
    }
    for (const s of cands) {
      if (s.primaryStreetId != null) streetIds.add(s.primaryStreetId);
      (s.alternateStreetIds || []).forEach(i => streetIds.add(i));
    }
    const needNames = [...NAME_RULES].some(id => state.rules[id]);
    const needNodes = RULES.some(r => state.rules[r.id] && NEIGHBOUR_RULE(r));
    if (needNames) {                                 // only fetch what the ticked rules read
      c.streets = await loadById(sdk.DataModel.Streets, 'streetId', streetIds);
      const cityIds = new Set([...c.streets.values()].map(st => st.cityId).filter(i => i != null));
      c.cities = await loadById(sdk.DataModel.Cities, 'cityId', cityIds);
      if (state.rules.NO_STATE) try { (await sdk.DataModel.States.getAll()).forEach(x => c.states.set(x.id, x)); } catch (e) { warnOnce('states-getAll', e); }
      if (!cityShapeLogged && c.cities.size) { cityShapeLogged = true; const x = [...c.cities.values()][0]; log.info(`city sample keys: ${Object.keys(x).join(',')} stateId=${x.stateId}`); }
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
        let venuePts = [];
        try { venuePts = (await sdk.DataModel.Venues.getAll()).map(placeMid).filter(Boolean); } catch (e) { warnOnce('mp-venues', e); }
        let placeMps = 0;
        for (const m of mps) {
          types[String(m.problemType)] = (types[String(m.problemType)] || 0) + 1;
          const pp = m.geometry.coordinates;
          const onPlace = venuePts.some(v => Math.abs(v[0] - pp[0]) < 0.0001 && Math.abs(v[1] - pp[1]) < 0.0001 && distM({ lon: pp[0], lat: pp[1] }, v) < 6);
          if (onPlace) placeMps++;
          const mk = onPlace ? PLACE_MP : mpKeyOf(m); mpSeenNote(mk);
          if (mpHide(mk)) continue;                  // switched off in "Map problem types"
          const p = m.geometry.coordinates;
          const hits = [...near(c, p)].map(t => [distPointToLineM(p, t.geometry.coordinates), t]).filter(x => x[0] < 25).sort((a, b) => a[0] - b[0]).slice(0, 3);
          for (const [, t] of hits) { if (!c.mp.has(t.id)) c.mp.set(t.id, []); c.mp.get(t.id).push(m); }
        }
        const sig = JSON.stringify(types);
        if (sig !== state.mpSig) { state.mpSig = sig; log.info(`map problems loaded: open=${mps.length} onPlaces=${placeMps} byType=${sig} segmentsFlagged=${c.mp.size}`); }
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
    { id: 'MP_OPEN', cat: 'server', sev: 'error', on: true, label: 'Open Waze map problem at this segment',
      test: (s, c) => (c.mp.get(s.id) || []).length > 0 },
    // --- Missing info & naming
    { id: 'NO_NAME', cat: 'info', sev: 'warning', on: true, label: 'No street name',
      test: (s, c) => NAMED_TYPES.has(s.roadType) && s.junctionId == null && !nameOf(s, c) },
    { id: 'NO_STATE', cat: 'info', sev: 'warning', on: true, label: 'City has no state',
      test: (s, c) => NAMED_TYPES.has(s.roadType) && !!nameOf(s, c) && cityOk(streetOf(s, c), c) && stateMissing(streetOf(s, c), c) },
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
    { id: 'MEDIAN_UTURN', cat: 'geometry', sev: 'warning', on: true, label: 'Median U-turn too short: one median segment under 16 m',
      test: medianUturn },
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
    { id: 'LOOP_SELF', cat: 'topology', sev: 'error', on: true, label: 'Loop: one segment joins itself (A to B, B back to A). Split it so the loop has 3+ segments',
      test: s => s.fromNodeId != null && s.toNodeId != null && s.fromNodeId === s.toNodeId },
    { id: 'LOOP', cat: 'topology', sev: 'warning', on: true, label: 'Loop: 2 segments share both end nodes (A and B of one = A and B of the other). Add a junction node',
      test: (s, c) => s.fromNodeId != null && s.toNodeId != null && s.fromNodeId !== s.toNodeId && s.isDrivable && (c.pairs.get(pairKey(s)) || 0) > 1 },
    { id: 'BDP', cat: 'topology', sev: 'warning', on: true, async: true,
      label: 'Big Detour Prevention: off-and-on detour beside a direct highway route (penalised by Waze)',
      test: () => false },
    { id: 'BC_NOT_STRAIGHT', cat: 'continuity', sev: 'warning', on: true, async: true,
      label: 'Best continuation is not the straightest road at this split (name/type match picks the angled branch)', test: () => false },
    { id: 'BC_TIE', cat: 'continuity', sev: 'note', on: true, async: true,
      label: 'Best continuation tie at a split: 2+ branches match the incoming road equally, so both get a Keep instruction', test: () => false },
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
      test: s => s.hasRestrictions && (s.restrictions || []).some(r => r && r.isExpired === true) },   // SDK: SegmentRestriction.isExpired
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

  // ---------------------------------------------------------------- place rules
  // test(venue, x): x = { addr, dupLink, dupNear }. Address rules are skipped when the address could not be read.
  const placeMid = v => {
    const g = v.geometry;
    if (!g) return null;
    if (g.type === 'Point') return g.coordinates;
    const ring = g.type === 'Polygon' ? g.coordinates[0] : null;
    if (!ring || !ring.length) return null;
    const b = bboxOfCoords(ring);
    return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  };
  const normName = n => String(n || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const isParking = v => (v.categories || []).some(c => /PARKING/i.test(String(c)));
  const plain = v => !v.isResidential && !isParking(v);
  const imgTime = im => { const d = im && (im.creationDate ?? im.date); if (d == null) return NaN; return typeof d === 'number' ? (d < 1e12 ? d * 1000 : d) : Date.parse(d); };
  const HN = x => String(x.addr.houseNumber == null ? '' : x.addr.houseNumber);
  const addrName = o => (o && o.name ? String(o.name).trim() : '');
  const PRULES = [
    { id: 'P_NO_NAME', sev: 'warning', on: true, label: 'Place has no name', test: v => plain(v) && !(v.name || '').trim() },
    { id: 'P_NAME_SPACE', sev: 'note', on: true, label: 'Name has extra spaces', test: v => /^\s|\s$|\s{2,}/.test(v.name || '') },
    { id: 'P_NAME_CAPS', sev: 'note', on: true, label: 'Name is ALL CAPS', test: v => { const L = (v.name || '').replace(/[^\p{L}]/gu, ''); return L.length > 3 && L === L.toUpperCase() && L !== L.toLowerCase(); } },
    { id: 'P_NAME_LOWER', sev: 'note', on: true, label: 'Name starts lowercase', test: v => /^\p{Ll}/u.test((v.name || '').trim()) },
    { id: 'P_NO_CAT', sev: 'warning', on: true, label: 'No category', test: v => !(v.categories || []).length },
    { id: 'P_NO_STREET', sev: 'warning', on: true, needAddr: true, label: 'Address: no street', test: (v, x) => !addrName(x.addr.street) },
    { id: 'P_NO_CITY', sev: 'warning', on: true, needAddr: true, label: 'Address: no city', test: (v, x) => !addrName(x.addr.city) },
    { id: 'P_NO_STATE', sev: 'warning', on: true, needAddr: true, label: 'Address: no state', test: (v, x) => !addrName(x.addr.state) },
    { id: 'P_NO_HN', sev: 'note', on: false, needAddr: true, label: 'Address: no house number', test: (v, x) => !String(x.addr.houseNumber || '').trim() },
    { id: 'P_HN_SPACE', sev: 'warning', on: true, needAddr: true, label: 'House number has a space (e.g. "12 A"; use 12A or 12-1)', test: (v, x) => /\s/.test(HN(x)) },
    { id: 'P_HN_WORDS', sev: 'warning', on: true, needAddr: true, label: 'House number holds a street/area/building name (only the number belongs here)',
      test: (v, x) => { const t = HN(x); return !!t && (/(jalan|jln|lorong|lrg|taman|tmn|kampung|persiaran|lebuh|\blot\b|\bno\b\.?)/i.test(t) || /[A-Za-z]{4,}/.test(t.replace(/bis/ig, ''))); } },
    { id: 'P_HN_PLACEHOLDER', sev: 'note', on: true, needAddr: true, label: 'House number looks like a placeholder or phone number (leave blank if unknown)',
      test: (v, x) => { const t = HN(x).trim(); return !!t && (/^(0+|[-_.?*]+|n\/?a|none|null|unknown|nil)$/i.test(t) || t.replace(/\D/g, '').length >= 8); } },
    { id: 'P_HN_CASE', sev: 'note', on: true, needAddr: true, label: 'House number has lowercase letters (community standard: uppercase, e.g. 123A)', test: (v, x) => /[a-z]/.test(HN(x)) },
    { id: 'P_HN_DASHLETTER', sev: 'note', on: true, needAddr: true, label: 'Sub-letter written with a hyphen (123-A; use 123A)', test: (v, x) => /^\d+-[A-Za-z]$/.test(HN(x).trim()) },
    { id: 'P_HN_FORMAT', sev: 'warning', on: true, needAddr: true, label: 'House number has odd symbols or a stray - / at the start or end',
      test: (v, x) => { const t = HN(x); return !!t && /[#@*;:,.()]|^[-\/]|[-\/]$|\/\/|--/.test(t.trim()); } },
    { id: 'P_CITY_AREA', sev: 'warning', on: true, needAddr: true, label: 'City field looks like a Taman / Kampung / Zone (use the official city or council name)',
      test: (v, x) => /\b(taman|tmn|kampung|kg|zon|zone)\b/i.test(addrName(x.addr.city)) },
    { id: 'P_NAME_ADDRESS', sev: 'warning', on: true, label: 'Name has an address, phone or website in it (name only, no details)',
      test: v => { const n = v.name || ''; return /(https?:\/\/|www\.|\.com\b|\.my\b|\.net\b)/i.test(n) || /\d{2,3}[-\s]?\d{3,4}[-\s]?\d{4}/.test(n) || /\b(jalan|jln|lorong|lrg)\b.*\d|\bno\.?\s*\d/i.test(n); } },
    { id: 'P_SCHOOL_PREFIX', sev: 'note', on: true, label: 'School name should use the short prefix (SK, SMK, SJK (C)...) (MY)',
      test: v => (v.categories || []).some(c => /^SCHOOL$/i.test(String(c))) && /^sekolah\s+(kebangsaan|menengah|rendah|jenis)/i.test((v.name || '').trim()) },
    { id: 'P_SCHOOL_NO_ALT', sev: 'note', on: true, label: 'School has no alternate name (put the full spelled-out name there) (MY)',
      test: v => (v.categories || []).some(c => /^SCHOOL$/i.test(String(c))) && /^(SK|SR|SJK|SRA|SMK|SM|SBP|SBPI|MRSM)\b/i.test((v.name || '').trim()) && !(v.aliases || []).length },
    { id: 'P_STREET_AREA', sev: 'warning', on: true, needAddr: true, label: 'Street field has Taman / Kampung / Seksyen, a number or the city name (street name only) (MY)',
      test: (v, x) => { const st = addrName(x.addr.street), c = addrName(x.addr.city).toLowerCase(); return !!st && (/\b(taman|tmn|kampung|kg|seksyen|section)\b/i.test(st) || /^\d/.test(st) || (c.length > 3 && st.toLowerCase().includes(c))); } },
    { id: 'P_PHONE_MY', sev: 'note', on: true, label: 'Phone not in WazeMY format, e.g. 012-345 6789 or 03-1234 5678 (one number, no +60) (MY)',
      test: v => plain(v) && !!(v.phone || '').trim() && !/^(0\d{1,2}-\d{3,4} \d{3,4}|1-\d{3}-\d{2}-\d{4})$/.test(v.phone.trim()) },
    { id: 'P_URL_FORMAT', sev: 'note', on: true, label: 'Website has http(s):// or tracking parameters (use www.example.com)',
      test: v => plain(v) && /^https?:\/\/|[?&](utm_|fbclid|gclid)/i.test((v.url || '').trim()) },
    { id: 'P_NO_EXT', sev: 'note', on: true, label: 'Not linked to a Google place (check it exists)', test: v => plain(v) && !(v.externalProviderIds || []).length },
    { id: 'P_DUP_LINK', sev: 'warning', on: true, label: 'Same Google place linked to 2+ places', test: (v, x) => x.dupLink.has(v.id) },
    { id: 'P_DUP_NEAR', sev: 'warning', on: true, label: 'Same name within 30 m', test: (v, x) => x.dupNear.has(v.id) },
    { id: 'P_PUR', sev: 'warning', on: true, label: 'Pending update request / not yet approved', test: v => v.approved === false || (v.venueUpdateRequests || []).length > 0 },
    { id: 'P_NO_CONTACT', sev: 'note', on: false, label: 'No phone and no website', test: v => plain(v) && !(v.phone || '').trim() && !(v.url || '').trim() },
    { id: 'P_NO_HOURS', sev: 'note', on: false, label: 'No opening hours', test: v => plain(v) && !(v.openingHours || []).length },
    { id: 'P_OLD_IMAGE', sev: 'note', on: false, label: 'No photo, or newest photo is old (years in panel)',
      test: v => { if (!plain(v)) return false; const t = (v.images || []).map(imgTime).filter(Number.isFinite); return !t.length || Date.now() - Math.max(...t) > state.staleYears * 365 * 864e5; } },
  ];
  const PRULE_BY_ID = Object.fromEntries(PRULES.map(r => [r.id, r]));
  PRULES.forEach(r => { state.pRules[r.id] = r.on; });

  // ---- custom place checks: you pick a field, a test (regex / empty) and a severity; saved in this browser
  const PCUSTOM_KEY = 'wme-segment-validator:place-custom:v1';
  const CFIELDS = [['name', 'Name'], ['aliases', 'Alternate names'], ['houseNumber', 'House number'], ['street', 'Street'], ['city', 'City'], ['state', 'State'],
    ['full', 'Full address (street, number, city, state)'], ['phone', 'Phone'], ['url', 'Website'], ['categories', 'Categories'], ['description', 'Description']];
  const COPS = [['matches', 'matches the pattern (flag it)'], ['nomatch', 'has a value that does NOT match (wrong format)'], ['empty', 'is empty'], ['notempty', 'is not empty']];
  const CPRESETS = [
    ['', 'Presets...'],
    ['House number is not like 12, 12A, 12-14, 1/4A', 'houseNumber', 'nomatch', '^[A-Za-z]?\\d+[A-Za-z]?([-/][A-Za-z]?\\d+[A-Za-z]?)*$', 'warning'],
    ['Phone not in a normal format', 'phone', 'nomatch', '^\\+?[\\d\\s()-]{7,18}$', 'note'],
    ['Website does not start with http', 'url', 'nomatch', '^https?://', 'note'],
    ['Name ends with punctuation', 'name', 'matches', '[.,;:\\-/]\\s*$', 'note'],
    ['Name contains a phone number', 'name', 'matches', '\\d{8,}', 'warning'],
    ['Name says closed / permanently', 'name', 'matches', 'closed|permanent|tutup', 'warning'],
    ['Name has two spaces or odd symbols', 'name', 'matches', '\\s{2,}|[_*#@|~^<>]', 'note'],
    ['Street name has no letters', 'street', 'matches', '^[^A-Za-z\\u00C0-\\uFFFF]+$', 'warning'],
  ];
  const ADDR_FIELDS = new Set(['houseNumber', 'street', 'city', 'state', 'full']);
  function cfieldValue(v, x, f) {
    const a = (x && x.addr) || {};
    switch (f) {
      case 'name': return v.name || '';
      case 'aliases': return (v.aliases || []).join(' | ');
      case 'houseNumber': return a.houseNumber == null ? '' : String(a.houseNumber);
      case 'street': return addrName(a.street);
      case 'city': return addrName(a.city);
      case 'state': return addrName(a.state);
      case 'full': return [addrName(a.street), a.houseNumber == null ? '' : String(a.houseNumber), addrName(a.city), addrName(a.state)].filter(Boolean).join(', ');
      case 'phone': return v.phone || '';
      case 'url': return v.url || '';
      case 'categories': return (v.categories || []).join(', ');
      case 'description': return v.description || '';
      default: return '';
    }
  }
  function compileCustom(c) {                      // returns a rule object, throws when the regex is bad
    const needsRe = c.op === 'matches' || c.op === 'nomatch';
    const re = needsRe ? new RegExp(c.pattern, c.caseSensitive ? '' : 'i') : null;
    return {
      id: c.id, custom: true, sev: c.sev, on: true, label: c.label, needAddr: ADDR_FIELDS.has(c.field),
      test: (v, x) => {
        const val = String(cfieldValue(v, x, c.field)).trim();
        switch (c.op) {
          case 'matches': return !!val && re.test(val);
          case 'nomatch': return !!val && !re.test(val);
          case 'empty': return !val && plain(v);
          case 'notempty': return !!val;
          default: return false;
        }
      },
    };
  }
  let customRules = [];
  function rebuildCustom() {
    for (const id of Object.keys(PRULE_BY_ID)) if (id.startsWith('C_')) delete PRULE_BY_ID[id];
    customRules = [];
    for (const c of state.pCustom) {
      try { const r = compileCustom(c); customRules.push(r); PRULE_BY_ID[r.id] = r; if (typeof state.pRules[r.id] !== 'boolean') state.pRules[r.id] = c.on !== false; }
      catch (e) { warnOnce('custom-' + c.id, e); }
    }
  }
  const allPRules = () => [...PRULES, ...customRules];

  // ------------------------------------------------ remembered settings (per browser, localStorage)
  const SETTINGS_KEY = 'wme-segment-validator:settings:v1';
  const POLY_KEY = 'wme-segment-validator:polygons:v1';
  const RESULTS_KEY = 'wme-segment-validator:results:v1';
  const PTAGS_KEY = 'wme-segment-validator:place-tags:v1';   // places you marked checked / closed / moved   // swept sections + issues found, kept across reloads
  const PERSIST = ['enabled', 'autoMove', 'highlightOnly', 'autoSave', 'accumulate', 'loadMP', 'limitToViewport', 'abbrevPattern',
    'extraWidth', 'nearMissM', 'layerOpacity', 'filterSev', 'filterRule', 'sortBy', 'hideVisited', 'zoomTo', 'selectOnJump', 'sweepZoom', 'bgEnabled', 'showSections', 'skipDone', 'placesOn', 'uiTab', 'pHideChecked', 'pSev', 'pRuleF', 'pMark', 'pSort', 'staleYears', 'mpHidden'];
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
      state.mpHidden = Array.isArray(state.mpHidden) ? state.mpHidden.filter(x => typeof x === 'string') : [];
      if (sv.rules && typeof sv.rules === 'object') for (const id of Object.keys(state.rules)) if (typeof sv.rules[id] === 'boolean') state.rules[id] = sv.rules[id];
      const cu = kv.get(PCUSTOM_KEY);
      if (Array.isArray(cu)) state.pCustom = cu.filter(c => c && typeof c.id === 'string' && c.id.startsWith('C_') && typeof c.label === 'string' && typeof c.pattern === 'string' && CFIELDS.some(f => f[0] === c.field) && COPS.some(o => o[0] === c.op));
      rebuildCustom();
      if (sv.pRules && typeof sv.pRules === 'object') for (const id of Object.keys(state.pRules)) if (typeof sv.pRules[id] === 'boolean') state.pRules[id] = sv.pRules[id];
      if (sv.collapsed && typeof sv.collapsed === 'object') state.collapsed = sv.collapsed;
      if (sv.open && typeof sv.open === 'object') state.open = sv.open;
      if (typeof sv.areaKey === 'string') savedAreaKey = sv.areaKey;
      if (sv.cap && typeof sv.cap === 'object') { cap.on = !!sv.cap.on; cap.verbose = !!sv.cap.verbose; }
    }
    rebuildCustom();
    if (!['all', 'error', 'warning', 'note'].includes(state.pSev)) state.pSev = 'all';
    if (!['all', 'unmarked', 'checked', 'closed', 'moved'].includes(state.pMark)) state.pMark = 'all';
    if (!['sev', 'name', 'issues'].includes(state.pSort)) state.pSort = 'sev';
    if (state.pHideChecked && state.pMark === 'all') state.pMark = 'unmarked';
    state.pHideChecked = false;
    if (state.pRuleF !== 'all' && !PRULE_BY_ID[state.pRuleF]) state.pRuleF = 'all';
    if (!['all', 'error', 'warning', 'note'].includes(state.filterSev)) state.filterSev = 'all';
    if (state.filterRule !== 'all' && !RULE_BY_ID[state.filterRule]) state.filterRule = 'all';
    if (!['severity', 'distance', 'id'].includes(state.sortBy)) state.sortBy = 'severity';
    if (!['roads', 'places'].includes(state.uiTab)) state.uiTab = 'roads';
    state.staleYears = Math.min(30, Math.max(1, Number(state.staleYears) || 3));
    const pt = kv.get(PTAGS_KEY); if (pt && typeof pt === 'object') state.placeTags = pt;
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
    const out = { v: 1, rules: state.rules, pRules: state.pRules, collapsed: state.collapsed, open: state.open, cap: { on: cap.on, verbose: cap.verbose },
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

  const NAME_RULES = new Set(['NO_NAME', 'NO_CITY', 'NO_STATE', 'LOWERCASE', 'ABBREV', 'EMPTY_ALT', 'NAME_ROUNDABOUT', 'CLOSED_NAME', 'CITY_RAIL_FWY']);
  const NEIGHBOUR_RULE = r => (r.cat === 'topology' && r.id !== 'LOOP' && r.id !== 'LOOP_SELF') || r.cat === 'continuity' || r.id === 'MEDIAN_UTURN';
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
    if (state.rules.NO_NAME || state.rules.NO_CITY || state.rules.NO_STATE) await addressPass(cands, out);
    if (state.rules.MEDIAN_UTURN) await medianTurnPass(cands, ctx, out);
    if (state.rules.UTURN_DEAD_END) await uturnPass(cands, ctx, out);
    if (state.rules.BDP) await bdpPass(cands, ctx, out);
    if (state.rules.BC_NOT_STRAIGHT || state.rules.BC_TIE) await bestContPass(cands, ctx, out);
    if (state.rules.LOCKED_ABOVE_RANK) await permissionPass(cands, out);
    return out;
  }

  async function pool(items, limit, fn) {            // run fn over items with at most `limit` calls in flight
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) { const k = i++; try { await fn(items[k], k); } catch (e) { warnOnce('pool', e); } }
    }));
  }
  let addrLogged = false;
  async function addressPass(cands, out) {          // WME's own resolved address is the final word on missing name / city / state
    const todo = cands.filter(s => { const h = out.get(s.id); return h && (h.includes('NO_NAME') || h.includes('NO_CITY') || h.includes('NO_STATE')); });
    await pool(todo, 8, async s => {
      try {
        const a = await sdk.DataModel.Segments.getAddress({ segmentId: s.id });
        if (!addrLogged) { addrLogged = true; log.info(`getAddress sample: ${fmt(a).slice(0, 600)}`); }
        const nm = a && ((a.street && a.street.name) || a.streetName);
        const ct = a && ((a.city && a.city.name) || a.cityName);
        const stt = a && ((a.state && a.state.name) || a.stateName);
        let hits = out.get(s.id);
        if (nm) hits = hits.filter(x => x !== 'NO_NAME');
        if (ct) hits = hits.filter(x => x !== 'NO_CITY');
        if (stt) hits = hits.filter(x => x !== 'NO_STATE');
        out.set(s.id, hits);
      } catch (e) { warnOnce('getAddress', e); }
    });
  }
  async function medianTurnPass(cands, ctx, out) {  // keep a median U-turn flag only if WME says both turns are really allowed (a blocked turn means no U-turn anyway)
    const T = sdk.DataModel.Turns;
    if (!T || typeof T.isTurnAllowed !== 'function') return warnOnce('median-turns', 'Turns.isTurnAllowed missing: median U-turn flags are not filtered by turn permissions');
    const todo = cands.filter(s => (out.get(s.id) || []).includes('MEDIAN_UTURN'));
    await pool(todo, 8, async s => {
      let allowed = false, known = false;
      for (const t of medianTriples(s, ctx)) {
        try {
          const r1 = await T.isTurnAllowed({ fromSegmentId: t.aId, nodeId: t.n1, toSegmentId: s.id });
          const r2 = await T.isTurnAllowed({ fromSegmentId: s.id, nodeId: t.n2, toSegmentId: t.kId });
          known = true;
          if (r1 && r2) { allowed = true; break; }
        } catch (e) { warnOnce('median-turns-call', e); allowed = true; break; }   // could not ask: keep the flag
      }
      if (known && !allowed) out.set(s.id, out.get(s.id).filter(x => x !== 'MEDIAN_UTURN'));
    });
  }
  // ---- Big Detour Prevention (see Waze 'Detour Prevention Mechanisms'): leave a highway onto 2+ segments of another road type group,
  // rejoin the same highway (same street name) within 5 km (Freeway / Major Highway) or 500 m (Minor Highway), while a direct route
  // with the same road type and street name exists. The detour segments are flagged. Freeway and Major Highway are treated as one group.
  const BDP_GROUP = t => (t === 3 || t === 6 ? 'major' : t === 7 ? 'minor' : null);
  const BDP_LIMIT = { major: 5000, minor: 500 };
  const otherEnd = (s, n) => (s.fromNodeId === n ? s.toNodeId : s.fromNodeId);
  async function bdpPass(cands, ctx, out) {
    const raw = [];
    for (const b1 of ctx.seg.values()) {
      const g = BDP_GROUP(b1.roadType);
      if (!g || !b1.isDrivable || raw.length > 300) continue;
      const limit = BDP_LIMIT[g];
      for (const n1 of new Set(ends(b1))) {
        if (n1 == null || !arrives(b1, n1)) continue;
        const walk = (path, len, node) => {
          const last = path[path.length - 1];
          for (const u of others(ctx, last, node)) {
            if (!u.isDrivable || !leaves(u, node) || u.id === b1.id) continue;
            if (BDP_GROUP(u.roadType) === g) {
              if (path.length >= 2 && node !== n1) raw.push({ b1, b2: u, n1, n2: node, path: path.slice(), g });
            } else if (len + u.length < limit && path.length < 8 && !path.some(p => p.id === u.id) && otherEnd(u, node) != null) {
              walk(path.concat(u), len + u.length, otherEnd(u, node));
            }
          }
        };
        for (const t of others(ctx, b1, n1)) {
          if (!t.isDrivable || !leaves(t, n1) || BDP_GROUP(t.roadType) === g || t.length >= limit || otherEnd(t, n1) == null) continue;
          walk([t], t.length, otherEnd(t, n1));
        }
      }
    }
    if (!raw.length) return;
    const ids = new Set();                              // street names of the highway segments and detour ends: only these are needed
    const addIds = x => { if (x.primaryStreetId != null) ids.add(x.primaryStreetId); (x.alternateStreetIds || []).forEach(i => ids.add(i)); };
    for (const x of ctx.seg.values()) if (x.isDrivable && BDP_GROUP(x.roadType)) addIds(x);
    raw.forEach(r => r.path.forEach(addIds));
    const missing = new Set([...ids].filter(i => !ctx.streets.has(i)));
    if (missing.size) (await loadById(sdk.DataModel.Streets, 'streetId', missing)).forEach((v, k) => ctx.streets.set(k, v));
    const namesOf = x => {
      const set = new Set();
      for (const i of [x.primaryStreetId, ...(x.alternateStreetIds || [])]) { const st = i == null ? null : ctx.streets.get(i); const nm = st && st.name ? st.name.trim().toLowerCase() : ''; if (nm) set.add(nm); }
      return set;
    };
    const share = (a, b) => { const A = namesOf(a), B = namesOf(b); for (const n of A) if (B.has(n)) return true; return false; };
    let found = 0;
    for (const r of raw) {
      if (!share(r.b1, r.b2)) continue;                 // bracketing segments must share a street name
      if (share(r.path[r.path.length - 1], r.b2)) continue;   // last detour segment must NOT share a name with the 2nd bracketing segment
      const skip = new Set(r.path.map(x => x.id)); skip.add(r.b1.id);
      const seen = new Set([r.n1]); let frontier = [r.n1], direct = false;
      for (let d = 0; d < 40 && frontier.length && !direct; d++) {   // direct route: same road type group + shared street name all the way
        const next = [];
        for (const nd of frontier) for (const x of at(ctx, nd)) {
          if (skip.has(x.id) || !x.isDrivable || BDP_GROUP(x.roadType) !== r.g || !leaves(x, nd) || !share(x, r.b1)) continue;
          const f = otherEnd(x, nd);
          if (f === r.n2) { direct = true; break; }
          if (f != null && !seen.has(f)) { seen.add(f); next.push(f); }
        }
        frontier = next;
      }
      if (!direct) continue;
      found++;
      for (const x of r.path) { const h = out.get(x.id); if (h && !h.includes('BDP')) h.push('BDP'); }
    }
    if (found) log.info(`BDP: ${found} preventable detour(s) found`);
  }
  // ---- Best continuation at a split (Waze 'Interactive junction instruction algorithm'): when the turn angle is under ~45 degrees the
  // outgoing branch that matches the incoming road best gets no instruction, the others get Keep. Preference: 1 primary name + type,
  // 2 alt name + type, 3 primary name (or primary-to-alt), 4 alt name, 5 type. City names are ignored; two unnamed segments count as the same name.
  async function bestContPass(cands, ctx, out) {
    const nodes = new Set();
    for (const x of cands) if (x.isDrivable) for (const n of ends(x)) if (n != null && at(ctx, n).length >= 3) nodes.add(n);
    const raw = [], ids = new Set();
    const addIds = x => { if (x.primaryStreetId != null) ids.add(x.primaryStreetId); (x.alternateStreetIds || []).forEach(i => ids.add(i)); };
    for (const n of nodes) {
      for (const o of at(ctx, n)) {
        if (!o.isDrivable || !arrives(o, n) || o.geometry.coordinates.length < 2 || !neighboursLoaded(o, ctx)) continue;
        const inHead = bearingAway(o, n) + 180;
        const fork = [];
        for (const d of others(ctx, o, n)) {
          if (!d.isDrivable || !leaves(d, n) || d.geometry.coordinates.length < 2 || (d.elevationLevel ?? 0) !== (o.elevationLevel ?? 0)) continue;
          const a = norm180(bearingAway(d, n) - inHead);
          if (Math.abs(a) < 45) fork.push({ d, a: Math.abs(a) });
        }
        if (fork.length >= 2) { raw.push({ o, fork }); addIds(o); fork.forEach(f => addIds(f.d)); }
      }
    }
    if (!raw.length) return;
    const missing = new Set([...ids].filter(i => !ctx.streets.has(i)));
    if (missing.size) (await loadById(sdk.DataModel.Streets, 'streetId', missing)).forEach((v, k) => ctx.streets.set(k, v));
    const nm = i => { const st = i == null ? null : ctx.streets.get(i); return st && st.name ? st.name.trim().toLowerCase() : ''; };
    const prim = x => nm(x.primaryStreetId);
    const alts = x => new Set((x.alternateStreetIds || []).map(nm).filter(Boolean));
    const score = (o, x) => {
      const po = prim(o), px = prim(x), ao = alts(o), ax = alts(x);
      const sameP = po === px, type = o.roadType === x.roadType;
      const altM = [...ao].some(v => ax.has(v));
      const cross = (px && ao.has(px)) || (po && ax.has(po));
      if (sameP && type) return 5;
      if (altM && type) return 4;
      if (sameP || cross) return 3;
      if (altM) return 2;
      return type ? 1 : 0;
    };
    let nTie = 0, nStr = 0;
    const mark = (x, id) => { const h = out.get(x.id); if (h && !h.includes(id)) h.push(id); };
    for (const { o, fork } of raw) {
      const sc = fork.map(f => ({ ...f, s: score(o, f.d) }));
      const best = Math.max(...sc.map(f => f.s));
      const top = sc.filter(f => f.s === best);
      if (top.length >= 2) {
        if (state.rules.BC_TIE && best >= 3 && prim(o)) { nTie++; top.forEach(f => mark(f.d, 'BC_TIE')); }
        continue;
      }
      const w = top[0], straighter = sc.find(f => f !== w && f.a < w.a - 10);
      if (state.rules.BC_NOT_STRAIGHT && straighter) { nStr++; mark(w.d, 'BC_NOT_STRAIGHT'); }
    }
    if (nTie || nStr) log.info(`best continuation: ${nStr} not-straightest, ${nTie} tied splits`);
  }
  async function permissionPass(cands, out) {
    await pool(cands, 10, async s => {
      try {
        const ok = await sdk.DataModel.Segments.hasPermissions({ segmentId: s.id });
        if (!ok) out.get(s.id).push('LOCKED_ABOVE_RANK');
      } catch (e) { /* ignore */ }
    });
  }
  async function uturnPass(cands, ctx, out) {       // needs Turns.getTurnsFromSegment (checked in diagnostics)
    const T = sdk.DataModel.Turns;
    if (!T || typeof T.getTurnsFromSegment !== 'function') return warnOnce('uturn', 'Turns.getTurnsFromSegment missing');
    const loose = cands.filter(s => s.isDrivable && neighboursLoaded(s, ctx) && (at(ctx, s.fromNodeId).length === 1 || at(ctx, s.toNodeId).length === 1));
    await pool(loose, 8, async s => {
      try {
        const turns = await T.getTurnsFromSegment({ segmentId: s.id });
        const deadFwd = at(ctx, s.toNodeId).length === 1, deadRev = at(ctx, s.fromNodeId).length === 1;
        if (turns.some(t => t.isUTurn && t.isAllowed && t.toSegmentId === s.id && ((t.fromSegmentFwd && deadFwd) || (!t.fromSegmentFwd && deadRev)))) out.get(s.id).push('UTURN_DEAD_END');
      } catch (e) { warnOnce('uturn-call', e); }
    });
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
      if (!state.skipDone) { state.store.clear(); state.pstore.clear(); }
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
      log.info(`scan deferred: map still loading (retry ${Math.min(retries + 1, MAX_RETRIES)}/${MAX_RETRIES})`);
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
      const sel = await selectCandidates(all, extent);
      if (mine !== token) return;
      ui.scopeNote.textContent = sel.note || '';
      if (sel.empty) return setStatus('That area is not available. Pick another, or import a polygon.');
      if (!state.accumulate) state.store.clear();
      if (!RULES.some(r => state.rules[r.id])) { state.store.clear(); await refreshView(); return setStatus('No rules ticked.'); }
      const ctx = await buildContext(all, sel.cands);
      if (mine !== token) return;
      const out = await evaluate(sel.cands, ctx);
      if (mine !== token) return;
      commit(sel.cands, out);
      await refreshView();
      const sk = state.skip || {};
      const skipTxt = (sk.nb || sk.nm) ? ` \u00B7 skipped ${sk.nb ? `${sk.nb} neighbours-not-loaded` : ''}${sk.nb && sk.nm ? ', ' : ''}${sk.nm ? `${sk.nm} names-not-loaded` : ''}` : '';
      let outsideTxt = '';
      if (state.scope === 'area' && !sel.cands.length) {
        const ar = areasForKey();
        if (ar.length && !ar.some(a => extent[2] >= a.bbox[0] && extent[0] <= a.bbox[2] && extent[3] >= a.bbox[1] && extent[1] <= a.bbox[3])) outsideTxt = ' \u00B7 the map is outside the selected area, nothing to scan here (pick Viewport to check this place)';
      }
      setStatus(`Scanned ${sel.cands.length}${skipTxt} \u00B7 ${state.view.length} issues${outsideTxt}`);
      log.info(`scan scope=${state.scope} limitViewport=${state.limitToViewport} loaded=${all.length} scanned=${sel.cands.length} shown=${state.view.length} rules=${RULES.filter(r => state.rules[r.id]).length}/${RULES.length} ${Math.round(performance.now() - t0)}ms skipped(neighbours=${state.skip ? state.skip.nb : 0},names=${state.skip ? state.skip.nm : 0}) top=${topRules()}`);
      if (state.placesOn) await scanPlaces(extent);
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
  const liveSegs = new Set(), liveNodes = new Set();
  let liveTimer = 0, liveBusy = false, liveAgain = false;
  function collectEdited(payload) {
    if (!editShapeLogged) { editShapeLogged = true; log.info(`wme-after-edit payload sample: ${fmt(payload).slice(0, 400)}`); }
    const list = (payload && (payload.affectedObjects || (payload.detail && payload.detail.affectedObjects))) || [];
    for (const o of list) {
      const type = String((o && (o.objectType ?? o.type)) ?? '').toLowerCase();
      const ids = [].concat(o.objectIds ?? o.ids ?? o.objectId ?? o.id ?? []).map(Number).filter(Number.isFinite);
      if (type.includes('node')) ids.forEach(i => liveNodes.add(i));
      if (type && !type.includes('segment')) continue;
      ids.forEach(i => { pending.add(i); liveSegs.add(i); });
    }
    scheduleLive();
  }
  // Re-check right after every edit (before saving), so a highlight clears as soon as the problem is fixed.
  function scheduleLive() {
    if (!state.enabled) return;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => liveRevalidate().catch(e => log.error('live revalidate failed', e)), 600);
  }
  async function liveRevalidate() {
    if (liveBusy) { liveAgain = true; return; }
    if (!state.enabled || state.sweeping) return;
    liveBusy = true;
    try {
      const segIds = [...liveSegs], nodeIds = [...liveNodes];
      liveSegs.clear(); liveNodes.clear();
      const all = await sdk.DataModel.Segments.getAll();
      const ctx = await buildContext(all);
      const targets = new Map();
      const add = s => { if (s) targets.set(s.id, s); };
      for (const id of segIds) { const s = ctx.seg.get(id); if (s) { add(s); ends(s).forEach(n => at(ctx, n).forEach(add)); } else state.store.delete(id); }
      for (const n of nodeIds) at(ctx, n).forEach(add);
      for (const id of [...state.store.keys()]) { const s = ctx.seg.get(id); if (s) add(s); else if (all.length) state.store.delete(id); }   // issues already listed: re-check them too
      const cands = [...targets.values()];
      if (cands.length) commit(cands, await evaluate(cands, ctx));
      await refreshView();
      setStatus(`Edit check: ${cands.length} segments re-validated \u00B7 ${state.view.length} issues`);
    } finally {
      liveBusy = false;
      if (liveAgain) { liveAgain = false; scheduleLive(); }
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
  function renderMpTypes() {
    if (!ui.mpTypes) return;
    const keys = [...new Set([...Object.keys(state.mpSeen), ...state.mpHidden])].sort();
    ui.mpTypes.textContent = '';
    if (!keys.length) ui.mpTypes.append(h('div', { textContent: 'Types appear here after the first scan that sees map problems.', style: 'font-size:12px;color:#777' }));
    for (const k of keys) {
      const cb = h('input', { type: 'checkbox', checked: !mpHide(k) });
      cb.onchange = () => { state.mpHidden = cb.checked ? state.mpHidden.filter(x => x !== k) : [...new Set([...state.mpHidden, k])]; persistSoon(); renderMp(); run(); };
      ui.mpTypes.append(h('label', { style: 'display:block;font-size:12px' }, cb, ' ' + k.charAt(0).toUpperCase() + k.slice(1)));
    }
  }
  async function renderMp() {
    const pts = [...bg.points.values()].filter(o => !mpHide(mpKey(mpName(o))));
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
        style: 'padding:3px 4px;border-left:6px solid #E00;border-bottom:1px solid #eee;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis' });
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
                if (areas.some(a => polygonContains(c, a.geometry))) { bg.points.set(o.id, { id: o.id, lon: c[0], lat: c[1], subType: o.subType, type: o.type }); mpSeenNote(mpKey(mpName(o))); }
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
        mk('td', {}, mk('span', { className: 'sev', textContent: r.severity, style: `background:${sevKey ? PALETTE[sevKey] : '#E00'}` })),
        mk('td', { textContent: r.segment_id }), mk('td', { textContent: r.issues }), mk('td', { textContent: r.road_type }),
        mk('td', { textContent: `${r.lon}, ${r.lat}` }));
      if (r.e) tr.onclick = () => goTo(r.e);
      frag.append(tr);
    }
    body.append(frag);
  }

  // ------------------------------------------------------------ places: scan, list, map
  const PLACE_LAYER = 'segment-validator-places';
  const setPStatus = t => { if (ui.pStatus) ui.pStatus.textContent = t; };
  const addrCache = new Map();                      // venueId -> { t, a }: addresses are read one by one, so keep them for a while
  async function placeAddress(id) {
    const c = addrCache.get(id);
    if (c && Date.now() - c.t < 120000) return c.a;
    const a = await sdk.DataModel.Venues.getAddress({ venueId: String(id) });
    addrCache.set(id, { t: Date.now(), a });
    return a;
  }
  let ptoken = 0, extLogged = false;
  async function scanPlaces(extentArg) {
    if (!state.placesOn) return;
    const mine = ++ptoken;
    setPStatus('Scanning places...');
    try {
      const extent = extentArg || await sdk.Map.getMapExtent();
      const all = await sdk.DataModel.Venues.getAll();
      if (mine !== ptoken) return;
      if (!all.length) return setPStatus('No places loaded here. Zoom in or pan.');
      const inView = v => { const m = placeMid(v); return !!m && m[0] >= extent[0] && m[0] <= extent[2] && m[1] >= extent[1] && m[1] <= extent[3]; };
      let cands;
      if (state.scope === 'viewport') cands = all.filter(inView);
      else {
        const areas = areasForKey();
        if (!areas.length) return setPStatus('That area is not available. Pick another, or import a polygon.');
        cands = (state.limitToViewport ? all.filter(inView) : all).filter(v => {
          const m = placeMid(v);
          return !!m && areas.some(a => m[0] >= a.bbox[0] && m[0] <= a.bbox[2] && m[1] >= a.bbox[1] && m[1] <= a.bbox[3] && polygonContains(m, a.geometry));
        });
      }
      const rules = allPRules().filter(r => state.pRules[r.id]);
      if (!rules.length) { state.pstore.clear(); await renderPlaces(); return setPStatus('No place rules ticked.'); }
      if (!state.accumulate) state.pstore.clear();
      if (!extLogged) { const w = all.find(v => (v.externalProviderIds || []).length); if (w) { extLogged = true; log.info(`place sample: externalProviderIds=${fmt(w.externalProviderIds).slice(0, 200)} images=${fmt((w.images || []).slice(0, 1)).slice(0, 200)}`); } }
      const addrs = new Map();
      if (rules.some(r => r.needAddr)) {
        await pool(cands, 8, async v => { try { addrs.set(v.id, await placeAddress(v.id)); } catch (e) { warnOnce('venue-address', e); } });
        if (mine !== ptoken) return;
      }
      const dupLink = new Set(), dupNear = new Set();
      if (state.pRules.P_DUP_LINK) {
        const by = new Map();
        for (const v of all) for (const e of v.externalProviderIds || []) { if (!by.has(e)) by.set(e, []); by.get(e).push(v.id); }
        for (const ids of by.values()) if (ids.length > 1) ids.forEach(i => dupLink.add(i));
      }
      if (state.pRules.P_DUP_NEAR) {
        const by = new Map();
        for (const v of all) { const n = normName(v.name); if (n && !v.isResidential) { if (!by.has(n)) by.set(n, []); by.get(n).push(v); } }
        for (const g of by.values()) {
          if (g.length < 2) continue;
          for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
            const a = placeMid(g[i]), b = placeMid(g[j]);
            if (a && b && distM({ lon: a[0], lat: a[1] }, b) < 30) { dupNear.add(g[i].id); dupNear.add(g[j].id); }
          }
        }
      }
      for (const v of cands) {
        const m = placeMid(v);
        if (!m) continue;
        const x = { addr: addrs.get(v.id), dupLink, dupNear };
        const hits = [];
        for (const r of rules) {
          if (r.needAddr && !x.addr) continue;
          try { if (r.test(v, x)) hits.push(r.id); } catch (e) { warnOnce(r.id, e); }
        }
        if (hits.length) state.pstore.set(v.id, { id: v.id, mid: m, name: (v.name || '').trim(), exts: v.externalProviderIds || [], hits });
        else state.pstore.delete(v.id);
      }
      await renderPlaces();
      setPStatus(`Scanned ${cands.length} places · ${state.pview.length} with issues`);
    } catch (e) { log.error('place scan failed', e); setPStatus('Place scan error, copy the debug log'); }
  }
  function visiblePlaces(skipRule) {
    let a = [];
    for (const e of state.pstore.values()) {
      const vis = e.hits.filter(id => state.pRules[id] && PRULE_BY_ID[id]);
      if (!vis.length) continue;
      a.push({ ...e, vis, sev: vis.reduce((w, id) => (RANK[TIER[PRULE_BY_ID[id].sev]] > RANK[w] ? TIER[PRULE_BY_ID[id].sev] : w), 'note') });
    }
    if (state.scope === 'area') {
      const areas = areasForKey();
      a = a.filter(e => areas.some(ar => e.mid[0] >= ar.bbox[0] && e.mid[0] <= ar.bbox[2] && e.mid[1] >= ar.bbox[1] && e.mid[1] <= ar.bbox[3] && polygonContains(e.mid, ar.geometry)));
    }
    if (state.pSev !== 'all') a = a.filter(e => e.sev === state.pSev);
    if (state.pMark === 'unmarked') a = a.filter(e => !state.placeTags[e.id]);
    else if (state.pMark !== 'all') a = a.filter(e => state.placeTags[e.id] === state.pMark);
    const q = (state.pQ || '').trim().toLowerCase();
    if (q) a = a.filter(e => `${e.name} ${e.id}`.toLowerCase().includes(q));
    if (!skipRule && state.pRuleF !== 'all') a = a.filter(e => e.vis.includes(state.pRuleF));
    if (state.pSort === 'name') a.sort((x, y) => String(x.name).localeCompare(String(y.name)));
    else if (state.pSort === 'issues') a.sort((x, y) => y.vis.length - x.vis.length || RANK[y.sev] - RANK[x.sev] || String(x.name).localeCompare(String(y.name)));
    else a.sort((x, y) => RANK[y.sev] - RANK[x.sev] || String(x.name).localeCompare(String(y.name)));
    return a;
  }
  function googleLinkFor(e) {                        // opens Google Maps so YOU can look at reviews and recent photos; nothing is copied
    const q = encodeURIComponent(e.name || `${e.mid[1]},${e.mid[0]}`);
    const m = (e.exts || []).join(' ').match(/ChIJ[\w-]{10,}/);
    if (m) return `https://www.google.com/maps/search/?api=1&query=${q}&query_place_id=${encodeURIComponent(m[0])}`;
    return `https://www.google.com/maps/search/${q}/@${e.mid[1].toFixed(6)},${e.mid[0].toFixed(6)},19z`;
  }
  const TAG_ORDER = [undefined, 'checked', 'closed', 'moved'];
  function cycleTag(id) {
    const cur = state.placeTags[id];
    const next = TAG_ORDER[(TAG_ORDER.indexOf(cur) + 1) % TAG_ORDER.length];
    if (next) state.placeTags[id] = next; else delete state.placeTags[id];
    kv.set(PTAGS_KEY, state.placeTags);
    return renderPlaces();
  }
  async function renderPlaces() {
    state.pview = visiblePlaces();
    try {
      await sdk.Map.removeAllFeaturesFromLayer({ layerName: PLACE_LAYER });
      if (state.placesOn && state.pview.length) await sdk.Map.addFeaturesToLayer({ layerName: PLACE_LAYER, features: state.pview.slice(0, 3000).map(e => ({
        type: 'Feature', id: `pl-${e.id}`, geometry: { type: 'Point', coordinates: e.mid },
        properties: { sev: e.sev, tag: state.placeTags[e.id] || '', cur: e.id === state.pCur, tip: `${e.name || '(no name)'}: ${e.vis.map(id => PRULE_BY_ID[id].label).join('; ')}` } })) });
    } catch (err) { warnOnce('place-draw', err); }
    renderPlaceList();
  }
  const SEVWORD = { error: 'Error', warning: 'Warning', note: 'Note' };
  const pOpen = new Set();                           // place ids whose issue tags are expanded
  let pAllOpen = false;
  function renderPlaceList() {
    if (!ui.pList) return;
    const v = state.pview, n = sev => v.filter(e => e.sev === sev).length;
    const marked = k => v.filter(e => state.placeTags[e.id] === k).length;
    ui.pPos.textContent = `${v.length} places shown · ${n('error')} errors · ${n('warning')} warnings · ${n('note')} notes · marked: ${marked('checked')} checked, ${marked('closed')} closed, ${marked('moved')} moved`;
    refreshPlaceRuleFilter();
    const keep = ui.pList.scrollTop;
    ui.pList.textContent = '';
    const icons = { checked: '✓', closed: '✗', moved: '→' };
    if (!v.length) ui.pList.append(h('div', { textContent: state.pstore.size ? 'Nothing matches the filters above.' : 'No issues found (or not scanned yet).', style: 'padding:8px;color:#777' }));
    for (const e of v.slice(0, 300)) {
      const tag = state.placeTags[e.id];
      const row = h('div', { style: `padding:4px 6px;border-left:6px solid ${tag ? '#9e9e9e' : PALETTE[e.sev]};border-bottom:1px solid #ddd;cursor:pointer;` + (e.id === state.pCur ? 'background:#e3f2fd;' : '') + (tag ? 'opacity:.65;' : '') });
      const head = h('div', { style: 'display:flex;gap:4px;align-items:center' });
      const open = pAllOpen || pOpen.has(e.id);
      const arrow = h('button', { textContent: `${open ? '▾' : '▸'} ${e.vis.length}`, title: open ? 'Hide the issue tags' : 'Show the issue tags', style: `font-size:11px;padding:0 5px;color:#fff;background:${PALETTE[e.sev]};border:0;border-radius:3px;cursor:pointer` });
      arrow.onclick = ev => { ev.stopPropagation(); if (pAllOpen) { pAllOpen = false; v.forEach(x => { if (x.id !== e.id) pOpen.add(x.id); }); pOpen.delete(e.id); } else if (pOpen.has(e.id)) pOpen.delete(e.id); else pOpen.add(e.id); renderPlaceList(); };
      head.append(h('span', { textContent: `${icons[tag] || ''} ${e.name || '(no name)'}`, style: 'flex:1;font-weight:bold;word-break:break-word' }), arrow);
      const g = h('button', { textContent: 'G', title: 'Open in Google Maps to check reviews and recent photos', style: 'padding:0 5px' });
      g.onclick = ev => { ev.stopPropagation(); window.open(googleLinkFor(e), '_blank', 'noopener'); };
      const t = h('button', { textContent: tag ? `⚑ ${tag}` : '⚑', title: 'Mark: checked, closed, moved, then clear', style: 'padding:0 5px' });
      t.onclick = ev => { ev.stopPropagation(); cycleTag(e.id); };
      head.append(g, t);
      const issues = h('div', { style: 'margin-top:2px;display:flex;flex-wrap:wrap;gap:3px' });
      for (const id of e.vis) issues.append(h('span', { textContent: PRULE_BY_ID[id].label, title: PRULE_BY_ID[id].custom ? 'Custom check' : id, style: `font-size:11px;border:1px solid ${PALETTE[TIER[PRULE_BY_ID[id].sev]]};border-radius:3px;padding:0 4px;background:#fff` }));
      row.append(head);
      if (open) row.append(issues);
      row.onclick = () => goToPlace(e);
      ui.pList.append(row);
    }
    if (v.length > 300) ui.pList.append(h('div', { textContent: `Showing the first 300 of ${v.length}. Narrow with the filters, or Export CSV for all.`, style: 'padding:4px;color:#777' }));
    ui.pList.scrollTop = keep;
  }
  function refreshPlaceRuleFilter() {                // rule dropdown with live counts (counts ignore the rule filter itself)
    const sel = ui.pRuleSel;
    if (!sel) return;
    const base = visiblePlaces(true), cnt = {};
    base.forEach(e => e.vis.forEach(id => { cnt[id] = (cnt[id] || 0) + 1; }));
    sel.textContent = '';
    sel.append(new Option(`All rules (${base.length})`, 'all'));
    for (const r of allPRules()) if (state.pRules[r.id]) sel.append(new Option(`${r.custom ? '★ ' : ''}${r.label} (${cnt[r.id] || 0})`, r.id));
    if (![...sel.options].some(o => o.value === state.pRuleF)) state.pRuleF = 'all';
    sel.value = state.pRuleF;
  }
  async function goToPlace(e) {
    state.pCur = e.id;
    if (!state.highlightOnly) {
      try {
        const cur = await sdk.Map.getZoomLevel();
        await sdk.Map.setMapCenter({ lonLat: { lon: e.mid[0], lat: e.mid[1] }, zoomLevel: clampZoom(Math.max(cur, state.zoomTo)) });
      } catch (err) { log.warn('go to place', err); }
    }
    if (state.selectOnJump) {
      await waitMapIdle();
      try { await sdk.Editing.setSelection({ selection: { ids: [String(e.id)], objectType: 'venue' } }); }
      catch (err) { log.info('place selection not applied', err && err.message); }
    }
    await renderPlaces();
  }
  function exportPlacesCsv() {
    const rows = state.pview.map(e => {
      const u = new URL(permalinkFor(e.mid[0], e.mid[1], null)); u.searchParams.set('venues', String(e.id));
      return { place_id: e.id, name: e.name, severity: SEV_NAME[e.sev].replace(/s$/, ''), rule_ids: e.vis.join(' '), issues: e.vis.map(id => PRULE_BY_ID[id].label).join('; '),
        mark: state.placeTags[e.id] || '', lon: e.mid[0].toFixed(6), lat: e.mid[1].toFixed(6), google_link: googleLinkFor(e), editor_link: u.toString() };
    });
    if (!rows.length) return setPStatus('Nothing to export.');
    const cols = ['place_id', 'name', 'severity', 'rule_ids', 'issues', 'mark', 'lon', 'lat', 'google_link', 'editor_link'];
    const esc = v => { const t = String(v ?? ''); return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const d = new Date(), p2 = n => String(n).padStart(2, '0');
    const name = `place-validator-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.csv`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    setPStatus(`Exported ${rows.length} places to ${name}`);
  }
  async function probeSuggestions() {                // what does this editor's SDK give us for "edit suggestions"? (is anything Google-place related?)
    const ES = sdk.DataModel && sdk.DataModel.EditSuggestions;
    if (!ES || typeof ES.getAll !== 'function') { log.warn('probe: DataModel.EditSuggestions.getAll is missing'); return setPStatus('Probe: EditSuggestions is not available. See Debug log.'); }
    const all = await ES.getAll();
    const by = k => all.reduce((o, e) => { const t = String(e[k]); o[t] = (o[t] || 0) + 1; return o; }, {});
    log.info(`probe suggestions: total=${all.length} bySource=${JSON.stringify(by('source'))} byStatus=${JSON.stringify(by('status'))}`);
    const sample = all.find(e => e.source === 'GEO') || all[0];
    if (sample) {
      log.info(`probe sample (${sample.source}): ${fmt(sample).slice(0, 900)}`);
      try { log.info(`probe sample changes: ${fmt(await ES.getEditSuggestionChanges({ editSuggestionId: sample.id })).slice(0, 900)}`); } catch (e) { log.warn('probe changes failed', e); }
    }
    setPStatus(`Probe: ${all.length} edit suggestions. Open the Debug log (Roads tab) and copy it.`);
  }
  async function testCustom(c, out) {               // dry run on the places loaded in view; nothing is saved
    out.textContent = 'Testing...';
    let r;
    try { r = compileCustom(c); } catch (e) { out.textContent = `Bad pattern: ${e.message}`; return false; }
    const ext = await sdk.Map.getMapExtent();
    const all = (await sdk.DataModel.Venues.getAll()).filter(v => { const m = placeMid(v); return m && m[0] >= ext[0] && m[0] <= ext[2] && m[1] >= ext[1] && m[1] <= ext[3]; });
    const addrs = new Map();
    if (r.needAddr) await pool(all, 8, async v => { try { addrs.set(v.id, await placeAddress(v.id)); } catch (e) { warnOnce('venue-address', e); } });
    const hit = all.filter(v => { if (r.needAddr && !addrs.get(v.id)) return false; try { return r.test(v, { addr: addrs.get(v.id) }); } catch (e) { return false; } });
    out.textContent = `${hit.length} of ${all.length} places in view would be flagged` + (hit.length ? `: ${hit.slice(0, 5).map(v => v.name || '(no name)').join(' | ')}${hit.length > 5 ? ' ...' : ''}` : '');
    return true;
  }
  function buildPlacesUi() {
    ui.pStatus = h('div', { style: 'margin:4px 0;color:#555;font-size:12px;min-height:18px' });
    ui.pPos = h('div', { style: 'font-size:12px;margin-top:4px;color:#333' });
    ui.pList = h('div', { style: 'position:relative;height:380px;min-height:120px;resize:vertical;overflow:auto;font-size:12px;border:1px solid #ccc;margin-top:4px;background:#fafafa' });
    const rulesBox = rememberOpen(h('details', { style: 'margin-top:4px' }, h('summary', { textContent: 'Place rules', style: 'cursor:pointer;font-weight:bold' })), 'places:rules', false);
    const rulesList = h('div');
    const fillRules = () => {
      rulesList.textContent = '';
      for (const r of allPRules()) {
        const cb = h('input', { type: 'checkbox', checked: !!state.pRules[r.id] });
        cb.onchange = () => { state.pRules[r.id] = cb.checked; persistSoon(); if (cb.checked) scanPlaces(); else renderPlaces(); };
        rulesList.append(h('label', { style: 'display:block;font-size:12px' }, cb, ' ', h('span', { textContent: '● ', style: `color:${PALETTE[TIER[r.sev]]}` }), (r.custom ? '★ ' : '') + r.label));
        if (r.id === 'P_OLD_IMAGE') {
          const yrs = h('input', { type: 'number', min: 1, max: 30, step: 1, value: state.staleYears, style: 'width:44px' });
          yrs.onchange = () => { state.staleYears = Math.min(30, Math.max(1, Number(yrs.value) || 3)); yrs.value = state.staleYears; persistSoon(); if (state.pRules.P_OLD_IMAGE) scanPlaces(); };
          rulesList.append(h('div', { style: 'margin:2px 0 4px 18px;font-size:11px' }, 'Old after (years): ', yrs));
        }
      }
    };
    fillRules();
    rulesBox.append(rulesList);

    // ---- custom checks editor
    const cbox = rememberOpen(h('details', { style: 'margin-top:4px' }, h('summary', { textContent: 'Custom checks (regex)', style: 'cursor:pointer;font-weight:bold' })), 'places:custom', false);
    const clist = h('div', { style: 'margin:4px 0' });
    const fillCustom = () => {
      clist.textContent = '';
      if (!state.pCustom.length) clist.append(h('div', { textContent: 'None yet.', style: 'color:#777;font-size:12px' }));
      for (const c of state.pCustom) {
        const del = h('button', { textContent: '✕', title: 'Delete this check', style: 'padding:0 5px;margin-left:4px' });
        del.onclick = () => {
          state.pCustom = state.pCustom.filter(x => x.id !== c.id); delete state.pRules[c.id];
          kv.set(PCUSTOM_KEY, state.pCustom); persistSoon(); rebuildCustom(); fillRules(); fillCustom();
          for (const e of state.pstore.values()) e.hits = e.hits.filter(id => id !== c.id);
          renderPlaces();
        };
        const fl = (CFIELDS.find(f => f[0] === c.field) || [, c.field])[1];
        clist.append(h('div', { style: 'font-size:12px;border-bottom:1px solid #eee;padding:2px 0' },
          h('b', { textContent: `★ ${c.label}` }), del,
          h('div', { textContent: `${fl} ${(COPS.find(o => o[0] === c.op) || [, c.op])[1]}${c.pattern && (c.op === 'matches' || c.op === 'nomatch') ? ` /${c.pattern}/${c.caseSensitive ? '' : 'i'}` : ''} · ${SEVWORD[TIER[c.sev]]}`, style: 'color:#666;font-size:11px;word-break:break-all' })));
      }
    };
    fillCustom();
    const fLabel = h('input', { type: 'text', placeholder: 'Name of the check (shown in the list)', style: 'width:100%;box-sizing:border-box' });
    const fField = mkSelect(CFIELDS, 'name', () => {});
    const fOp = mkSelect(COPS, 'matches', () => { fPat.disabled = !(fOp.value === 'matches' || fOp.value === 'nomatch'); });
    const fPat = h('input', { type: 'text', placeholder: 'Regex, e.g. ^\\d+[A-Z]?$', style: 'width:100%;box-sizing:border-box;font-family:monospace' });
    const fSev = mkSelect([['warning', 'Warning'], ['error', 'Error'], ['note', 'Note']], 'warning', () => {});
    const fCase = h('input', { type: 'checkbox' });
    const fOut = h('div', { style: 'font-size:12px;color:#555;margin-top:3px;word-break:break-word;min-height:16px' });
    const fPre = mkSelect(CPRESETS.map((p, i) => [String(i), p[0]]), '0', i => {
      const p = CPRESETS[Number(i)];
      if (!p || !p[1]) return;
      fLabel.value = p[0]; fField.value = p[1]; fOp.value = p[2]; fPat.value = p[3]; fSev.value = p[4]; fPat.disabled = false; fOut.textContent = '';
      fPre.value = '0';
    });
    const readForm = () => ({ id: `C_${Date.now().toString(36)}`, label: fLabel.value.trim(), field: fField.value, op: fOp.value, pattern: fPat.value, sev: fSev.value, caseSensitive: fCase.checked, on: true });
    const validForm = c => {
      if (!c.label) { fOut.textContent = 'Give the check a name.'; return false; }
      if ((c.op === 'matches' || c.op === 'nomatch') && !c.pattern) { fOut.textContent = 'Enter a pattern.'; return false; }
      try { compileCustom(c); } catch (e) { fOut.textContent = `Bad pattern: ${e.message}`; return false; }
      return true;
    };
    cbox.append(clist,
      h('div', { textContent: 'Add a check', style: 'font-weight:bold;font-size:12px;margin-top:4px' }),
      fPre, h('div', { style: 'margin-top:3px' }, fLabel),
      h('div', { style: 'margin-top:3px;font-size:12px' }, 'If ', fField, ' ', fOp),
      h('div', { style: 'margin-top:3px' }, fPat),
      h('div', { style: 'margin-top:3px;font-size:12px' }, 'Severity ', fSev, ' ', h('label', {}, fCase, ' case sensitive')),
      h('div', { style: 'margin-top:4px' },
        mkBtn('Test on places in view', () => { const c = readForm(); if (!validForm(c)) return; testCustom(c, fOut).catch(e => { fOut.textContent = 'Test failed, see Debug log'; log.error('custom test', e); }); }), ' ',
        mkBtn('Add check', () => {
          const c = readForm();
          if (!validForm(c)) return;
          state.pCustom.push(c); state.pRules[c.id] = true;
          kv.set(PCUSTOM_KEY, state.pCustom); persistSoon(); rebuildCustom(); fillRules(); fillCustom();
          fOut.textContent = `Added "${c.label}".`; fLabel.value = ''; fPat.value = '';
          if (state.placesOn) scanPlaces(); else setPStatus('Check added. Tick "Check places" to use it.');
        }, { style: 'font-weight:bold' })),
      fOut,
      h('div', { textContent: 'Regex is JavaScript style. "Wrong format" ignores empty values; use "is empty" for missing ones. Custom checks run on the same scan and show with ★.', style: 'font-size:11px;color:#777;margin-top:3px' }));
    fPat.disabled = false;

    // ---- filters
    const fl = (label, el) => h('label', { style: 'display:inline-block;font-size:12px;margin:2px 8px 2px 0' }, label + ' ', el);
    const sevSel = mkSelect([['all', 'All'], ['error', 'Errors'], ['warning', 'Warnings'], ['note', 'Notes']], state.pSev, v => { state.pSev = v; persistSoon(); renderPlaces(); });
    ui.pRuleSel = h('select', { style: 'max-width:100%' });
    ui.pRuleSel.onchange = () => { state.pRuleF = ui.pRuleSel.value; persistSoon(); renderPlaces(); };
    const markSel = mkSelect([['all', 'All'], ['unmarked', 'Not marked yet'], ['checked', '✓ Checked'], ['closed', '✗ Closed'], ['moved', '→ Moved']], state.pMark, v => { state.pMark = v; persistSoon(); renderPlaces(); });
    const sortSel = mkSelect([['sev', 'Severity'], ['name', 'Name A-Z'], ['issues', 'Most issues']], state.pSort, v => { state.pSort = v; persistSoon(); renderPlaces(); });
    const q = h('input', { type: 'search', placeholder: 'Search name or ID', value: state.pQ, style: 'width:140px' });
    let qt = 0; q.oninput = () => { clearTimeout(qt); qt = setTimeout(() => { state.pQ = q.value; renderPlaces(); }, 250); };
    const reset = mkBtn('Reset filters', () => {
      state.pSev = 'all'; state.pRuleF = 'all'; state.pMark = 'all'; state.pSort = 'sev'; state.pQ = '';
      sevSel.value = 'all'; markSel.value = 'all'; sortSel.value = 'sev'; q.value = ''; persistSoon(); renderPlaces();
    });
    const filters = h('div', { style: 'margin-top:6px;padding:4px;border:1px solid #ddd;background:#fff' },
      h('div', { textContent: 'Filter the list (also filters the map dots)', style: 'font-weight:bold;font-size:12px' }),
      fl('Severity', sevSel), fl('Marked', markSel), fl('Sort', sortSel),
      h('div', {}, fl('Rule', ui.pRuleSel)), h('div', {}, q, ' ', reset, ' ',
        mkBtn('Expand all', () => { pAllOpen = true; renderPlaceList(); }), ' ', mkBtn('Collapse all', () => { pAllOpen = false; pOpen.clear(); renderPlaceList(); })));

    return h('div', {},
      mkCheck('Check places (adds a place scan to every scan and sweep)', state.placesOn, async v => {
        state.placesOn = v;
        if (v) await scanPlaces(); else { await sdk.Map.removeAllFeaturesFromLayer({ layerName: PLACE_LAYER }); setPStatus('Place check off'); }
      }),
      h('div', { style: 'font-size:11px;color:#777' }, 'Uses the Area chosen in the Roads tab. G opens Google Maps for you to look at reviews and photos; ⚑ marks a place checked, closed or moved.'),
      rulesBox, cbox,
      h('div', { style: 'margin-top:6px' }, mkBtn('Scan places', () => { if (!state.placesOn) return setPStatus('Tick "Check places" first.'); scanPlaces(); }, { style: 'font-weight:bold' }), ' ',
        mkBtn('Export CSV', exportPlacesCsv), ' ', mkBtn('Probe suggestions', () => probeSuggestions().catch(e => log.error('probe failed', e)), { title: 'Logs what the SDK offers as edit suggestions, for checking whether Google place suggestions are included' })),
      filters, ui.pStatus, ui.pPos, ui.pList);
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
    ui.splitKm = h('input', { type: 'number', min: 1, max: 100, step: 1, value: 5, style: 'width:48px' });
    ui.splitReplace = h('input', { type: 'checkbox', checked: true });
    const splitBtn = mkBtn('Split area', async () => {
      const km = Math.max(1, Number(ui.splitKm.value) || 5);
      const parents = areasForKey().filter(a => a && a.geometry && a.geometry.coordinates && a.geometry.coordinates[0]);
      if (!parents.length) return setStatus('Pick an area that has a border first (Imported / drawn).');
      const kids = [];
      parents.forEach(a => kids.push(...splitArea(a, km).kids));
      if (!kids.length) return setStatus('The area is smaller than one cell: nothing to split. Try a smaller size.');
      if (kids.length > 150 && !window.confirm(`This makes ${kids.length} cells. Continue?`)) return;
      const names = new Set(state.polygons.map(a => a.name));
      kids.forEach(k => { let n = k.name, i = 2; while (names.has(n)) n = `${k.name} (${i++})`; k.name = n; names.add(n); });
      if (ui.splitReplace.checked) state.polygons = state.polygons.filter(a => !parents.includes(a));
      const first = state.polygons.length;
      state.polygons.push(...kids);
      persistPolygons(); buildAreaSelect();
      await chooseArea(`custom:${first}`, true);
      setStatus(`Split into ${kids.length} cells of about ${km} km that follow the original border. Pick a cell or "All" in the Area list to sweep.`);
    });
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
    ui.bgBar = h('div', { style: 'height:6px;background:#e0e0e0;border-radius:3px;margin:4px 0;overflow:hidden' }, h('div', { style: 'height:6px;width:0;background:#E00' }));
    ui.bgStatus = h('div', { style: 'font-size:12px;color:#555' });
    ui.mpList = h('div', { style: 'position:relative;max-height:260px;overflow:auto;font-size:12px;border:1px solid #ddd;margin-top:4px' });
    const mpSection = section('Map problems, background (unofficial)', false,
      h('div', { style: 'font-size:11px;color:#b26a00' }, 'Uses WME\'s own feature service, not the SDK. It can stop working after any WME update. The map does not move.'),
      mkCheck('Enable this unofficial scan', state.bgEnabled, v => { state.bgEnabled = v; ui.bgBtn.disabled = !v; }),
      h('div', { style: 'margin-top:4px' }, ui.bgBtn, ' (uses the selected area, or the screen)'), ui.bgBar, ui.bgStatus, ui.mpList);
    root.addEventListener('change', persistSoon);
    root.addEventListener('input', persistSoon);
    const roadsPane = h('div');
    roadsPane.append(
      mkCheck('Enabled', state.enabled, async v => {
        state.enabled = v;
        for (const layerName of [LAYER, HALO_LAYER, SCOPE_LAYER, BORDER_LAYER, MP_LAYER, PLACE_LAYER]) await sdk.Map.setLayerVisibility({ layerName, visibility: v });
        if (v) run();
      }),
      h('div', { style: 'margin-top:4px' }, 'Area: ', ui.area), h('div', { style: 'margin-top:4px' }, drawBtn, ' ', importBtn, ' ', clearPolyBtn, ' ', ui.sweepBtn, ' ', ui.pauseBtn, ' ', ui.nudgeBtn, ' zoom ', ui.zoomSweep), ui.sweepBar, ui.file, ui.scopeNote,
      h('div', { style: 'margin-top:4px;font-size:12px' }, 'Split the selected area into cells of ', ui.splitKm, ' km ', splitBtn, ' ', h('label', {}, ui.splitReplace, ' replace the original')),
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
      (() => {
        ui.mpTypes = h('div');
        const box = rememberOpen(h('details', { style: 'margin:2px 0 4px 16px' }, h('summary', { textContent: 'Map problem types (tick = show)', style: 'cursor:pointer;font-size:12px' })), 'mp:types', false);
        box.append(h('div', { style: 'margin:3px 0' },
          mkBtn('Hide place-related', () => { const ks = Object.keys(state.mpSeen).filter(k => /place|venue|poi/.test(k)); state.mpHidden = [...new Set([...state.mpHidden, ...ks])]; persistSoon(); renderMpTypes(); renderMp(); run(); }), ' ',
          mkBtn('Show all', () => { state.mpHidden = []; persistSoon(); renderMpTypes(); renderMp(); run(); })), ui.mpTypes);
        renderMpTypes();
        return box;
      })(),
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
    const placesPane = buildPlacesUi();
    const tabs = h('div', { style: 'display:flex;gap:4px;margin:4px 0' });
    const tabBtns = {};
    const setTab = id => {
      state.uiTab = id;
      roadsPane.style.display = id === 'roads' ? '' : 'none';
      placesPane.style.display = id === 'places' ? '' : 'none';
      for (const k of Object.keys(tabBtns)) tabBtns[k].style.cssText = `flex:1;padding:3px 0;font-weight:bold;cursor:pointer;border:1px solid #888;border-radius:4px;${k === id ? 'background:#1e88e5;color:#fff;' : 'background:#f5f5f5;'}`;
      persistSoon();
    };
    for (const [id, label] of [['roads', 'Roads'], ['places', 'Places']]) { tabBtns[id] = h('button', { textContent: label }); tabBtns[id].onclick = () => setTab(id); tabs.append(tabBtns[id]); }
    root.append(h('b', { textContent: NAME }), tabs, roadsPane, placesPane);
    setTab(state.uiTab);
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
  // Automatic runs never leave the place you are working at: they only do a small local pan, and only when the map really is blank.
  // The jump to the selected area is kept for the manual "Refresh map" button, and only when you are standing inside that area.
  const nearSame = (a, b, ext) => Math.abs(a.lon - b.lon) < Math.abs(ext[2] - ext[0]) * 0.02 && Math.abs(a.lat - b.lat) < Math.abs(ext[3] - ext[1]) * 0.02;
  let nudging = false;
  async function nudgeMap(why) {
    if (nudging) return;
    nudging = true;
    try {
      const auto = why !== 'button';
      const [c, z, ext] = await Promise.all([sdk.Map.getMapCenter(), sdk.Map.getZoomLevel(), sdk.Map.getMapExtent()]);
      if (auto) {                                      // wait a moment: WME often redraws by itself when the tab comes back
        await sleep(1500);
        let loaded = 0;
        try { loaded = (await sdk.DataModel.Segments.getAll()).length; } catch (e) { /* treat as blank */ }
        if (loaded > 0 && !(await sdk.State.isMapLoading())) return log.info(`no map nudge needed (${why}): ${loaded} segments already loaded`);
      }
      const area = !auto ? areasForKey()[0] : null;
      const inside = !!area && polygonContains([c.lon, c.lat], area.geometry);
      const w = Array.isArray(ext) ? Math.abs(ext[2] - ext[0]) : 0.01;
      const away = inside ? areaCenter(area) : { lon: c.lon + w * 0.3, lat: c.lat };
      await sdk.Map.setMapCenter({ lonLat: away, zoomLevel: auto ? z : Math.max(z, 13) });
      const t0 = Date.now();
      await sleep(500);
      while (Date.now() - t0 < 8000 && await sdk.State.isMapLoading()) await sleep(200);
      const now = await sdk.Map.getMapCenter();         // if you moved the map yourself in the meantime, leave it where you put it
      if (nearSame(now, away, ext)) await sdk.Map.setMapCenter({ lonLat: { lon: c.lon, lat: c.lat }, zoomLevel: z });
      else log.info('map nudge: you moved the map meanwhile, not restoring the old view');
      log.info(`map nudged (${why}) via ${inside ? 'area centre' : 'small local pan'}, ${Date.now() - t0}ms`);
    } catch (e) { log.warn('map nudge failed', e); }
    finally { nudging = false; }
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
    for (const layerName of [LAYER, HALO_LAYER, SCOPE_LAYER, BORDER_LAYER, MP_LAYER, PLACE_LAYER]) { try { await sdk.Map.removeLayer({ layerName }); } catch (e) { /* ignore */ } }
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
      styleRules: [{ style: { pointRadius: 9, fillColor: '#E00', fillOpacity: 0.85, strokeColor: '#ffffff', strokeWidth: 2, title: '${getTip}' } }],
    });
    await sdk.Map.addLayer({
      layerName: PLACE_LAYER,
      styleContext: {
        getColor: ({ feature }) => { const p = (feature && feature.properties) || {}; return p.tag ? '#9e9e9e' : (PALETTE[p.sev] || PALETTE.note); },
        getRadius: ({ feature }) => (feature && feature.properties && feature.properties.cur ? 12 : 8),
        getTip: ({ feature }) => (feature && feature.properties && feature.properties.tip) || '',
      },
      styleRules: [{ style: { pointRadius: '${getRadius}', fillColor: '${getColor}', fillOpacity: 0.9, strokeColor: '#ffffff', strokeWidth: 2, title: '${getTip}' } }],
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
        { style: { strokeColor: PALETTE.note, strokeOpacity: 0.8, strokeWidth: '${getWidth}', strokeLinecap: 'round', fill: false, title: '${getTip}', graphicZIndex: 10 } },
        { predicate: p => p.sev === 'warning', style: { strokeColor: PALETTE.warning, graphicZIndex: 20 } },
        { predicate: p => p.sev === 'error', style: { strokeColor: PALETTE.error, graphicZIndex: 30 } },
      ],
    });
    await placeBelowRoads();
    try {
      await sdk.Map.setLayerOpacity({ layerName: LAYER, opacity: state.layerOpacity });
      if (!state.enabled) for (const layerName of [LAYER, HALO_LAYER, SCOPE_LAYER, BORDER_LAYER, MP_LAYER, PLACE_LAYER]) await sdk.Map.setLayerVisibility({ layerName, visibility: false });
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
    if (state.placesOn) scanPlaces().catch(e => log.warn('place scan', e));

    run = debounce(() => { if (state.sweeping) return; if (state.autoMove) scan().catch(onScanError); else setStatus('Settings changed. Press Scan Now.'); }, 500);
    ['wme-map-data-loaded', 'wme-map-zoom-changed', 'wme-map-move-end'].forEach(n => on(n, run));
    on('wme-after-edit', collectEdited);
    ['wme-after-undo', 'wme-after-redo'].forEach(n => { try { on(n, collectEdited); } catch (e) { log.info(`event ${n} not available`); } });
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
