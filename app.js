/* ============================================================
   GEOMETRY DASH - SPA core (app.js)
   - tunnel failover API (auto X-Token header)
   - session store (IndexedDB 'gd_app', NOT the game's idbfs)
   - UnityPrf parse/serialize (proven in editor.html) -> boot sync
   - game idbfs read/write, smart progress merge
   - local-time / status helpers
   ============================================================ */
(function () {
  'use strict';
  const HEALTH_MS = 4000, REQ_MS = 15000;
  let _cfg = null, _base = '', _token = '';

  /* ---------- fetch with real timeout ---------- */
  function _fetch(url, opts, ms) {
    const ctrl = window.AbortController ? new AbortController() : null;
    const base = Object.assign({ cache: 'no-store' }, opts || {});
    if (ctrl) base.signal = ctrl.signal;
    const t = ctrl ? setTimeout(function () { ctrl.abort(); }, ms || REQ_MS) : null;
    const p = fetch(url, base);
    if (t) p.then(function () { clearTimeout(t); }, function () { clearTimeout(t); });
    return p;
  }

  /* ---------- config + failover ---------- */
  async function loadConfig() {
    const r = await _fetch('config.json?t=' + Date.now(), { method: 'GET' }, HEALTH_MS);
    const cfg = await r.json();
    let urls = Array.isArray(cfg.tunnels) ? cfg.tunnels.filter(Boolean) : [];
    if (!urls.length && cfg.tunnel) urls = [cfg.tunnel];
    const active = (typeof cfg.active === 'number' && cfg.active < urls.length) ? cfg.active : 0;
    const order = [];
    if (urls[active]) order.push(urls[active]);
    urls.forEach(function (u, i) { if (i !== active && u && order.indexOf(u) === -1) order.push(u); });
    _cfg = { urls: urls, active: active, order: order };
    return _cfg;
  }
  async function alive(url) {
    if (!url) return false;
    try { return (await _fetch(url + '/', { method: 'GET' }, HEALTH_MS)).ok; }
    catch (e) { return false; }
  }
  async function pickBase() {
    if (!_cfg) { try { await loadConfig(); } catch (e) { return ''; } }
    // RACE both tunnels in parallel - first healthy one wins (no reliance on "active").
    const order = _base ? [_base].concat(_cfg.order.filter(function (u) { return u !== _base; })) : _cfg.order.slice();
    try {
      const winner = await Promise.any(order.map(async function (u) {
        if (await alive(u)) return u;
        throw new Error('dead');
      }));
      _base = winner; return winner;
    } catch (e) {
      _base = _cfg.order[0] || ''; return _base;   // none answered - try the first anyway
    }
  }
  function setToken(t) { _token = t || ''; }
  async function api(path, opts) {
    if (!_cfg) { try { await loadConfig(); } catch (e) { throw new Error('config unavailable'); } }
    let list = _cfg.order.slice();
    if (_base) list = [_base].concat(list.filter(function (u) { return u !== _base; }));
    opts = opts || {};
    const headers = Object.assign({}, opts.headers || {});
    if (_token) headers['X-Token'] = _token;
    let lastErr;
    for (const u of list) {
      try { const res = await _fetch(u + path, Object.assign({}, opts, { headers: headers }), REQ_MS); _base = u; return res; }
      catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('all tunnels unreachable');
  }

  /* ---------- session kv store (separate DB) ---------- */
  let _kv = null;
  function kvdb() {
    if (_kv) return Promise.resolve(_kv);
    return new Promise(function (res, rej) {
      const r = indexedDB.open('gd_app', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
      r.onsuccess = function () { _kv = r.result; res(_kv); };
      r.onerror = function () { rej(r.error); };
    });
  }
  async function kvGet(k) { const db = await kvdb(); return new Promise(function (res, rej) { const q = db.transaction('kv', 'readonly').objectStore('kv').get(k); q.onsuccess = function () { res(q.result); }; q.onerror = function () { rej(q.error); }; }); }
  async function kvSet(k, v) { const db = await kvdb(); return new Promise(function (res, rej) { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = function () { res(); }; tx.onerror = function () { rej(tx.error); }; }); }
  async function kvDel(k) { const db = await kvdb(); return new Promise(function (res, rej) { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').delete(k); tx.oncomplete = function () { res(); }; tx.onerror = function () { rej(tx.error); }; }); }

  /* ---------- UnityPrf parse/serialize (proven) ---------- */
  const te = new TextEncoder(), td = new TextDecoder();
  const i32 = function (v) { const a = new Uint8Array(4); new DataView(a.buffer).setInt32(0, v | 0, true); return a; };
  const f32 = function (v) { const a = new Uint8Array(4); new DataView(a.buffer).setFloat32(0, Number(v), true); return a; };
  const rdI32 = function (u, o) { return new DataView(u.buffer, u.byteOffset + o, 4).getInt32(0, true); };
  const rdF32 = function (u, o) { return new DataView(u.buffer, u.byteOffset + o, 4).getFloat32(0, true); };
  const cat = function (ps) { let n = 0; for (const p of ps) n += p.length; const o = new Uint8Array(n); let k = 0; for (const p of ps) { o.set(p, k); k += p.length; } return o; };

  function parsePrefs(u) {
    u = u instanceof Uint8Array ? u : new Uint8Array(u);
    if (u.length < 16 || td.decode(u.slice(0, 8)) !== 'UnityPrf') return null;
    let off = 16; const e = [];
    while (off + 2 <= u.length) {
      const start = off, keyLen = u[off++];
      if (keyLen < 1 || keyLen > 60 || off + keyLen > u.length) { off = start; break; }
      const key = td.decode(u.slice(off, off + keyLen)); off += keyLen;
      if (!/^[ -~]+$/.test(key) || off >= u.length) { off = start; break; }
      const type = u[off++]; let value, prefix = null;
      if (type === 0x80) { if (off + 4 > u.length) { off = start; break; } const len = rdI32(u, off); off += 4; if (len < 0 || off + len > u.length) { off = start; break; } let s = off; while (s < off + len && u[s] === 0) s++; prefix = u.slice(off, s); value = td.decode(u.slice(s, off + len)); off += len; }
      else if (type === 0) { if (off + 4 > u.length) { off = start; break; } const len = rdI32(u, off); off += 4; if (len < 0 || off + len > u.length) { off = start; break; } value = td.decode(u.slice(off, off + len)); off += len; }
      else if (type === 1) { if (off + 4 > u.length) { off = start; break; } value = rdF32(u, off); off += 4; }
      else if (type === 2) { if (off + 4 > u.length) { off = start; break; } value = rdI32(u, off); off += 4; }
      else { off = start; break; }
      e.push({ key: key, type: type, value: value, prefix: prefix });
    }
    return { header: u.slice(0, 16), entries: e, tail: u.slice(off) };
  }
  function serializePrefs(p) {
    const parts = [p.header.slice()];
    for (const e of p.entries) {
      const kb = te.encode(e.key); parts.push(new Uint8Array([kb.length]), kb, new Uint8Array([e.type]));
      if (e.type === 0x80) { const sb = te.encode(String(e.value)); const pre = (e.prefix && e.prefix.length) ? e.prefix : new Uint8Array(0); const r = new Uint8Array(pre.length + sb.length); r.set(pre, 0); r.set(sb, pre.length); parts.push(i32(r.length), r); }
      else if (e.type === 0) { const sb = te.encode(String(e.value)); parts.push(i32(sb.length), sb); }
      else if (e.type === 1) parts.push(f32(e.value));
      else if (e.type === 2) parts.push(i32(e.value));
    }
    parts.push(p.tail.slice()); return cat(parts);
  }
  /* turn parsed prefs -> {GAME_DATA,PLAYER_DATA,...} object */
  function prefsToObject(parsed) {
    const o = {};
    for (const e of parsed.entries) {
      if (e.type === 0x80 || e.type === 0) { try { o[e.key] = JSON.parse(e.value); } catch (x) { o[e.key] = e.value; } }
      else o[e.key] = e.value;
    }
    return o;
  }
  /* turn object -> parsed prefs (for serialize) */
  function objectToPrefs(obj, templateParsed) {
    const entries = [];
    for (const e of templateParsed.entries) {
      let val = (obj && Object.prototype.hasOwnProperty.call(obj, e.key)) ? obj[e.key] : e.value;
      if (e.type === 0x80 || e.type === 0) val = (typeof val === 'string') ? val : JSON.stringify(val);
      entries.push({ key: e.key, type: e.type, value: val, prefix: e.prefix });
    }
    return { header: templateParsed.header, entries: entries, tail: templateParsed.tail };
  }

  /* ---------- game idbfs read/write ---------- */
  function openIDB(name) { return new Promise(function (res, rej) { const r = indexedDB.open(name); r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }
  async function readLocalSave() {
    try {
      const db = await openIDB('/idbfs');
      if (!db.objectStoreNames.contains('FILE_DATA')) { db.close(); return null; }
      const tx = db.transaction('FILE_DATA', 'readonly'); const st = tx.objectStore('FILE_DATA');
      const keys = await new Promise(function (r) { const q = st.getAllKeys(); q.onsuccess = function () { r(q.result); }; });
      const pp = (keys || []).filter(function (k) { return typeof k === 'string' && k.indexOf('/PlayerPrefs') >= 0 && k.endsWith('/PlayerPrefs'); });
      let best = null, bestT = 0, bestKey = null;
      for (const k of pp) {
        const en = await new Promise(function (r) { const q = st.get(k); q.onsuccess = function () { r(q.result); }; });
        if (!en || !en.contents) continue;
        const u8 = en.contents instanceof ArrayBuffer ? new Uint8Array(en.contents) : new Uint8Array(en.contents);
        const ts = en.timestamp instanceof Date ? en.timestamp.getTime() : 0;
        if (ts >= bestT) { bestT = ts; best = u8; bestKey = k; }
      }
      db.close();
      if (!best) return null;
      const parsed = parsePrefs(best);
      return parsed ? { key: bestKey, parsed: parsed, bytes: best, obj: prefsToObject(parsed) } : null;
    } catch (e) { return null; }
  }
  async function writeLocalSave(local) {
    if (!local || !local.key || !local.parsed) return;
    const u8 = serializePrefs(objectToPrefs(local.obj, local.parsed));
    const db = await openIDB('/idbfs');
    const tx = db.transaction('FILE_DATA', 'readwrite'); const st = tx.objectStore('FILE_DATA');
    const en = await new Promise(function (r) { const q = st.get(local.key); q.onsuccess = function () { r(q.result); }; });
    const isAB = en.contents instanceof ArrayBuffer;
    const copy = new Uint8Array(u8);
    en.contents = isAB ? copy.buffer : copy; en.timestamp = new Date();
    await new Promise(function (res, rej) { const q = st.put(en, local.key); q.onsuccess = function () { res(); }; q.onerror = function () { rej(q.error); }; });
    db.close();
  }
  async function wipeLocalSave() {
    /* delete every PlayerPrefs entry in the game's idbfs (recovery from a
       stuck/corrupt save). Unity recreates a fresh default on next load. */
    try {
      const db = await openIDB('/idbfs');
      if (!db.objectStoreNames.contains('FILE_DATA')) { db.close(); return; }
      const tx = db.transaction('FILE_DATA', 'readwrite'); const st = tx.objectStore('FILE_DATA');
      const keys = await new Promise(function (r) { const q = st.getAllKeys(); q.onsuccess = function () { r(q.result); }; });
      (keys || []).forEach(function (k) { if (typeof k === 'string' && k.indexOf('/PlayerPrefs') >= 0 && k.endsWith('/PlayerPrefs')) st.delete(k); });
      await new Promise(function (res) { tx.oncomplete = function () { res(); }; tx.onerror = function () { res(); }; });
      db.close();
    } catch (e) {}
  }

  /* ---------- smart merge (monotonic max) + compare ---------- */
  function _max(a, b) { a = a | 0; b = b | 0; return a > b ? a : b; }
  function mergeScores(cloud, local) {
    /* IMPORTANT: base = LOCAL (the device's REAL binary structure, exactly as
       Unity wrote it). We only bump progress numbers up from cloud. This keeps
       the re-serialized save valid for Unity - same reason editor.html is safe. */
    const out = JSON.parse(JSON.stringify(local || {}));
    const ci = cloud || {};
    const cm = {}; (((ci.GAME_DATA || {}).starData) || []).forEach(function (s) { if (s && s.id != null) cm['s' + s.id] = s; });
    (((out.GAME_DATA || {}).starData) || []).forEach(function (s) { if (s && cm['s' + s.id]) s.parameter = _max(s.parameter, cm['s' + s.id].parameter); });
    const cml = {}; (((ci.PLAYER_DATA || {}).leveldatas) || []).forEach(function (l) { if (l && l.id != null) cml['l' + l.id] = l; });
    (((out.PLAYER_DATA || {}).leveldatas) || []).forEach(function (l) { const c = cml['l' + l.id]; if (c) { l.normalMode = _max(l.normalMode, c.normalMode); l.practiceMode = _max(l.practiceMode, c.practiceMode); l.totalAttempt = _max(l.totalAttempt, c.totalAttempt); l.totalJump = _max(l.totalJump, c.totalJump); l.coin = _max(l.coin, c.coin); } });
    return out;
  }
  function applyCloud(cloud, local) {
    /* Overwrite local's progress with cloud's values - used when a DIFFERENT user
       logs in on a shared device. Keeps the real binary structure; does NOT max. */
    const out = JSON.parse(JSON.stringify(local || {}));
    const ci = cloud || {};
    const cm = {}; (((ci.GAME_DATA || {}).starData) || []).forEach(function (s) { if (s && s.id != null) cm['s' + s.id] = s; });
    (((out.GAME_DATA || {}).starData) || []).forEach(function (s) { if (s && cm['s' + s.id]) s.parameter = (cm['s' + s.id].parameter | 0); });
    const cml = {}; (((ci.PLAYER_DATA || {}).leveldatas) || []).forEach(function (l) { if (l && l.id != null) cml['l' + l.id] = l; });
    (((out.PLAYER_DATA || {}).leveldatas) || []).forEach(function (l) { const c = cml['l' + l.id]; if (c) { l.normalMode = (c.normalMode | 0); l.practiceMode = (c.practiceMode | 0); l.totalAttempt = (c.totalAttempt | 0); l.totalJump = (c.totalJump | 0); l.coin = (c.coin | 0); } });
    return out;
  }

  function scoresEmpty(s) {
    if (!s) return true;
    const st = ((s.GAME_DATA || {}).starData) || [];
    for (const x of st) if ((x.parameter | 0) > 0) return false;
    const lv = ((s.PLAYER_DATA || {}).leveldatas) || [];
    for (const x of lv) if ((x.normalMode | 0) > 0 || (x.totalAttempt | 0) > 0) return false;
    return true;
  }
  function canon(s) { try { return JSON.stringify(s); } catch (e) { return ''; } }

  /* ---------- time / status ---------- */
  function lastSeenText(ts) {
    if (!ts) return 'last seen long ago';
    const d = new Date(ts * 1000);
    const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const dd = d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
    return 'last seen ' + t + ', ' + dd;
  }
  function statusText(st) { return st === 'online' ? 'Online' : st === 'playing' ? 'Playing' : 'Offline'; }

  /* ---------- count up ---------- */
  function animateCount(el, target, dur) {
    if (!el) return; dur = dur || 850; const start = performance.now();
    function tick(now) { const p = Math.min(1, (now - start) / dur); const e = 1 - Math.pow(1 - p, 3); el.textContent = Math.round(target * e).toLocaleString(); if (p < 1) requestAnimationFrame(tick); }
    requestAnimationFrame(tick);
  }


  /* ---- pre-create the save at Unity's known idbfs path -> no first-load reload ---- */
  const PREFS_PATH = "/idbfs/3bcbdf0573af57d57445aaa2ae7dc45d/PlayerPrefs";
  const DEFAULT_SCORES = {"ACHIEVEMENT_DATA":{"achievements":[{"id":"level01a","game":"gd","name":"Stereo Bump","rewardType":"color1","rewardID":4,"description":"Complete Stereo Madness in Practice mode","progress":0,"icon":"chamberOfTime"},{"id":"level01b","game":"gd","name":"Stereo Madness!","rewardType":"icon","rewardID":5,"description":"Complete Stereo Madness in Normal mode","progress":0,"icon":"diamonds"},{"id":"level02a","game":"gd","name":"On my way","rewardType":"color1","rewardID":5,"description":"Complete Back On Track in Practice mode","progress":0,"icon":"vaultOfSecrets"},{"id":"level02b","game":"gd","name":"Back On Track!","rewardType":"icon","rewardID":6,"description":"Complete Back On Track in Normal mode","progress":0,"icon":"shardFire"},{"id":"level03a","game":"gd","name":"Polarbear","rewardType":"color1","rewardID":6,"description":"Complete Polargeist in Practice mode","progress":0,"icon":"rating"},{"id":"level03b","game":"gd","name":"Polargeist!","rewardType":"icon","rewardID":7,"description":"Complete Polargeist in Normal mode","progress":0,"icon":"shardFire"},{"id":"level04a","game":"gd","name":"Dehydrated","rewardType":"color1","rewardID":7,"description":"Complete Dry Out in Practice mode","progress":0,"icon":"demons"},{"id":"level04b","game":"gd","name":"Dry Out!","rewardType":"icon","rewardID":8,"description":"Complete Dry Out in Normal mode","progress":0,"icon":"shardFire"},{"id":"level05a","game":"gd","name":"All your base...","rewardType":"color1","rewardID":8,"description":"Complete Base After Base in Practice mode","progress":0,"icon":"vaultOfSecrets"},{"id":"level05b","game":"gd","name":"Base After Base!","rewardType":"icon","rewardID":9,"description":"Complete Base After Base in Normal mode","progress":0,"icon":"shardLava"},{"id":"level06a","game":"gd","name":"Hold on","rewardType":"color1","rewardID":9,"description":"Complete Cant Let Go in Practice mode","progress":0,"icon":"chamberOfTime"},{"id":"level06b","game":"gd","name":"Cant Let Go!","rewardType":"icon","rewardID":10,"description":"Complete Cant Let Go in Normal mode","progress":0,"icon":"shardShadow"},{"id":"level07a","game":"gd","name":"Hop Hop...","rewardType":"color1","rewardID":10,"description":"Complete Jumper in Practice mode","progress":0,"icon":"shardFire"},{"id":"level07b","game":"gd","name":"Jumper!","rewardType":"icon","rewardID":11,"description":"Complete Jumper in Normal mode","progress":0,"icon":"shardFire"},{"id":"level08a","game":"gd","name":"Tick Tock","rewardType":"color1","rewardID":12,"description":"Complete Time Machine in Practice mode","progress":0,"icon":"diamonds"},{"id":"level08b","game":"gd","name":"Time Machine!","rewardType":"icon","rewardID":14,"description":"Complete Time Machine in Normal mode","progress":0,"icon":"shardFire"},{"id":"level09a","game":"gd","name":"Loops","rewardType":"icon","rewardID":15,"description":"Complete Cycles in Practice mode","progress":0,"icon":"shardFire"},{"id":"level09b","game":"gd","name":"Cycles!","rewardType":"icon","rewardID":16,"description":"Complete Cycles in Normal mode","progress":0,"icon":"stars"},{"id":"level10a","game":"gd","name":"yStep","rewardType":"icon","rewardID":17,"description":"Complete xStep in Practice mode","progress":0,"icon":"shardFire"},{"id":"level10b","game":"gd","name":"xStep!","rewardType":"icon","rewardID":18,"description":"Complete xStep in Normal mode","progress":0,"icon":"diamonds"},{"id":"level11a","game":"gd","name":"Funky","rewardType":"color1","rewardID":13,"description":"Complete Clutterfunk in Practice mode","progress":0,"icon":"shardFire"},{"id":"level11b","game":"gd","name":"Clutterfunk!","rewardType":"ship","rewardID":2,"description":"Complete Clutterfunk in Normal mode","progress":0,"icon":"social"},{"id":"level12a","game":"gd","name":"Theory of Something","rewardType":"color1","rewardID":14,"description":"Complete Theory of Everything in Practice mode","progress":0,"icon":"shardFire"},{"id":"level12b","game":"gd","name":"Theory of Everything!","rewardType":"icon","rewardID":27,"description":"Complete Theory of Everything in Normal mode","progress":0,"icon":"stars"},{"id":"level13a","game":"gd","name":"Electro Time","rewardType":"color1","rewardID":16,"description":"Complete Electroman Adventures in Practice mode","progress":0,"icon":"shardFire"},{"id":"level13b","game":"gd","name":"Electroman Adventures!","rewardType":"ship","rewardID":9,"description":"Complete Electroman Adventures in Normal mode","progress":0,"icon":"shardFire"},{"id":"level14a","game":"gd","name":"Clubbin","rewardType":"ufo","rewardID":2,"description":"Complete Clubstep in Practice mode","progress":0,"icon":"shardFire"},{"id":"level14b","game":"gd","name":"Clubstep!","rewardType":"color2","rewardID":15,"description":"Complete Clubstep in Normal mode","progress":0,"icon":"shardFire"},{"id":"level15a","game":"gd","name":"Electromaniac","rewardType":"color1","rewardID":17,"description":"Complete Electrodynamix in Practice mode","progress":0,"icon":"shardFire"},{"id":"level15b","game":"gd","name":"Electrodynamix!","rewardType":"icon","rewardID":35,"description":"Complete Electrodynamix in Normal mode","progress":0,"icon":"social"},{"id":"coins01","game":"gd","name":"Coins?!","rewardType":"icon","rewardID":31,"description":"Collect 5 Secret Coins","progress":0,"icon":"shardFire"},{"id":"coins02","game":"gd","name":"Maybe behind that block?","rewardType":"ball","rewardID":2,"description":"Collect 10 Secret Coins","progress":0,"icon":"stars"},{"id":"coins03","game":"gd","name":"I.. Need... MORE!","rewardType":"color2","rewardID":16,"description":"Collect 15 Secret Coins","progress":0,"icon":"jumps"},{"id":"coins04","game":"gd","name":"We wants it!","rewardType":"ufo","rewardID":3,"description":"Collect 20 Secret Coins","progress":0,"icon":"shardFire"},{"id":"coins05","game":"gd","name":"We needs it!","rewardType":"icon","rewardID":32,"description":"Collect 25 Secret Coins","progress":0,"icon":"robtop"},{"id":"coins06","game":"gd","name":"Must have the precious","rewardType":"color1","rewardID":15,"description":"Collect 30 Secret Coins","progress":0,"icon":"shardFire"},{"id":"coins07","game":"gd","name":"They stole it from us!","rewardType":"ball","rewardID":3,"description":"Collect 35 Secret Coins","progress":0,"icon":"shardFire"},{"id":"coins08","game":"gd","name":"Where is it?! Where is it?!","rewardType":"icon","rewardID":34,"description":"Collect 40 Secret Coins","progress":0,"icon":"jumps"},{"id":"coins09","game":"gd","name":"Thief, thief, thief!","rewardType":"ufo","rewardID":4,"description":"Collect 45 Secret Coins","progress":0,"icon":"shardFire"},{"id":"rating","game":"gd","name":"Supporter","rewardType":"icon","rewardID":13,"description":"Have fun :)","progress":0,"icon":"demons"},{"id":"jump01","game":"gd","name":"Bounce","rewardType":"color2","rewardID":5,"description":"Jump 1000 times","progress":0,"icon":"shardFire"},{"id":"jump02","game":"gd","name":"I like jumping","rewardType":"color2","rewardID":11,"description":"Jump 10000 times","progress":0,"icon":"shardShadow"},{"id":"jump03","game":"gd","name":"You jump like a pro!","rewardType":"color2","rewardID":12,"description":"Jump 20000 times","progress":0,"icon":"shardFire"},{"id":"jump04","game":"gd","name":"Hop Hop Hop","rewardType":"ufo","rewardID":5,"description":"Jump 50000 times","progress":0,"icon":"shardLava"},{"id":"jump05","game":"gd","name":"Can't stop jumping!!!","rewardType":"ball","rewardID":13,"description":"Jump 100000 times","progress":0,"icon":"robtop"},{"id":"attempt01","game":"gd","name":"Trial and error","rewardType":"color2","rewardID":6,"description":"Do 100 attempts","progress":0,"icon":"level"},{"id":"attempt02","game":"gd","name":"Crash Tester","rewardType":"color2","rewardID":7,"description":"Do 500 attempts","progress":0,"icon":"shardFire"},{"id":"attempt03","game":"gd","name":"You Shall Not Pass!","rewardType":"color2","rewardID":14,"description":"Do 2000 attempts","progress":0,"icon":"shardFire"},{"id":"attempt04","game":"gd","name":"Ouch...","rewardType":"color2","rewardID":17,"description":"Do 10000 attempts","progress":0,"icon":"demons"},{"id":"attempt05","game":"gd","name":"That hurts!","rewardType":"wave","rewardID":3,"description":"Do 20000 attempts","progress":0,"icon":"shardFire"},{"id":"moreGames","game":"gd","name":"RobTop Gamer","rewardType":"color2","rewardID":4,"description":"Tap the More Games button!","progress":0,"icon":"robtop"},{"id":"facebook","game":"gd","name":"Number one fan!","rewardType":"color2","rewardID":13,"description":"Like Geometry Dash on Facebook","progress":0,"icon":"level"},{"id":"youtube","game":"gd","name":"GeometryTube","rewardType":"color2","rewardID":20,"description":"Subscribe to RobTop Games on YouTube","progress":0,"icon":"shardFire"},{"id":"special01","game":"gd","name":"So close","rewardType":"color2","rewardID":18,"description":"Crash at over 95% on a main level in normal mode","progress":0,"icon":"shardFire"},{"id":"secret01","game":"gd","name":"Rampage!","rewardType":"color2","rewardID":19,"description":"A secret is required","progress":0,"icon":"shardFire"},{"id":"secret02","game":"gd","name":"Dominating!","rewardType":"icon","rewardID":41,"description":"A secret is required","progress":0,"icon":"shardBonus"},{"id":"secret02b","game":"gd","name":"Ultrakill!","rewardType":"color2","rewardID":27,"description":"A secret is required","progress":0,"icon":"rating"},{"id":"secret03","game":"gd","name":"Godlike!","rewardType":"icon","rewardID":39,"description":"A secret is required","progress":0,"icon":"shardFire"},{"id":"secret04","game":"gd","name":"Master Detective","rewardType":"color2","rewardID":21,"description":"Found the hidden coin","progress":0,"icon":"shardShadow"},{"id":"secret11","game":"gd","name":"Catch them all!","rewardType":"icon","rewardID":55,"description":"A secret is required","progress":0,"icon":"shardBonus"}],"genDefault":true},"CHARACTER":{"genDefault":true,"isGlow":false,"_characters":[{"name":"icon","id":0,"length":148,"unlockCount":4,"currentId":0,"isCharacter":true},{"name":"ship","id":1,"length":51,"unlockCount":1,"currentId":0,"isCharacter":true},{"name":"ball","id":2,"length":43,"unlockCount":1,"currentId":0,"isCharacter":true},{"name":"ufo","id":3,"length":35,"unlockCount":1,"currentId":0,"isCharacter":true},{"name":"wave","id":4,"length":35,"unlockCount":1,"currentId":0,"isCharacter":true},{"name":"Robot","id":5,"length":26,"unlockCount":1,"currentId":0,"isCharacter":true},{"name":"Spider","id":6,"length":17,"unlockCount":1,"currentId":0,"isCharacter":true},{"name":"streak","id":7,"length":7,"unlockCount":1,"currentId":0,"isCharacter":false},{"name":"explosion","id":8,"length":20,"unlockCount":1,"currentId":0,"isCharacter":false}],"currentColor1":0,"currentColor2":1,"glow":102,"unlock":[0,1,2,3,102]},"GAME_DATA":{"genDefault":true,"version":0.10000000149011612,"starData":[{"id":0,"name":"Total Jump","parameter":0},{"id":1,"name":"Total Attempts","parameter":0},{"id":2,"name":"Collected Stars","parameter":0},{"id":3,"name":"Collected Diamonds","parameter":0},{"id":4,"name":"Total Orbs Collected","parameter":0},{"id":5,"name":"Complete Levels","parameter":0},{"id":6,"name":"Completed Online Levels","parameter":0},{"id":7,"name":"Completed Demon Levels","parameter":0},{"id":8,"name":"Completed Daily Levels","parameter":0},{"id":9,"name":"Completed Secret Coints","parameter":0},{"id":10,"name":"Completed User Coins","parameter":0},{"id":11,"name":"Complete Map Pack","parameter":0},{"id":12,"name":"Link/Disliked Levels","parameter":0},{"id":13,"name":"Rated Levels","parameter":0}]},"PLAYER_DATA":{"leveldatas":[{"id":0,"name":"Stereo Madness","color":"#0000FF","difficulty":"Easy","unlock":true,"comingSoon":false,"totalAttempt":0,"totalJump":0,"normalMode":0,"practiceMode":0,"description":"Complete Stereo Madness in Normal mode","coin":0},{"id":1,"name":"Back On Track","color":"#FF00FF","difficulty":"Easy","unlock":true,"comingSoon":false,"totalAttempt":0,"totalJump":0,"normalMode":0,"practiceMode":0,"description":"Complete Back On Track in Normal mode","coin":0},{"id":2,"name":"Polargeist","color":"#FF007B","difficulty":"Normal","unlock":true,"comingSoon":false,"totalAttempt":0,"totalJump":0,"normalMode":0,"practiceMode":0,"description":"Complete Polargeist in Normal mode","coin":0},{"id":3,"name":"Dry Out","color":"#FF0000","difficulty":"Normal","unlock":true,"comingSoon":false,"totalAttempt":0,"totalJump":0,"normalMode":0,"practiceMode":0,"description":"Complete Dry Out in Normal mode","coin":0},{"id":4,"name":"Base After Base","color":"#FF7900","difficulty":"Hard","unlock":true,"comingSoon":false,"totalAttempt":0,"totalJump":0,"normalMode":0,"practiceMode":0,"description":"Complete Base After Base in Normal mode","coin":0},{"id":5,"name":"Cant Let Go","color":"#FFFB00","difficulty":"Hard","unlock":true,"comingSoon":false,"totalAttempt":0,"totalJump":0,"normalMode":0,"practiceMode":0,"description":"Complete Cant Let Go in Normal mode","coin":0},{"id":6,"name":"Jumper","color":"#00FB00","difficulty":"Harder","unlock":true,"comingSoon":false,"totalAttempt":0,"totalJump":0,"normalMode":0,"practiceMode":0,"description":"Complete Jumper in Normal mode","coin":0},{"id":7,"name":"Time Machine","color":"#00FBFF","difficulty":"Harder","unlock":true,"comingSoon":false,"totalAttempt":0,"totalJump":0,"normalMode":0,"practiceMode":0,"description":"Complete Time Machine in Normal mode","coin":0},{"id":8,"name":"Cycles","color":"#0079FF","difficulty":"Harder","unlock":true,"comingSoon":false,"totalAttempt":0,"totalJump":0,"normalMode":0,"practiceMode":0,"description":"Complete Cycles in Normal mode","coin":0},{"id":9,"name":"xStep","color":"#0000FF","difficulty":"Insane","unlock":true,"comingSoon":false,"totalAttempt":0,"totalJump":0,"normalMode":0,"practiceMode":0,"description":"Complete xStep in Normal mode","coin":0},{"id":10,"name":"Clutterfunk","color":"#94ffe7","difficulty":"Insane","unlock":true,"comingSoon":false,"totalAttempt":0,"totalJump":0,"normalMode":0,"practiceMode":0,"description":"Complete Clutterfunk in Normal mode","coin":0},{"id":11,"name":"Theory of Everything","color":"#fd00fd","difficulty":"Insane","unlock":true,"comingSoon":false,"totalAttempt":0,"totalJump":0,"normalMode":0,"practiceMode":0,"description":"Complete Theory of Everything in Normal mode","coin":0},{"id":12,"name":"Electroman Adventures","color":"#fc007c","difficulty":"Insane","unlock":true,"comingSoon":false,"totalAttempt":0,"totalJump":0,"normalMode":0,"practiceMode":0,"description":"Complete Electroman Adventures in Normal mode","coin":0},{"id":13,"name":"Clubstep","color":"#fb0000","difficulty":"Demon","unlock":true,"comingSoon":false,"totalAttempt":0,"totalJump":0,"normalMode":0,"practiceMode":0,"description":"Complete Clubstep in Normal mode","coin":0},{"id":14,"name":"Electrodynamix","color":"#fd7c00","difficulty":"Demon","unlock":true,"comingSoon":false,"totalAttempt":0,"totalJump":0,"normalMode":0,"practiceMode":0,"description":"Complete Electrodynamix in Normal mode","coin":0},{"id":15,"name":"Coming Soon","color":"#fff3c4","difficulty":"lock","unlock":false,"comingSoon":true,"totalAttempt":0,"totalJump":0,"normalMode":0,"practiceMode":0,"description":"Coming Soon","coin":0}],"genDefault":true,"currentLevel":0},"SETTING_DATA":{"options":[{"id":0,"name":"Auto_Retry","onBtn":false,"info":"","on":true},{"id":1,"name":"Auto_Checkpoints","onBtn":true,"info":"Automatically place checkpoints while in practice","on":true},{"id":2,"name":"Load songs to memory","onBtn":true,"info":"Songs are loaded into memory before playing. Increases load time but can impreove performance.","on":false},{"id":3,"name":"High capacity mode","onBtn":true,"info":"Increases draw capacity for batch nodes at level start. Use to improve performance on some levels. May cause issues on low end devices.","on":false},{"id":4,"name":"Quich checkpoint mode","onBtn":true,"info":"Tries to place checkpoints more often while in practice mode.","on":false},{"id":5,"name":"Show restart button","onBtn":true,"info":"Always shows the restart button on the pause screen.","on":false},{"id":6,"name":"Fast editor preview","onBtn":true,"info":"Updates the editer preview from playback at 60fps instead of 20fps. More performance heavy but can be good to preview mode precise effects of song triggers.","on":false},{"id":7,"name":"Smooth Fix","onBtn":true,"info":"Makes some optizations that can reduce lag. Disable fi game speed becomes inconsistent.","on":false},{"id":8,"name":"Auto low detail","onBtn":true,"info":"Low detail mode is automatically enabled on levels thet support it.","on":false},{"id":8,"name":"Disable explosion shake","onBtn":false,"info":"","on":false}],"music":1,"sfx":1,"progressBar":true,"genDefault":true,"autoCheckPoint":false}};
  function buildBinaryFromObject(obj){
    const header = new Uint8Array(16); header.set(te.encode("UnityPrf"), 0); /* "UnityPrf" + 8 zeros */
    const entries = Object.keys(obj).sort().map(function(k){ return {key:k, type:0x80, value: JSON.stringify(obj[k]), prefix: new Uint8Array(0)}; });
    return serializePrefs({header:header, entries:entries, tail:new Uint8Array(0)});
  }
  async function idbPutNode(path, node){
    const db = await openIDB('/idbfs');
    if (!db.objectStoreNames.contains('FILE_DATA')) { db.close(); return; }
    await new Promise(function(res, rej){ const tx = db.transaction('FILE_DATA','readwrite'); tx.objectStore('FILE_DATA').put(node, path); tx.oncomplete = function(){ res(); }; tx.onerror = function(){ rej(tx.error); }; });
    db.close();
  }
  async function writePrefsAtPath(fullPath, u8){
    /* Create the idbfs directory entries + write a PlayerPrefs file at fullPath. */
    const parts = fullPath.split('/').filter(Boolean); let cur = '';
    for (let i = 0; i < parts.length - 1; i++) { cur += '/' + parts[i]; await idbPutNode(cur, {timestamp:new Date(), mode:0o040777, contents:null}); }
    await idbPutNode(fullPath, {timestamp:new Date(), mode:0o100666, contents: new Uint8Array(u8)});
  }
  async function ensureLocal(){
    /* Fresh device: write a cloud-merged save to Unity's PlayerPrefs path BEFORE it
       loads, so the player sees their progress on the very first load (no reload).
       Returning devices (already have a save) are left untouched. */
    try {
      if (await readLocalSave()) return false;          /* already have a save */
      const r = await api('/api/session', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({status:'online'}) });
      const cloud = (await r.json()).scores;
      const base = JSON.parse(JSON.stringify(DEFAULT_SCORES));
      const merged = cloud ? mergeScores(cloud, base) : base;
      let u8;
      try { u8 = buildBinaryFromObject(merged); if (canon(prefsToObject(parsePrefs(u8))) !== canon(merged)) return false; }
      catch (e) { return false; }
      await writePrefsAtPath(PREFS_PATH, u8);
      return true;
    } catch (e) { return false; }
  }

  window.GD = {
    loadConfig: loadConfig, alive: alive, pickBase: pickBase, api: api, setToken: setToken,
    kvGet: kvGet, kvSet: kvSet, kvDel: kvDel,
    parsePrefs: parsePrefs, serializePrefs: serializePrefs,
    readLocalSave: readLocalSave, writeLocalSave: writeLocalSave, wipeLocalSave: wipeLocalSave,
    mergeScores: mergeScores, scoresEmpty: scoresEmpty, canon: canon, applyCloud: applyCloud,
    ensureLocal: ensureLocal, buildBinaryFromObject: buildBinaryFromObject, writePrefsAtPath: writePrefsAtPath, DEFAULT_SCORES: DEFAULT_SCORES, PREFS_PATH: PREFS_PATH,
    prefsToObject: prefsToObject, objectToPrefs: objectToPrefs,
    lastSeenText: lastSeenText, statusText: statusText, animateCount: animateCount
  };
})();
